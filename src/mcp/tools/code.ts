import {
  CodeNeedWindowRequestSchema,
  CodeNeedWindowResponse,
  GetSkeletonRequestSchema,
  GetSkeletonResponse,
  GetHotPathRequestSchema,
  GetHotPathResponse,
} from "../tools.js";
import {
  DEFAULT_MAX_LINES_HOTPATH,
  DEFAULT_MAX_TOKENS_HOTPATH,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
} from "../../config/constants.js";
import { evaluateRequest, GateContext } from "../../code/gate.js";
import { extractWindow, identifiersExistInWindow } from "../../code/windows.js";
import {
  buildRedactionPatterns,
  redactSecrets,
  shouldRedactFile,
} from "../../code/redact.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { logCodeWindowDecision, logPolicyDecision } from "../telemetry.js";
import { safeJsonParseOrThrow, ConfigObjectSchema } from "../../util/safeJson.js";
import { attachRawContext } from "../token-usage.js";
import type {
  NextBestAction,
  NextBestActionCallable,
  Range,
  RequiredFieldsForNext,
} from "../types.js";
import { NotFoundError, ValidationError, IndexError } from "../errors.js";
import { PolicyConfigSchema } from "../../config/types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { buildSlice } from "../../graph/slice.js";
import { getAbsolutePathFromRepoRoot } from "../../util/paths.js";
import {
  generateSymbolSkeleton,
  generateFileSkeleton,
} from "../../code/skeleton.js";
import { extractHotPath } from "../../code/hotpath.js";
import {
  PolicyEngine,
  type PolicyRequestContext,
} from "../../policy/engine.js";
import { consumePrefetchedKey } from "../../graph/prefetch.js";
import { recordToolTrace } from "../../graph/prefetch-model.js";
import { toLegacySymbolRow } from "./symbol-utils.js";
import type { CodeNeedWindowRequest } from "../tools.js";

function buildPolicyNextBestAction(params: {
  request: CodeNeedWindowRequest;
  policyNextBestAction?: NextBestAction;
  requiredFieldsForNext?: RequiredFieldsForNext;
  deniedReasons?: string[];
  fallback?: NextBestActionCallable;
}): NextBestActionCallable | undefined {
  const {
    request,
    policyNextBestAction,
    requiredFieldsForNext,
    deniedReasons,
    fallback,
  } = params;

  const rationale =
    deniedReasons?.join("; ") ?? fallback?.rationale ?? "Policy denied request";

  switch (policyNextBestAction) {
    case "requestSkeleton":
      return {
        tool: "sdl.code.getSkeleton",
        args: {
          repoId:
            requiredFieldsForNext?.requestSkeleton?.repoId ?? request.repoId,
          symbolId:
            requiredFieldsForNext?.requestSkeleton?.symbolId ??
            request.symbolId,
          ...(request.identifiersToFind.length > 0
            ? { identifiersToFind: request.identifiersToFind }
            : {}),
        },
        rationale,
      };
    case "requestHotPath": {
      const identifiersToFind =
        requiredFieldsForNext?.requestHotPath?.identifiersToFind ??
        request.identifiersToFind;
      // getHotPath requires minItems:1; fall back rather than emit an invalid call.
      if (identifiersToFind.length === 0) {
        return fallback;
      }
      return {
        tool: "sdl.code.getHotPath",
        args: {
          repoId:
            requiredFieldsForNext?.requestHotPath?.repoId ?? request.repoId,
          symbolId:
            requiredFieldsForNext?.requestHotPath?.symbolId ?? request.symbolId,
          identifiersToFind,
          ...(requiredFieldsForNext?.requestHotPath?.maxTokens
            ? { maxTokens: requiredFieldsForNext.requestHotPath.maxTokens }
            : {}),
        },
        rationale,
      };
    }
    case "requestRaw":
      return {
        tool: "sdl.code.needWindow",
        args: {
          repoId: requiredFieldsForNext?.requestRaw?.repoId ?? request.repoId,
          symbolId:
            requiredFieldsForNext?.requestRaw?.symbolId ?? request.symbolId,
          reason: requiredFieldsForNext?.requestRaw?.reason ?? request.reason,
          expectedLines:
            requiredFieldsForNext?.requestRaw?.expectedLines ??
            request.expectedLines,
          identifiersToFind:
            requiredFieldsForNext?.requestRaw?.identifiersToFind ??
            request.identifiersToFind,
          ...(requiredFieldsForNext?.requestRaw?.granularity
            ? { granularity: requiredFieldsForNext.requestRaw.granularity }
            : {}),
          ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
        },
        rationale,
      };
    case "provideIdentifiersToFind": {
      const examples =
        requiredFieldsForNext?.provideIdentifiersToFind?.examples?.filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        ) ?? [];

      if (examples.length === 0) {
        return fallback;
      }

      return {
        tool: "sdl.code.getHotPath",
        args: {
          repoId: request.repoId,
          symbolId: request.symbolId,
          identifiersToFind: examples,
        },
        rationale,
      };
    }
    case "narrowScope":
      if (request.identifiersToFind.length > 0) {
        return {
          tool: "sdl.code.getHotPath",
          args: {
            repoId: request.repoId,
            symbolId: request.symbolId,
            identifiersToFind: request.identifiersToFind,
          },
          rationale: requiredFieldsForNext?.narrowScope?.reason ?? rationale,
        };
      }
      return {
        tool: "sdl.code.getSkeleton",
        args: {
          repoId: request.repoId,
          symbolId: request.symbolId,
        },
        rationale: requiredFieldsForNext?.narrowScope?.reason ?? rationale,
      };
    case "retryWithSameInputs":
      // Forward all original request fields (including sliceContext if present),
      // unlike "requestRaw" which rebuilds args selectively from requiredFieldsForNext.
      return {
        tool: "sdl.code.needWindow",
        args: {
          ...request,
        },
        rationale,
      };
    default:
      return fallback;
  }
}

/**
 * Handles code window requests with policy evaluation.
 * Returns full code, skeleton, or hot-path based on policy decisions.
 * Supports ETag-like caching via slice context and optional redaction.
 *
 * @param args - Raw arguments containing symbolId, repoId, and window parameters
 * @returns Code window response with approval status and code data
 * @throws {Error} If symbol, file, or repository not found
 */
export async function handleCodeNeedWindow(
  args: unknown,
): Promise<CodeNeedWindowResponse> {
  const request = CodeNeedWindowRequestSchema.parse(args);

  recordToolTrace({
    repoId: request.repoId,
    taskType: "code",
    tool: "code.needWindow",
    symbolId: request.symbolId,
  });
  consumePrefetchedKey(request.repoId, `card:${request.symbolId}`);

  const conn = await getLadybugConn();

  const symbol = await ladybugDb.getSymbol(conn, request.symbolId);
  if (!symbol) {
    throw new NotFoundError(`Symbol not found: ${request.symbolId}`);
  }

  if (symbol.repoId !== request.repoId) {
    throw new ValidationError(
      `Symbol ${request.symbolId} belongs to repo "${symbol.repoId}", not "${request.repoId}"`,
    );
  }

  const files = await ladybugDb.getFilesByIds(conn, [symbol.fileId]);
  const file = files.get(symbol.fileId);
  if (!file) {
    throw new NotFoundError(`File not found for symbol: ${request.symbolId}`);
  }

  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new NotFoundError(`Repository not found: ${request.repoId}`);
  }

  const legacySymbol = toLegacySymbolRow(symbol);

  const symbolRange: Range = {
    startLine: symbol.rangeStartLine,
    startCol: symbol.rangeStartCol,
    endLine: symbol.rangeEndLine,
    endCol: symbol.rangeEndCol,
  };

  const repoConfig = safeJsonParseOrThrow(repo.configJson, ConfigObjectSchema, `configJson for repository ${request.repoId}`);
  const appConfig = loadConfig();
  const validatedPolicy = PolicyConfigSchema.parse({
    ...appConfig.policy,
    ...(repoConfig.policy ?? {}),
  });
  const sliceBudgetDefaults = {
    maxCards: appConfig.slice?.defaultMaxCards ?? DEFAULT_MAX_CARDS,
    maxEstimatedTokens:
      appConfig.slice?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS_SLICE,
  };
  const policyEngine = new PolicyEngine({
    maxWindowLines: validatedPolicy.maxWindowLines,
    maxWindowTokens: validatedPolicy.maxWindowTokens,
    requireIdentifiers: validatedPolicy.requireIdentifiers,
    allowBreakGlass: validatedPolicy.allowBreakGlass,
    budgetCaps: sliceBudgetDefaults,
  });

  const context: GateContext = {
    symbol: legacySymbol,
    policy: validatedPolicy,
  };

  if (request.sliceContext) {
    const latestVersion = await ladybugDb.getLatestVersion(
      conn,
      request.repoId,
    );
    if (latestVersion) {
      const slice = await buildSlice({
        repoId: request.repoId,
        versionId: latestVersion.versionId,
        ...request.sliceContext,
      });
      context.slice = slice;
    }
  }

  const gateResult = await evaluateRequest(request, context);
  const suggestedNextRequest = !gateResult.approved
    ? gateResult.suggestedNextRequest
    : undefined;
  const gateNextBestAction = !gateResult.approved
    ? gateResult.nextBestAction
    : undefined;

  const policyContext: PolicyRequestContext = {
    requestType: "codeWindow",
    repoId: request.repoId,
    symbolId: request.symbolId,
    maxWindowLines: request.expectedLines,
    maxWindowTokens: request.maxTokens,
    identifiersToFind: request.identifiersToFind,
    reason: request.reason,
    sliceContext: context.slice,
    symbolData: legacySymbol,
  };

  const policyDecision = policyEngine.evaluate(policyContext);
  const { nextBestAction: policyNextBestAction, requiredFieldsForNext } =
    policyEngine.generateNextBestAction(policyDecision, policyContext);
  const policyAction = buildPolicyNextBestAction({
    request,
    policyNextBestAction,
    requiredFieldsForNext,
    deniedReasons: policyDecision.deniedReasons,
    fallback: gateNextBestAction,
  });

  logPolicyDecision({
    requestType: policyContext.requestType,
    repoId: policyContext.repoId,
    symbolId: policyContext.symbolId,
    decision: policyDecision.decision,
    auditHash: policyDecision.auditHash,
    evidenceUsed: policyDecision.evidenceUsed,
    deniedReasons: policyDecision.deniedReasons,
    nextBestAction: policyNextBestAction,
    requiredFieldsForNext,
    downgradeTarget: policyDecision.downgradeTarget,
    context: policyContext,
  });

  if (policyDecision.decision === "deny") {
    logCodeWindowDecision({
      symbolId: request.symbolId,
      approved: false,
      reason: policyDecision.deniedReasons ?? ["Policy denied request"],
    });

    return {
      approved: false,
      whyDenied: policyDecision.deniedReasons ?? ["Policy denied request"],
      suggestedNextRequest,
      nextBestAction: policyAction,
    };
  }

  if (policyDecision.decision === "downgrade-to-skeleton") {
    const skeletonResult = await generateSymbolSkeleton(
      request.repoId,
      request.symbolId,
      {
        maxLines: request.expectedLines,
        maxTokens: request.maxTokens,
        includeIdentifiers: request.identifiersToFind,
      },
    );

    if (!skeletonResult) {
      throw new IndexError(
        `Failed to generate skeleton for symbol: ${request.symbolId}`,
      );
    }

    logCodeWindowDecision({
      symbolId: request.symbolId,
      approved: true,
      reason: [
        "Policy approved (downgraded to skeleton)",
        ...(policyDecision.deniedReasons ?? []),
      ],
    });

    const skeletonTruncation = skeletonResult.truncated
      ? {
          truncated: true,
          droppedCount:
            skeletonResult.originalLines -
            skeletonResult.skeleton.split("\n").length,
          howToResume: {
            type: "cursor" as const,
            value: skeletonResult.actualRange.endLine,
          },
        }
      : undefined;

    const response: CodeNeedWindowResponse = {
      approved: true,
      symbolId: request.symbolId,
      file: file.relPath,
      range: skeletonResult.actualRange,
      code: skeletonResult.skeleton,
      whyApproved: ["Policy approved (downgraded to skeleton)"],
      estimatedTokens: skeletonResult.estimatedTokens,
      downgradedFrom: "raw-code",
      truncation: skeletonTruncation,
    };

    return attachRawContext(response, { fileIds: [symbol.fileId] });
  }

  if (policyDecision.decision === "downgrade-to-hotpath") {
    const hotpathResult = await extractHotPath(
      request.repoId,
      request.symbolId,
      request.identifiersToFind ?? [],
      {
        maxLines: request.expectedLines,
        maxTokens: request.maxTokens,
      },
    );

    if (!hotpathResult) {
      throw new IndexError(
        `Failed to extract hot-path for symbol: ${request.symbolId}`,
      );
    }

    logCodeWindowDecision({
      symbolId: request.symbolId,
      approved: true,
      reason: [
        "Policy approved (downgraded to hotpath)",
        ...(policyDecision.deniedReasons ?? []),
      ],
    });

    const hotpathTruncation = hotpathResult.truncated
      ? {
          truncated: true,
          droppedCount: 0,
          howToResume: {
            type: "cursor" as const,
            value: hotpathResult.actualRange.endLine,
          },
        }
      : undefined;

    const response: CodeNeedWindowResponse = {
      approved: true,
      symbolId: request.symbolId,
      file: file.relPath,
      range: hotpathResult.actualRange,
      code: hotpathResult.excerpt,
      whyApproved: ["Policy approved (downgraded to hotpath)"],
      estimatedTokens: hotpathResult.estimatedTokens,
      downgradedFrom: "raw-code",
      matchedIdentifiers: hotpathResult.matchedIdentifiers,
      matchedLineNumbers: hotpathResult.matchedLineNumbers,
      truncation: hotpathTruncation,
    };

    return attachRawContext(response, { fileIds: [symbol.fileId] });
  }

  if (gateResult.approved) {
    const granularity = request.granularity ?? "symbol";

    const filePath = getAbsolutePathFromRepoRoot(repo.rootPath, file.relPath);
    const isSensitive = shouldRedactFile(filePath);

    const maxLines = Math.min(
      request.expectedLines,
      validatedPolicy.maxWindowLines,
    );
    const maxTokens = request.maxTokens
      ? Math.min(request.maxTokens, validatedPolicy.maxWindowTokens)
      : validatedPolicy.maxWindowTokens;

    const windowResult = await extractWindow(
      filePath,
      symbolRange,
      granularity,
      maxLines,
      maxTokens,
    );

    if (
      validatedPolicy.requireIdentifiers &&
      request.identifiersToFind.length > 0 &&
      !identifiersExistInWindow(windowResult.code, request.identifiersToFind)
    ) {
      const whyDenied = ["Identifiers not found in code window"];
      logCodeWindowDecision({
        symbolId: request.symbolId,
        approved: false,
        reason: whyDenied,
      });
      return {
        approved: false,
        whyDenied,
        suggestedNextRequest,
        nextBestAction: gateNextBestAction,
      };
    }

    const redactionConfig = appConfig.redaction;
    const redactionEnabled = redactionConfig?.enabled ?? true;
    const redactionPatterns = buildRedactionPatterns(redactionConfig);
    let redactedCode = windowResult.code;
    if (redactionEnabled && redactionPatterns.length > 0) {
      redactedCode = redactSecrets(windowResult.code, redactionPatterns);
    }
    const whyApproved = [...gateResult.whyApproved];
    if (windowResult.truncated) {
      whyApproved.push("truncated-to-policy");
    }
    if (redactionEnabled && isSensitive) {
      whyApproved.push("redacted-file");
    }
    if (redactionEnabled && redactedCode !== windowResult.code) {
      whyApproved.push("redaction-applied");
    }

    logCodeWindowDecision({
      symbolId: request.symbolId,
      approved: true,
      reason: whyApproved,
    });

    const codeTruncation = windowResult.truncated
      ? {
          truncated: true,
          droppedCount:
            windowResult.originalLines - redactedCode.split("\n").length,
          howToResume: {
            type: "cursor" as const,
            value: windowResult.actualRange.endLine,
          },
        }
      : undefined;

    const response: CodeNeedWindowResponse = {
      approved: true,
      symbolId: request.symbolId,
      file: file.relPath,
      range: windowResult.actualRange,
      code: redactedCode,
      whyApproved,
      estimatedTokens: windowResult.estimatedTokens,
      truncation: codeTruncation,
    };

    return attachRawContext(response, { fileIds: [symbol.fileId] });
  } else {
    logCodeWindowDecision({
      symbolId: request.symbolId,
      approved: false,
      reason: gateResult.whyDenied,
    });

    return {
      approved: false,
      whyDenied: gateResult.whyDenied,
      suggestedNextRequest: gateResult.suggestedNextRequest,
      nextBestAction: gateResult.nextBestAction,
    };
  }
}

/**
 * Handles skeleton generation requests.
 * Generates code skeleton for a symbol or file with optional identifier filtering.
 * Skeleton preserves structure while removing function bodies.
 *
 * @param args - Raw arguments containing symbolId or file, and skeleton parameters
 * @returns Skeleton response with skeleton code, range, and truncation info
 * @throws {Error} If symbol/file not found or skeleton generation fails
 */
export async function handleGetSkeleton(
  args: unknown,
): Promise<GetSkeletonResponse> {
  const request = GetSkeletonRequestSchema.parse(args);

  recordToolTrace({
    repoId: request.repoId,
    taskType: "code",
    tool: "code.getSkeleton",
    symbolId: request.symbolId,
  });
  if (request.symbolId) {
    consumePrefetchedKey(request.repoId, `card:${request.symbolId}`);
  }

  if (request.symbolId) {
    const result = await generateSymbolSkeleton(
      request.repoId,
      request.symbolId,
      {
        maxLines: request.maxLines,
        maxTokens: request.maxTokens,
        includeIdentifiers: request.identifiersToFind,
      },
    );

    if (!result) {
      throw new IndexError(
        `Failed to generate skeleton for symbol: ${request.symbolId}`,
      );
    }

    const conn = await getLadybugConn();
    const symbol = await ladybugDb.getSymbol(conn, request.symbolId);
    const file = symbol
      ? ((await ladybugDb.getFilesByIds(conn, [symbol.fileId])).get(
          symbol.fileId,
        ) ?? null)
      : null;

    const skeletonTruncation = result.truncated
      ? {
          truncated: true,
          droppedCount:
            result.originalLines - result.skeleton.split("\n").length,
          howToResume: {
            type: "cursor" as const,
            value: result.actualRange.endLine,
          },
        }
      : undefined;

    const response: GetSkeletonResponse = {
      skeleton: result.skeleton,
      file: file?.relPath || "",
      range: result.actualRange,
      estimatedTokens: result.estimatedTokens,
      originalLines: result.originalLines,
      truncated: result.truncated,
      truncation: skeletonTruncation,
    };

    if (symbol) {
      attachRawContext(response, { fileIds: [symbol.fileId] });
    }
    return response;
  } else if (request.file) {
    const result = await generateFileSkeleton(
      request.repoId,
      request.file,
      request.exportedOnly ?? false,
      {
        maxLines: request.maxLines,
        maxTokens: request.maxTokens,
        includeIdentifiers: request.identifiersToFind,
      },
    );

    if (!result) {
      throw new IndexError(
        `Failed to generate skeleton for file: ${request.file}`,
      );
    }

    const skeletonTruncation = result.truncated
      ? {
          truncated: true,
          droppedCount:
            result.originalLines - result.skeleton.split("\n").length,
          howToResume: {
            type: "cursor" as const,
            value: result.actualRange.endLine,
          },
        }
      : undefined;

    const response: GetSkeletonResponse = {
      skeleton: result.skeleton,
      file: request.file,
      range: result.actualRange,
      estimatedTokens: result.estimatedTokens,
      originalLines: result.originalLines,
      truncated: result.truncated,
      truncation: skeletonTruncation,
    };

    const conn = await getLadybugConn();
    const fileRow = await ladybugDb.getFileByRepoPath(
      conn,
      request.repoId,
      request.file,
    );
    if (fileRow) {
      attachRawContext(response, { fileIds: [fileRow.fileId] });
    }
    return response;
  }

  throw new ValidationError("Either symbolId or file must be provided");
}

/**
 * Handles hot-path extraction requests.
 * Extracts minimal code paths containing specified identifiers.
 * Useful for understanding specific code paths without full symbol context.
 *
 * @param args - Raw arguments containing symbolId, identifiersToFind, and extraction parameters
 * @returns Hot-path response with code excerpt and matched identifiers
 * @throws {Error} If symbol not found or hot-path extraction fails
 */
export async function handleGetHotPath(
  args: unknown,
): Promise<GetHotPathResponse> {
  const request = GetHotPathRequestSchema.parse(args);

  recordToolTrace({
    repoId: request.repoId,
    taskType: "code",
    tool: "code.getHotPath",
    symbolId: request.symbolId,
  });
  consumePrefetchedKey(request.repoId, `card:${request.symbolId}`);

  const result = await extractHotPath(
    request.repoId,
    request.symbolId,
    request.identifiersToFind,
    {
      maxLines: request.maxLines ?? DEFAULT_MAX_LINES_HOTPATH,
      maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS_HOTPATH,
      contextLines: request.contextLines ?? DEFAULT_CONTEXT_LINES,
    },
  );

  if (!result) {
    throw new IndexError(
      `Failed to extract hot-path for symbol: ${request.symbolId}`,
    );
  }

  const conn = await getLadybugConn();
  const symbol = await ladybugDb.getSymbol(conn, request.symbolId);
  const fileData = symbol
    ? ((await ladybugDb.getFilesByIds(conn, [symbol.fileId])).get(
        symbol.fileId,
      ) ?? null)
    : null;

  const response = {
    excerpt: result.excerpt,
    file: fileData?.relPath ?? "",
    range: result.actualRange,
    estimatedTokens: result.estimatedTokens,
    matchedIdentifiers: result.matchedIdentifiers,
    matchedLineNumbers: result.matchedLineNumbers,
    truncated: result.truncated,
  };
  if (symbol) {
    attachRawContext(response, { fileIds: [symbol.fileId] });
  }
  return response;
}
