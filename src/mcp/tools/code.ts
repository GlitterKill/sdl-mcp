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
import {
  getSymbol,
  getFile,
  getRepo,
  getLatestVersion,
} from "../../db/queries.js";
import { logCodeWindowDecision, logPolicyDecision } from "../telemetry.js";
import type { Range } from "../types.js";
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

const policyEngine = new PolicyEngine();

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

  const symbol = getSymbol(request.symbolId);
  if (!symbol) {
    throw new Error(`Symbol not found: ${request.symbolId}`);
  }

  const file = getFile(symbol.file_id);
  if (!file) {
    throw new Error(`File not found: ${symbol.file_id}`);
  }

  const repo = getRepo(request.repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${request.repoId}`);
  }

  const symbolRange: Range = {
    startLine: symbol.range_start_line,
    startCol: symbol.range_start_col,
    endLine: symbol.range_end_line,
    endCol: symbol.range_end_col,
  };

  const repoConfig = JSON.parse(repo.config_json);
  const appConfig = loadConfig();
  const validatedPolicy = PolicyConfigSchema.parse({
    ...appConfig.policy,
    ...(repoConfig.policy ?? {}),
  });
  const sliceBudgetDefaults = {
    maxCards: appConfig.slice?.defaultMaxCards ?? DEFAULT_MAX_CARDS,
    maxEstimatedTokens: appConfig.slice?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS_SLICE,
  };
  const existingPolicyConfig = policyEngine.getConfig();
  policyEngine.updateConfig({
    maxWindowLines: validatedPolicy.maxWindowLines,
    maxWindowTokens: validatedPolicy.maxWindowTokens,
    requireIdentifiers: validatedPolicy.requireIdentifiers,
    allowBreakGlass: validatedPolicy.allowBreakGlass,
    defaultDenyRaw: existingPolicyConfig.defaultDenyRaw,
    budgetCaps: sliceBudgetDefaults,
  });

  const context: GateContext = {
    symbol,
    policy: validatedPolicy,
  };

  if (request.sliceContext) {
    const latestVersion = getLatestVersion(request.repoId);
    if (latestVersion) {
      const slice = await buildSlice({
        repoId: request.repoId,
        versionId: latestVersion.version_id,
        ...request.sliceContext,
      });
      context.slice = slice;
    }
  }

  const gateResult = evaluateRequest(request, context);
  const suggestedNextRequest = !gateResult.approved
    ? gateResult.suggestedNextRequest
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
    symbolData: symbol,
  };

  const policyDecision = policyEngine.evaluate(policyContext);
  const { nextBestAction, requiredFieldsForNext } =
    policyEngine.generateNextBestAction(policyDecision, policyContext);

  logPolicyDecision({
    requestType: policyContext.requestType,
    repoId: policyContext.repoId,
    symbolId: policyContext.symbolId,
    decision: policyDecision.decision,
    auditHash: policyDecision.auditHash,
    evidenceUsed: policyDecision.evidenceUsed,
    deniedReasons: policyDecision.deniedReasons,
    nextBestAction,
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
    };
  }

  if (policyDecision.decision === "downgrade-to-skeleton") {
    const skeletonResult = generateSymbolSkeleton(
      request.repoId,
      request.symbolId,
      {
        maxLines: request.expectedLines,
        maxTokens: request.maxTokens,
        includeIdentifiers: request.identifiersToFind,
      },
    );

    if (!skeletonResult) {
      throw new Error(
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
      file: file.rel_path,
      range: skeletonResult.actualRange,
      code: skeletonResult.skeleton,
      whyApproved: ["Policy approved (downgraded to skeleton)"],
      estimatedTokens: skeletonResult.estimatedTokens,
      downgradedFrom: "raw-code",
      truncation: skeletonTruncation,
    };

    return response;
  }

  if (policyDecision.decision === "downgrade-to-hotpath") {
    const hotpathResult = extractHotPath(
      request.repoId,
      request.symbolId,
      request.identifiersToFind ?? [],
      {
        maxLines: request.expectedLines,
        maxTokens: request.maxTokens,
      },
    );

    if (!hotpathResult) {
      throw new Error(
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
      file: file.rel_path,
      range: hotpathResult.actualRange,
      code: hotpathResult.excerpt,
      whyApproved: ["Policy approved (downgraded to hotpath)"],
      estimatedTokens: hotpathResult.estimatedTokens,
      downgradedFrom: "raw-code",
      matchedIdentifiers: hotpathResult.matchedIdentifiers,
      matchedLineNumbers: hotpathResult.matchedLineNumbers,
      truncation: hotpathTruncation,
    };

    return response;
  }

  if (gateResult.approved) {
    const granularity = request.granularity ?? "symbol";

    const filePath = getAbsolutePathFromRepoRoot(repo.root_path, file.rel_path);
    const isSensitive = shouldRedactFile(filePath);

    const maxLines = validatedPolicy.maxWindowLines;
    const maxTokens = request.maxTokens ?? validatedPolicy.maxWindowTokens;

    const windowResult = extractWindow(
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
      file: file.rel_path,
      range: windowResult.actualRange,
      code: redactedCode,
      whyApproved,
      estimatedTokens: windowResult.estimatedTokens,
      truncation: codeTruncation,
    };

    return response;
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

  if (request.symbolId) {
    const result = generateSymbolSkeleton(request.repoId, request.symbolId, {
      maxLines: request.maxLines,
      maxTokens: request.maxTokens,
      includeIdentifiers: request.identifiersToFind,
    });

    if (!result) {
      throw new Error(
        `Failed to generate skeleton for symbol: ${request.symbolId}`,
      );
    }

    const symbol = getSymbol(request.symbolId);
    const file = symbol ? getFile(symbol.file_id) : null;

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
      file: file?.rel_path || "",
      range: result.actualRange,
      estimatedTokens: result.estimatedTokens,
      originalLines: result.originalLines,
      truncated: result.truncated,
      truncation: skeletonTruncation,
    };

    return response;
  } else if (request.file) {
    const result = generateFileSkeleton(
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
      throw new Error(`Failed to generate skeleton for file: ${request.file}`);
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

    return response;
  }

  throw new Error("Either symbolId or file must be provided");
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

  const result = extractHotPath(
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
    throw new Error(
      `Failed to extract hot-path for symbol: ${request.symbolId}`,
    );
  }

  const file = getSymbol(request.symbolId);
  const fileData = file ? getFile(file.file_id) : null;

  return {
    excerpt: result.excerpt,
    file: fileData?.rel_path ?? "",
    range: result.actualRange,
    estimatedTokens: result.estimatedTokens,
    matchedIdentifiers: result.matchedIdentifiers,
    matchedLineNumbers: result.matchedLineNumbers,
    truncated: result.truncated,
  };
}
