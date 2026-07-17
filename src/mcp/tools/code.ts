// Input validated by server.ts dispatch before reaching handlers
import { readFile, stat } from "fs/promises";

import { parseActionHandlerArgs } from "../../gateway/dispatch-spine.js";
import {
  type CodeNeedWindowRequest,
  CodeNeedWindowRequestSchema,
  type CodeNeedWindowResponse,
  GetSkeletonRequestSchema,
  GetSkeletonResponse,
  type GetHotPathRequest,
  GetHotPathRequestSchema,
  GetHotPathResponse,
  type SymbolRef,
} from "../tools.js";
import {
  DEFAULT_MAX_LINES_HOTPATH,
  DEFAULT_MAX_TOKENS_HOTPATH,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  MAX_FILE_BYTES,
} from "../../config/constants.js";
import { enforceCodeWindow } from "../../code/enforce.js";
import { LadybugWindowLoader } from "../../code/window-loader.js";
import {
  extractWindow,
  findMatchedIdentifiersInWindow,
  identifiersExistInWindow,
} from "../../code/windows.js";
import {
  buildRedactionPatterns,
  redactSecrets,
  shouldRedactFile,
} from "../../code/redact.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { logCodeWindowDecision, logPolicyDecision } from "../telemetry.js";
import {
  safeJsonParseOrThrow,
  ConfigObjectSchema,
} from "../../util/safeJson.js";
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
import {
  getAbsolutePathFromRepoRoot,
  normalizePath,
} from "../../util/paths.js";
import {
  generateSymbolSkeleton,
  generateFileSkeleton,
} from "../../code/skeleton.js";
import { extractHotPath } from "../../code/hotpath.js";
import {
  decideCodeAccess,
  toLegacyPolicyDecision,
} from "../../policy/code-access.js";
import type { CodeWindowResponse, GraphSlice } from "../../domain/types.js";
import type { PolicyRequestContext } from "../../policy/types.js";
import { consumePrefetchedKey } from "../../graph/prefetch.js";
import { recordToolTrace } from "../../graph/prefetch-model.js";
import { toLegacySymbolRow } from "./symbol-utils.js";
import { resolveSymbolId } from "../../util/resolve-symbol-id.js";
import { resolveSymbolRef } from "../../util/resolve-symbol-ref.js";
import { getOverlaySnapshot } from "../../live-index/overlay-reader.js";
import { buildConditionalResponse } from "../../util/conditional-response.js";
import type { ToolContext } from "../../server.js";
import { maybeBuildSessionDelta } from "../session-delta.js";
import { sessionContentLedger } from "../session-dedupe.js";
import { hashContent } from "../../util/hashing.js";
import {
  maybeCompressToolResponse,
  recordTokenSavings,
} from "../response-compression.js";

type RefsMode = "auto" | "off";

type ResolvedCodeNeedWindowRequest = Omit<
  CodeNeedWindowRequest,
  "symbolId" | "symbolRef"
> & { symbolId: string };

type ResolvedGetHotPathRequest = Omit<
  GetHotPathRequest,
  "symbolId" | "symbolRef"
> & { symbolId: string };

function buildSessionRef(key: string, etag?: string): { key: string; etag?: string } {
  const ref: { key: string; etag?: string } = { key };
  if (etag !== undefined) ref.etag = etag;
  return ref;
}

function maybeApplySessionContentRef(
  response: Record<string, unknown>,
  options: {
    sessionId?: string;
    refsMode?: RefsMode;
    key: string;
    heavyField: string;
  },
): Record<string, unknown> {
  if (options.refsMode === "off" || !options.sessionId) return response;
  const etag = typeof response.etag === "string" ? response.etag : undefined;
  const result = sessionContentLedger.record({
    sessionId: options.sessionId,
    key: options.key,
    contentHash: hashContent(JSON.stringify(response)),
    etag,
  });
  if (result.status === "unchanged") {
    const compact = { ...response };
    delete compact[options.heavyField];
    compact.ref = buildSessionRef(options.key, etag);
    compact.unchanged = true;
    return compact;
  }
  if (result.status === "changed") return { ...response, changedSincePrior: true };
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCodeToolArgs(args: unknown): unknown {
  if (!isRecord(args) || typeof args.symbolRef !== "string") return args;
  try {
    const parsed = JSON.parse(args.symbolRef) as unknown;
    return isRecord(parsed) ? { ...args, symbolRef: parsed } : args;
  } catch {
    return args;
  }
}

function looksLikeFilePathSymbolId(symbolId: string): boolean {
  return normalizePath(symbolId).includes("/");
}

function filePathSymbolIdError(repoId: string, toolName: string, symbolId: string): Error {
  const file = normalizePath(symbolId);
  const error = new ValidationError(
    `Invalid symbolId "${symbolId}" for ${toolName}: this looks like a file path. Use sdl.code.getSkeleton with file, or find a symbol in the file and retry with symbolRef.`,
  );
  return Object.assign(error, {
    classification: "invalid_input",
    retryable: false,
    fallbackTools: ["sdl.code.getSkeleton", "sdl.symbol.search"],
    fallbackRationale:
      "code.needWindow and code.getHotPath need a symbol target, not a file path.",
    nextCalls: [
      { tool: "sdl.code.getSkeleton", args: { repoId, file } },
      { tool: "sdl.symbol.search", args: { repoId, query: file.split("/").pop() ?? file } },
    ],
  });
}

async function resolveCodeTargetSymbolId(
  conn: Awaited<ReturnType<typeof getLadybugConn>>,
  repoId: string,
  target: { symbolId?: string; symbolRef?: SymbolRef },
  toolName: string,
): Promise<string> {
  if (target.symbolId) {
    if (looksLikeFilePathSymbolId(target.symbolId)) {
      throw filePathSymbolIdError(repoId, toolName, target.symbolId);
    }
    const resolved = await resolveSymbolId(conn, repoId, target.symbolId);
    return resolved.symbolId;
  }
  if (target.symbolRef) {
    const resolved = await resolveSymbolRef(conn, repoId, target.symbolRef);
    if (resolved.status !== "resolved") {
      throw new NotFoundError(`${resolved.message} Use symbolRef.file or symbolRef.kind to refine ${toolName}.`);
    }
    return resolved.symbolId;
  }
  throw new ValidationError(`Provide exactly one of symbolId or symbolRef for ${toolName}.`);
}

function estimateRawWindowTokens(request: ResolvedCodeNeedWindowRequest): number {
  return Math.max(0, Math.ceil(request.expectedLines * 12));
}

function recordRawWindowAvoidance(
  request: ResolvedCodeNeedWindowRequest,
  avoided: boolean,
): void {
  recordTokenSavings({
    repoId: request.repoId,
    source: "rawWindowAvoidance",
    tool: "sdl.code.needWindow",
    estimatedTokensAvoided: avoided ? estimateRawWindowTokens(request) : 0,
    opportunity: true,
    hit: avoided,
    realized: avoided,
  });
}

function buildPolicyNextBestAction(params: {
  request: ResolvedCodeNeedWindowRequest;
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

type DeliveredCodeNeedWindowResponse = Extract<
  CodeNeedWindowResponse,
  { approved: true }
>;
type PendingCodeNeedWindowResponse = Omit<
  DeliveredCodeNeedWindowResponse,
  "contentKind" | "status"
>;

async function finalizeCodeNeedWindowResponse(
  request: ResolvedCodeNeedWindowRequest,
  context: ToolContext | undefined,
  response: PendingCodeNeedWindowResponse,
  contentKind: DeliveredCodeNeedWindowResponse["contentKind"],
  fileId: string,
): Promise<CodeNeedWindowResponse> {
  const responseWithStatus = {
    ...response,
    status: response.downgradedFrom
      ? ("downgraded" as const)
      : ("approvedRaw" as const),
    contentKind,
  };
  const rawContext = { fileIds: [fileId] };
  let enriched = attachRawContext(responseWithStatus, rawContext);
  recordRawWindowAvoidance(request, response.downgradedFrom === "raw-code");

  if (request.deltaMode === "auto") {
    const deltaResult = maybeBuildSessionDelta({
      sessionId: context?.sessionId,
      key: {
        toolName: "sdl.code.needWindow",
        repoId: request.repoId,
        filePath: response.file,
        symbolId: request.symbolId,
        range: {
          startLine: response.range.startLine,
          endLine: response.range.endLine,
        },
        extra: {
          granularity: request.granularity,
          maxTokens: request.maxTokens,
          expectedLines: request.expectedLines,
        },
      },
      content: response.code,
      deltaMode: request.deltaMode,
      maxDeltaLines: request.maxDeltaLines,
    });

    recordTokenSavings({
      repoId: request.repoId,
      source: "sessionDelta",
      tool: "sdl.code.needWindow",
      estimatedTokensAvoided: deltaResult.metadata.estimatedTokensAvoided,
      opportunity: true,
      hit: deltaResult.metadata.cacheHit,
      realized: deltaResult.metadata.deltaApplied,
    });

    if (deltaResult.metadata.deltaApplied && deltaResult.delta) {
      enriched = attachRawContext(
        {
          ...responseWithStatus,
          code: "",
          sessionDelta: deltaResult.metadata,
          delta: deltaResult.delta,
        },
        rawContext,
      );
    }
  }

  return maybeCompressToolResponse({
    repoId: request.repoId,
    toolName: "sdl.code.needWindow",
    payload: enriched,
    responseMode: request.responseMode,
    rawContext,
    sessionId: context?.sessionId,
  });
}

export interface IdentifierMissWarningContext {
  maxLines: number;
  rangeNarrowed: boolean;
  windowTruncated: boolean;
}

export function buildIdentifierMissWarning(
  missedIdentifiers: string[],
  context: IdentifierMissWarningContext,
): string {
  const missing = missedIdentifiers.join(", ");
  if (context.windowTruncated) {
    return `Identifiers not in visible range (window truncated to ${context.maxLines} lines): ${missing}. Use sdl.code.getHotPath to find them.`;
  }
  if (context.rangeNarrowed) {
    return `Identifiers not in selected visible range: ${missing}. Use sdl.code.getHotPath to find them.`;
  }
  return `Identifiers not found in selected symbol: ${missing}. Use sdl.symbol.search for sibling symbols before retrying sdl.code.needWindow.`;
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
  context?: ToolContext,
): Promise<CodeNeedWindowResponse> {
  const rawRequest = parseActionHandlerArgs(
    CodeNeedWindowRequestSchema,
    args,
    normalizeCodeToolArgs,
  );

  const conn = await getLadybugConn();
  const resolvedSymbolId = await resolveCodeTargetSymbolId(
    conn,
    rawRequest.repoId,
    rawRequest,
    "sdl.code.needWindow",
  );
  const { symbolRef: _symbolRef, ...rawRequestWithoutRef } = rawRequest;
  const request: ResolvedCodeNeedWindowRequest = {
    ...rawRequestWithoutRef,
    symbolId: resolvedSymbolId,
  };

  recordToolTrace({
    repoId: request.repoId,
    taskType: "code",
    tool: "code.needWindow",
    symbolId: request.symbolId,
    clientKey: context?.clientKey,
  });
  consumePrefetchedKey(
    request.repoId,
    `card:${request.symbolId}`,
    "search-cards",
    context,
  );

  let symbol = await ladybugDb.getSymbol(conn, request.symbolId);
  if (!symbol) {
    // Fallback: check overlay for recently-parsed symbols not yet in durable DB
    const overlaySnap = getOverlaySnapshot(request.repoId);
    symbol = overlaySnap?.symbolsById.get(request.symbolId) ?? null;
    if (!symbol) {
      throw new NotFoundError(
        `Symbol not found: ${request.symbolId}. Use sdl.symbol.search to find valid symbol IDs.`,
      );
    }
  }

  if (symbol.repoId !== request.repoId) {
    throw new ValidationError(
      `Symbol ${request.symbolId} belongs to repo "${symbol.repoId}", not "${request.repoId}"`,
    );
  }

  const files = await ladybugDb.getFilesByIds(conn, [symbol.fileId]);
  const file = files.get(symbol.fileId);
  if (!file) {
    throw new NotFoundError(
      `File record missing for symbol ${symbol.name} (${request.symbolId}). Try re-indexing with sdl.index.refresh.`,
    );
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

  const repoConfig = safeJsonParseOrThrow(
    repo.configJson,
    ConfigObjectSchema,
    `configJson for repository ${request.repoId}`,
  );
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
  const policyConfig = {
    maxWindowLines: validatedPolicy.maxWindowLines,
    maxWindowTokens: validatedPolicy.maxWindowTokens,
    requireIdentifiers: validatedPolicy.requireIdentifiers,
    allowBreakGlass: validatedPolicy.allowBreakGlass,
    defaultDenyRaw: validatedPolicy.defaultDenyRaw,
    budgetCaps: sliceBudgetDefaults,
  };

  let sliceContext: GraphSlice | undefined;

  if (request.sliceContext) {
    const latestVersion = await ladybugDb.getLatestVersion(
      conn,
      request.repoId,
    );
    if (latestVersion) {
      const { slice } = await buildSlice({
        repoId: request.repoId,
        versionId: latestVersion.versionId,
        ...request.sliceContext,
      });
      sliceContext = slice;
    }
  }

  const policyContext: PolicyRequestContext = {
    requestType: "codeWindow",
    repoId: request.repoId,
    symbolId: request.symbolId,
    maxWindowLines: request.expectedLines,
    maxWindowTokens: request.maxTokens,
    identifiersToFind: request.identifiersToFind,
    reason: request.reason,
    sliceContext,
    expectedLines: request.expectedLines,
    symbolData: legacySymbol,
  };

  // Evaluate policy first; break-glass evidence can flow into enforcement
  const accessDecision = decideCodeAccess(policyContext, policyConfig);
  const policyDecision = toLegacyPolicyDecision(accessDecision);
  const policyNextBestAction =
    accessDecision.kind !== "approve"
      ? accessDecision.nextBestAction
      : undefined;
  const requiredFieldsForNext =
    accessDecision.kind !== "approve"
      ? accessDecision.requiredFieldsForNext
      : undefined;

  const isBreakGlass =
    accessDecision.kind === "approve" &&
    accessDecision.evidenceUsed.some((e) => e.type === "break-glass-triggered");

  let gateResult: CodeWindowResponse;
  if (accessDecision.kind === "approve") {
    const loader = new LadybugWindowLoader();
    gateResult = await enforceCodeWindow(request, accessDecision, loader, {
      breakGlass: isBreakGlass,
      slice: sliceContext,
    });
  } else {
    gateResult = {
      approved: false,
      whyDenied:
        accessDecision.kind === "deny"
          ? accessDecision.deniedReasons
          : ["Policy downgrade — see downgrade branch for response"],
      suggestedNextRequest: undefined,
      nextBestAction: undefined,
    };
  }
  const suggestedNextRequest = !gateResult.approved
    ? gateResult.suggestedNextRequest
    : undefined;
  const gateNextBestAction = !gateResult.approved
    ? gateResult.nextBestAction
    : undefined;

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
    recordRawWindowAvoidance(request, true);

    return {
      approved: false,
      status: "denied",
      whyDenied: policyDecision.deniedReasons ?? ["Policy denied request"],
      suggestedNextRequest,
      nextBestAction: policyAction,
    };
  }

  if (policyDecision.decision === "downgrade-to-skeleton") {
    // Issue #11: when the caller provided specific identifiers, the
    // skeleton downgrade is byte-identical to a plain `code.getSkeleton`
    // call and adds no value over the cheaper code.getSkeleton tool. Promote
    // to a hot-path excerpt anchored on the requested identifiers — same
    // policy outcome (still a downgrade), but the response surfaces
    // identifier-anchored context the caller actually needs.
    const wantsIdentifierAnchor =
      Array.isArray(request.identifiersToFind) &&
      request.identifiersToFind.length > 0;
    if (wantsIdentifierAnchor) {
      const hotpathResult = await extractHotPath(
        request.repoId,
        request.symbolId,
        request.identifiersToFind,
        { maxLines: request.expectedLines, maxTokens: request.maxTokens },
      );
      if (hotpathResult) {
        logCodeWindowDecision({
          symbolId: request.symbolId,
          approved: true,
          reason: [
            "Policy approved (downgraded to hotpath; identifiers supplied)",
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
        const response: PendingCodeNeedWindowResponse = {
          approved: true,
          symbolId: request.symbolId,
          file: file.relPath,
          range: hotpathResult.actualRange,
          code: hotpathResult.excerpt,
          whyApproved: [
            "Policy approved (downgraded to hotpath; identifiers supplied)",
          ],
          estimatedTokens: hotpathResult.estimatedTokens,
          downgradedFrom: "raw-code",
          downgradeGuidance:
            "Raw code was downgraded; identifiers in identifiersToFind anchored a hot-path excerpt. To get full code: (1) set policy.allowBreakGlass=true via sdl.policy.set, or (2) call sdl.code.getSkeleton for broader code structure.",
          matchedIdentifiers: hotpathResult.matchedIdentifiers,
          matchedLineNumbers: hotpathResult.matchedLineNumbers,
          truncation: hotpathTruncation,
        };
        return finalizeCodeNeedWindowResponse(
          request,
          context,
          response,
          "hotPath",
          symbol.fileId,
        );
      }
      // Hotpath failed — fall through to skeleton below.
    }
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
      // Distinguish between symbol-not-found vs file-not-found for clearer error messages
      const skConn = await getLadybugConn();
      const skSymbol = await ladybugDb.getSymbol(skConn, request.symbolId);
      if (!skSymbol) {
        throw new NotFoundError(
          `Symbol not found: ${request.symbolId}. Use sdl.symbol.search to find valid symbol IDs.`,
        );
      }
      const skFiles = await ladybugDb.getFilesByIds(skConn, [skSymbol.fileId]);
      const skFile = skFiles.get(skSymbol.fileId);
      if (!skFile) {
        throw new NotFoundError(
          `File record missing for symbol ${skSymbol.name} (${request.symbolId}). Try re-indexing with sdl.index.refresh.`,
        );
      }
      throw new NotFoundError(
        `File not found on disk: ${skFile.relPath}. The file may have been moved or deleted since last indexing.`,
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
            value:
              skeletonResult.skeletonLinesConsumed ??
              skeletonResult.actualRange.endLine,
            parameter: "skeletonOffset",
          },
        }
      : undefined;

    const response: PendingCodeNeedWindowResponse = {
      approved: true,
      symbolId: request.symbolId,
      file: file.relPath,
      range: skeletonResult.actualRange,
      code: skeletonResult.skeleton,
      whyApproved: ["Policy approved (downgraded to skeleton)"],
      estimatedTokens: skeletonResult.estimatedTokens,
      downgradedFrom: "raw-code",
      downgradeGuidance:
        "Raw code access was downgraded to skeleton by policy. To get full code: (1) set policy.allowBreakGlass=true via sdl.policy.set, then retry with breakGlass in sliceContext, or (2) use sdl.code.getHotPath with specific identifiersToFind for targeted access.",
      truncation: skeletonTruncation,
    };

    // FP-2: Check for missed identifiers in downgraded responses (matching getHotPath behavior)
    if (request.identifiersToFind && request.identifiersToFind.length > 0) {
      const skeletonCode = skeletonResult.skeleton;
      const missed = request.identifiersToFind.filter(
        (id) => !skeletonCode.includes(id),
      );
      if (missed.length > 0) {
        Object.assign(response, {
          missedIdentifiers: missed,
          missedIdentifierHint:
            "Identifiers not found in downgraded skeleton. Use sdl.symbol.search to find the symbol containing these identifiers, then call sdl.code.getHotPath on that symbol.",
        });
      }
    }
    return finalizeCodeNeedWindowResponse(
      request,
      context,
      response,
      "skeleton",
      symbol.fileId,
    );
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
          droppedCount: 0, // hot-path excerpts don't track original line counts
          howToResume: {
            type: "cursor" as const,
            value: hotpathResult.actualRange.endLine,
          },
        }
      : undefined;

    const response: PendingCodeNeedWindowResponse = {
      approved: true,
      symbolId: request.symbolId,
      file: file.relPath,
      range: hotpathResult.actualRange,
      code: hotpathResult.excerpt,
      whyApproved: ["Policy approved (downgraded to hotpath)"],
      estimatedTokens: hotpathResult.estimatedTokens,
      downgradedFrom: "raw-code",
      downgradeGuidance:
        "Raw code access was downgraded to hot-path by policy. To get full code: (1) set policy.allowBreakGlass=true via sdl.policy.set, or (2) request a skeleton via sdl.code.getSkeleton for broader code structure.",
      matchedIdentifiers: hotpathResult.matchedIdentifiers,
      matchedLineNumbers: hotpathResult.matchedLineNumbers,
      truncation: hotpathTruncation,
    };

    return finalizeCodeNeedWindowResponse(
      request,
      context,
      response,
      "hotPath",
      symbol.fileId,
    );
  }

  if (gateResult.approved) {
    if (request.expectedLines <= 0) {
      throw new ValidationError("expectedLines must be a positive integer");
    }
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

    // Pre-scan: if identifiers would be outside the default window (first
    // maxLines of symbol), shift the range to center on identifier locations.
    let effectiveRange = symbolRange;
    let effectiveGranularity = granularity;

    // Handle cursor-based continuation (from truncation recovery)
    if (
      request.cursor !== undefined &&
      request.cursor > symbolRange.startLine
    ) {
      effectiveRange = {
        ...symbolRange,
        startLine: request.cursor,
      };
      effectiveGranularity = "fileWindow";
    }
    if (
      request.cursor === undefined &&
      request.identifiersToFind.length > 0 &&
      (granularity === "symbol" || granularity === "block") &&
      symbolRange.endLine - symbolRange.startLine + 1 > maxLines
    ) {
      try {
        const resolvedPath = normalizePath(filePath);
        const fileStat = await stat(resolvedPath);
        if (fileStat.size <= MAX_FILE_BYTES) {
          const fileContent = await readFile(resolvedPath, "utf-8");
          const fileLines = fileContent.replaceAll("\r\n", "\n").split("\n");
          const idLineNumbers: number[] = [];
          for (
            let ln = symbolRange.startLine;
            ln <= Math.min(symbolRange.endLine, fileLines.length);
            ln++
          ) {
            const line = fileLines[ln - 1];
            if (
              line &&
              findMatchedIdentifiersInWindow(
                line,
                request.identifiersToFind,
              ).length > 0
            ) {
              idLineNumbers.push(ln);
            }
          }
          const anchorLine = idLineNumbers[0];
          if (
            anchorLine !== undefined &&
            anchorLine >= symbolRange.startLine + maxLines
          ) {
            const halfWindow = Math.floor(maxLines / 2);
            const centeredStart = Math.max(
              symbolRange.startLine,
              anchorLine - halfWindow,
            );
            const centeredEnd = Math.min(
              symbolRange.endLine,
              centeredStart + maxLines - 1,
            );
            effectiveRange = {
              startLine: centeredStart,
              startCol: 0,
              endLine: centeredEnd,
              endCol: symbolRange.endCol,
            };
            effectiveGranularity = "fileWindow";
          }
        }
      } catch {
        // Pre-scan failed — fall back to default behavior
      }
    }

    const windowResult = await extractWindow(
      filePath,
      effectiveRange,
      effectiveGranularity,
      maxLines,
      maxTokens,
    );

    // The gate already verified identifiers exist in the full symbol body.
    // If the truncated window doesn't contain them, approve anyway but note
    // which identifiers fell outside the visible range so the caller can
    // request a larger window or use getHotPath for the missing ones.
    let missedInWindow: string[] | undefined;
    if (
      validatedPolicy.requireIdentifiers &&
      request.identifiersToFind.length > 0 &&
      !identifiersExistInWindow(windowResult.code, request.identifiersToFind)
    ) {
      missedInWindow = request.identifiersToFind.filter(
        (id) => !identifiersExistInWindow(windowResult.code, [id]),
      );
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

    const symbolTotalLines = symbolRange.endLine - symbolRange.startLine + 1;
    const windowLines = windowResult.code.split("\n").length;
    const isRangeNarrowed =
      effectiveRange.startLine > symbolRange.startLine ||
      effectiveRange.endLine < symbolRange.endLine;

    // Surface warnings when code is empty despite approval
    const warnings: string[] = [];
    if (missedInWindow && missedInWindow.length > 0) {
      warnings.push(
        buildIdentifierMissWarning(missedInWindow, {
          maxLines,
          rangeNarrowed: isRangeNarrowed,
          windowTruncated: windowResult.truncated,
        }),
      );
    }
    if (redactedCode === "" && windowResult.emptyReason) {
      switch (windowResult.emptyReason) {
        case "file-too-large":
          warnings.push(
            "File exceeds maximum size limit and could not be read. Try sdl.code.getSkeleton instead.",
          );
          break;
        case "io-error":
          warnings.push(
            "File could not be read from disk (may have been moved, deleted, or is inaccessible).",
          );
          break;
        case "token-budget-exceeded":
          warnings.push(
            "Code window empty: the first line exceeds the token budget. Try increasing maxTokens or use sdl.code.getSkeleton.",
          );
          break;
      }
    }
    if (
      redactedCode === "" &&
      !windowResult.emptyReason &&
      windowResult.code !== ""
    ) {
      warnings.push(
        "Code was fully redacted by security policy. No content available.",
      );
    }

    logCodeWindowDecision({
      symbolId: request.symbolId,
      approved: true,
      reason: whyApproved,
    });

    const isTruncated = windowResult.truncated || isRangeNarrowed;
    const codeTruncation = isTruncated
      ? {
          truncated: true,
          droppedCount: Math.max(0, symbolTotalLines - windowLines),
          howToResume: {
            type: "cursor" as const,
            value: windowResult.actualRange.endLine,
          },
          suggestedNextCall: {
            tool: "sdl.code.needWindow",
            description:
              "Continue reading from the truncation point by copying this args block. Core params are carried over; re-add any response-shaping options (responseMode, deltaMode, maxDeltaLines) you passed originally.",
            args: {
              repoId: request.repoId,
              symbolId: request.symbolId,
              reason: request.reason,
              expectedLines: request.expectedLines,
              identifiersToFind: request.identifiersToFind,
              ...(request.granularity !== undefined
                ? { granularity: request.granularity }
                : {}),
              ...(request.maxTokens !== undefined
                ? { maxTokens: request.maxTokens }
                : {}),
              ...(request.sliceContext !== undefined
                ? { sliceContext: request.sliceContext }
                : {}),
              cursor: windowResult.actualRange.endLine,
            },
          },
        }
      : undefined;

    const response: PendingCodeNeedWindowResponse = {
      approved: true,
      symbolId: request.symbolId,
      file: file.relPath,
      range: windowResult.actualRange,
      code: redactedCode,
      whyApproved,
      ...(warnings.length > 0 ? { warnings } : {}),
      estimatedTokens: windowResult.estimatedTokens,
      truncation: codeTruncation,
    };

    return finalizeCodeNeedWindowResponse(
      request,
      context,
      response,
      "raw",
      symbol.fileId,
    );
  } else {
    logCodeWindowDecision({
      symbolId: request.symbolId,
      approved: false,
      reason: gateResult.whyDenied,
    });
    recordRawWindowAvoidance(request, true);

    return {
      approved: false,
      status: "denied",
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
  context?: ToolContext,
): Promise<GetSkeletonResponse> {
  const rawSkeletonRequest = parseActionHandlerArgs(
    GetSkeletonRequestSchema,
    args,
    normalizeCodeToolArgs,
  );

  // Resolve symbolId shorthand or structured symbolRef if present.
  let resolvedSkeletonSymbolId = rawSkeletonRequest.symbolId;
  if (rawSkeletonRequest.symbolId) {
    const skeletonConn = await getLadybugConn();
    const resolved = await resolveSymbolId(
      skeletonConn,
      rawSkeletonRequest.repoId,
      rawSkeletonRequest.symbolId,
    );
    resolvedSkeletonSymbolId = resolved.symbolId;
  } else if (rawSkeletonRequest.symbolRef) {
    const skeletonConn = await getLadybugConn();
    const resolved = await resolveSymbolRef(
      skeletonConn,
      rawSkeletonRequest.repoId,
      rawSkeletonRequest.symbolRef,
    );
    if (resolved.status !== "resolved") {
      throw new NotFoundError(resolved.message);
    }
    resolvedSkeletonSymbolId = resolved.symbolId;
  }
  const request = { ...rawSkeletonRequest, symbolId: resolvedSkeletonSymbolId };

  recordToolTrace({
    repoId: request.repoId,
    taskType: "code",
    tool: "code.getSkeleton",
    symbolId: request.symbolId,
    clientKey: context?.clientKey,
  });
  if (request.symbolId) {
    consumePrefetchedKey(
      request.repoId,
      `card:${request.symbolId}`,
      "search-cards",
      context,
    );
  }

  // Enforce policy limits as caps on maxLines/maxTokens
  const appConfig = loadConfig();
  const policyConfig = PolicyConfigSchema.safeParse(appConfig.policy ?? {});
  const policyMaxLines = policyConfig.success
    ? policyConfig.data.maxWindowLines
    : undefined;
  const policyMaxTokens = policyConfig.success
    ? policyConfig.data.maxWindowTokens
    : undefined;
  const rawMaxLines = Math.min(
    request.maxLines ?? Infinity,
    policyMaxLines ?? Infinity,
  );
  const effectiveMaxLines = Number.isFinite(rawMaxLines)
    ? rawMaxLines
    : undefined;
  const rawMaxTokens = Math.min(
    request.maxTokens ?? Infinity,
    policyMaxTokens ?? Infinity,
  );
  const effectiveMaxTokens = Number.isFinite(rawMaxTokens)
    ? rawMaxTokens
    : undefined;

  if (request.symbolId) {
    const result = await generateSymbolSkeleton(
      request.repoId,
      request.symbolId,
      {
        maxLines: effectiveMaxLines,
        maxTokens: effectiveMaxTokens,
        includeIdentifiers: request.identifiersToFind,
        skeletonOffset: request.skeletonOffset,
      },
    );

    if (!result) {
      // Distinguish between symbol-not-found vs file-not-found for clearer error messages
      const skConn = await getLadybugConn();
      const skSymbol = await ladybugDb.getSymbol(skConn, request.symbolId);
      if (!skSymbol) {
        throw new NotFoundError(
          `Symbol not found: ${request.symbolId}. Use sdl.symbol.search to find valid symbol IDs.`,
        );
      }
      const skFiles = await ladybugDb.getFilesByIds(skConn, [skSymbol.fileId]);
      const skFile = skFiles.get(skSymbol.fileId);
      if (!skFile) {
        throw new NotFoundError(
          `File record missing for symbol ${skSymbol.name} (${request.symbolId}). Try re-indexing with sdl.index.refresh.`,
        );
      }
      throw new NotFoundError(
        `File not found on disk: ${skFile.relPath}. The file may have been moved or deleted since last indexing.`,
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
            value: result.skeletonLinesConsumed ?? result.actualRange.endLine,
            parameter: "skeletonOffset",
          },
        }
      : undefined;

    const response = {
      skeleton: result.skeleton,
      file: file?.relPath || "",
      range: result.actualRange,
      estimatedTokens: result.estimatedTokens,
      originalLines: result.originalLines,
      truncated: result.truncated,
      truncation: skeletonTruncation,
    };

    const enrichedResponse = symbol
      ? attachRawContext(response, { fileIds: [symbol.fileId] })
      : response;
    const conditionalResponse = buildConditionalResponse(enrichedResponse, {
      ifNoneMatch: request.ifNoneMatch,
    });
    if ("notModified" in conditionalResponse) return conditionalResponse;
    return maybeApplySessionContentRef(conditionalResponse, {
      sessionId: context?.sessionId,
      refsMode: request.refsMode,
      key: `skeleton:${request.repoId}:${request.symbolId}:${request.skeletonOffset ?? 0}`,
      heavyField: "skeleton",
    }) as GetSkeletonResponse;
  } else if (request.file) {
    const result = await generateFileSkeleton(
      request.repoId,
      request.file,
      request.exportedOnly ?? false,
      {
        maxLines: effectiveMaxLines,
        maxTokens: effectiveMaxTokens,
        includeIdentifiers: request.identifiersToFind,
        skeletonOffset: request.skeletonOffset,
      },
    );

    if (!result) {
      throw new NotFoundError(`File not found or unparseable: ${request.file}`);
    }

    const skeletonTruncation = result.truncated
      ? {
          truncated: true,
          droppedCount:
            result.originalLines - result.skeleton.split("\n").length,
          howToResume: {
            type: "cursor" as const,
            value: result.skeletonLinesConsumed ?? result.actualRange.endLine,
            parameter: "skeletonOffset",
          },
        }
      : undefined;

    const response = {
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
    const enrichedResponse = fileRow
      ? attachRawContext(response, { fileIds: [fileRow.fileId] })
      : response;
    const conditionalResponse = buildConditionalResponse(enrichedResponse, {
      ifNoneMatch: request.ifNoneMatch,
    });
    if ("notModified" in conditionalResponse) return conditionalResponse;
    return maybeApplySessionContentRef(conditionalResponse, {
      sessionId: context?.sessionId,
      refsMode: request.refsMode,
      key: `skeleton:${request.repoId}:${request.file}:${request.skeletonOffset ?? 0}`,
      heavyField: "skeleton",
    }) as GetSkeletonResponse;
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
  context?: ToolContext,
): Promise<GetHotPathResponse> {
  const rawHotPathRequest = parseActionHandlerArgs(
    GetHotPathRequestSchema,
    args,
    normalizeCodeToolArgs,
  );

  const conn = await getLadybugConn();
  const resolvedHotPathSymbolId = await resolveCodeTargetSymbolId(
    conn,
    rawHotPathRequest.repoId,
    rawHotPathRequest,
    "sdl.code.getHotPath",
  );
  const { symbolRef: _symbolRef, ...rawRequestWithoutRef } = rawHotPathRequest;
  const request: ResolvedGetHotPathRequest = {
    ...rawRequestWithoutRef,
    symbolId: resolvedHotPathSymbolId,
  };

  recordToolTrace({
    repoId: request.repoId,
    taskType: "code",
    tool: "code.getHotPath",
    symbolId: request.symbolId,
    clientKey: context?.clientKey,
  });
  consumePrefetchedKey(
    request.repoId,
    `card:${request.symbolId}`,
    "search-cards",
    context,
  );

  // Enforce policy limits as caps on maxLines/maxTokens
  const hotPathAppConfig = loadConfig();
  const hotPathPolicyConfig = PolicyConfigSchema.safeParse(
    hotPathAppConfig.policy ?? {},
  );
  const hotPathPolicyMaxLines = hotPathPolicyConfig.success
    ? hotPathPolicyConfig.data.maxWindowLines
    : undefined;
  const hotPathPolicyMaxTokens = hotPathPolicyConfig.success
    ? hotPathPolicyConfig.data.maxWindowTokens
    : undefined;

  const result = await extractHotPath(
    request.repoId,
    request.symbolId,
    request.identifiersToFind,
    {
      maxLines: Math.min(
        request.maxLines ?? DEFAULT_MAX_LINES_HOTPATH,
        hotPathPolicyMaxLines ?? Infinity,
      ),
      maxTokens: Math.min(
        request.maxTokens ?? DEFAULT_MAX_TOKENS_HOTPATH,
        hotPathPolicyMaxTokens ?? Infinity,
      ),
      contextLines: request.contextLines ?? DEFAULT_CONTEXT_LINES,
    },
  );

  if (!result) {
    throw new IndexError(
      `Failed to extract hot-path for symbol: ${request.symbolId}`,
    );
  }

  const symbol = await ladybugDb.getSymbol(conn, request.symbolId);
  const fileData = symbol
    ? ((await ladybugDb.getFilesByIds(conn, [symbol.fileId])).get(
        symbol.fileId,
      ) ?? null)
    : null;

  // Report which identifiers were requested but not found
  const missedIdentifiers = request.identifiersToFind.filter(
    (id) => !result.matchedIdentifiers.includes(id),
  );

  const response = {
    excerpt: result.excerpt,
    file: fileData?.relPath ?? "",
    range: result.actualRange,
    estimatedTokens: result.estimatedTokens,
    matchedIdentifiers: result.matchedIdentifiers,
    matchedLineNumbers: result.matchedLineNumbers,
    ...(missedIdentifiers.length > 0
      ? {
          missedIdentifiers,
          missedIdentifierHint: `Hot paths match AST identifier names, not keywords or arbitrary text (for example, return). Use sdl.code.getSkeleton for control-flow structure; use sdl.symbol.search when an identifier name belongs to another symbol.`,
        }
      : {}),
    truncated: result.truncated,
  };
  const enrichedResponse = symbol
    ? attachRawContext(response, { fileIds: [symbol.fileId] })
    : response;
  const conditionalResponse = buildConditionalResponse(enrichedResponse, {
    ifNoneMatch: request.ifNoneMatch,
  });
  if ("notModified" in conditionalResponse) return conditionalResponse;
  return maybeApplySessionContentRef(conditionalResponse, {
    sessionId: context?.sessionId,
    refsMode: request.refsMode,
    key: `hotpath:${request.repoId}:${request.symbolId}:${request.identifiersToFind.join("|")}:${request.maxLines ?? ""}:${request.maxTokens ?? ""}:${request.contextLines ?? ""}`,
    heavyField: "excerpt",
  }) as GetHotPathResponse;
}
