import {
  SliceBuildRequestSchema,
  SliceBuildResponse,
  SliceBuildWireFormat,
  CompactGraphSlice,
  CompactGraphSliceV2,
  CompactGraphSliceV3,
  CompactGroupedEdgeV3,
  SliceRefreshRequestSchema,
  SliceRefreshResponse,
  SliceSpilloverGetRequestSchema,
  SliceSpilloverGetResponse,
} from "../tools.js";
import type {
  GraphSlice,
  SliceHandle,
  SliceLease,
  SliceEtag,
  DeltaPackWithGovernance,
} from "../types.js";
import { buildSlice } from "../../graph/slice.js";
import {
  type SliceErrorResponse,
  sliceErrorToResponse,
} from "../../graph/slice/result.js";
import * as db from "../../db/queries.js";
import * as crypto from "crypto";
import type { SliceHandleRow } from "../../db/schema.js";
import { computeDelta } from "../../delta/diff.js";
import {
  PolicyEngine,
  type PolicyRequestContext,
} from "../../policy/engine.js";
import { logPolicyDecision } from "../telemetry.js";
import { logger } from "../../util/logger.js";
import {
  consumePrefetchedKey,
  prefetchSliceFrontier,
} from "../../graph/prefetch.js";
import {
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  SLICE_LEASE_TTL_MS,
  SPILLOVER_DEFAULT_PAGE_SIZE,
  AST_FINGERPRINT_COMPACT_WIRE_LENGTH,
  SYMBOL_ID_COMPACT_WIRE_LENGTH,
} from "../../config/constants.js";
import { loadConfig } from "../../config/loadConfig.js";
import { PolicyConfigSchema } from "../../config/types.js";
import { createPolicyDenial } from "../errors.js";
import { pickDepLabel } from "../../util/depLabels.js";
import {
  withSpan,
  SPAN_NAMES,
  isTracingEnabled,
  type SpanAttributes,
} from "../../util/tracing.js";

const policyEngine = new PolicyEngine();

function clampInt(value: number, min: number, max: number): number {
  const v = Math.trunc(value);
  return Math.max(min, Math.min(max, v));
}

/**
 * Generates a unique slice handle identifier.
 *
 * @returns 32-character hex string representing the slice handle
 * @internal
 */
function generateSliceHandle(): SliceHandle {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Generates a hash of the slice content for ETag validation.
 * Hash includes repoId, versionId, sorted start symbols, budget, and card count.
 *
 * @param slice - Graph slice to hash
 * @returns SHA-256 hash hex string
 * @internal
 */
function generateSliceHash(slice: GraphSlice): string {
  const canonical = JSON.stringify({
    repoId: slice.repoId,
    versionId: slice.versionId,
    startSymbols: slice.startSymbols.sort(),
    budget: slice.budget,
    cardCount: slice.cards.length,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Creates a lease for a slice handle with 1-hour TTL.
 *
 * @param ledgerVersion - Current ledger version string
 * @returns Slice lease with expiration and version bounds
 * @internal
 */
function createLease(ledgerVersion: string): SliceLease {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SLICE_LEASE_TTL_MS);
  return {
    expiresAt: expiresAt.toISOString(),
    minVersion: null,
    maxVersion: ledgerVersion,
  };
}

/**
 * Creates an ETag object for slice cache validation.
 *
 * @param handle - Slice handle identifier
 * @param version - Ledger version string
 * @param sliceHash - Hash of slice content
 * @returns Slice ETag object
 * @internal
 */
function createSliceEtag(
  handle: SliceHandle,
  version: string,
  sliceHash: string,
): SliceEtag {
  return {
    handle,
    version,
    sliceHash,
  };
}

function serializeSliceForWireFormat(
  slice: GraphSlice,
  wireFormat: SliceBuildWireFormat,
  wireFormatVersion?: number,
): GraphSlice | CompactGraphSlice | CompactGraphSliceV2 | CompactGraphSliceV3 {
  if (wireFormat === "compact") {
    if (wireFormatVersion === 1) {
      return toCompactGraphSliceV1(slice);
    } else if (wireFormatVersion === 3) {
      return toCompactGraphSliceV3(slice);
    }
    return toCompactGraphSliceV2(slice);
  }
  return slice;
}

export function toCompactGraphSliceV1(slice: GraphSlice): CompactGraphSlice {
  const compact: CompactGraphSlice = {
    wf: "compact",
    wv: 1,
    rid: slice.repoId,
    vid: slice.versionId,
    b: {
      mc: slice.budget.maxCards,
      mt: slice.budget.maxEstimatedTokens,
    },
    ss: slice.startSymbols,
    si: slice.symbolIndex,
    c: slice.cards.map((card) => {
      const compactCard: CompactGraphSlice["c"][number] = {
        sid: card.symbolId,
        f: card.file,
        r: [
          card.range.startLine,
          card.range.startCol,
          card.range.endLine,
          card.range.endCol,
        ],
        k: card.kind,
        n: card.name,
        x: card.exported,
        d: {
          i: card.deps.imports,
          c: card.deps.calls,
        },
        af: card.version.astFingerprint,
      };

      if (card.visibility) compactCard.v = card.visibility;
      if (card.signature) compactCard.sig = card.signature;
      if (card.summary) compactCard.sum = card.summary;
      if (card.invariants && card.invariants.length > 0) {
        compactCard.inv = card.invariants;
      }
      if (card.sideEffects && card.sideEffects.length > 0) {
        compactCard.se = card.sideEffects;
      }
      if (card.metrics) {
        const metrics: CompactGraphSlice["c"][number]["m"] = {};
        if (card.metrics.fanIn !== undefined) metrics.fi = card.metrics.fanIn;
        if (card.metrics.fanOut !== undefined) metrics.fo = card.metrics.fanOut;
        if (card.metrics.churn30d !== undefined)
          metrics.ch = card.metrics.churn30d;
        if (card.metrics.testRefs && card.metrics.testRefs.length > 0) {
          metrics.t = card.metrics.testRefs;
        }
        if (Object.keys(metrics).length > 0) {
          compactCard.m = metrics;
        }
      }
      if (card.detailLevel && card.detailLevel !== "compact") {
        compactCard.dl = card.detailLevel;
      }

      return compactCard;
    }),
    e: slice.edges,
  };

  if (slice.cardRefs && slice.cardRefs.length > 0) {
    type CompactCardRef = NonNullable<CompactGraphSlice["cr"]>[number];
    compact.cr = slice.cardRefs.map((ref) => {
      const compactRef: CompactCardRef = {
        sid: ref.symbolId,
        e: ref.etag,
      };
      if (ref.detailLevel !== "compact") {
        compactRef.dl = ref.detailLevel;
      }
      return compactRef;
    });
  }

  if (slice.frontier && slice.frontier.length > 0) {
    compact.f = slice.frontier.map((item) => ({
      sid: item.symbolId,
      s: item.score,
      w: item.why,
    }));
  }

  if (slice.truncation) {
    const truncation: CompactGraphSlice["t"] = {
      tr: slice.truncation.truncated,
      dc: slice.truncation.droppedCards,
      de: slice.truncation.droppedEdges,
    };
    if (slice.truncation.howToResume) {
      truncation.res = {
        t: slice.truncation.howToResume.type,
        v: slice.truncation.howToResume.value,
      };
    }
    compact.t = truncation;
  }

  return compact;
}

/** Backward-compatible alias for v1 compact serializer. */
export const toCompactGraphSlice = toCompactGraphSliceV1;

const FRONTIER_WHY_CODES: Record<string, string> = {
  calls: "c",
  imports: "i",
  configures: "cf",
  "entry symbol": "e",
  "entry sibling": "es",
  "entry dependency": "ed",
  "stack trace": "st",
  "failing test": "ft",
  "edited file": "ef",
  "task text": "tt",
};

export function toCompactGraphSliceV2(slice: GraphSlice): CompactGraphSliceV2 {
  // Build file path lookup table (#2: deduplicate file paths)
  const filePaths: string[] = [];
  const filePathIndex = new Map<string, number>();
  for (const card of slice.cards) {
    if (!filePathIndex.has(card.file)) {
      filePathIndex.set(card.file, filePaths.length);
      filePaths.push(card.file);
    }
  }

  // Edge type lookup table (#5: integer edge types)
  const edgeTypes = ["import", "call", "config"];
  const edgeTypeIndex = new Map(edgeTypes.map((t, i) => [t, i]));

  // SymbolId to index mapping (#6: cards are positional)
  const symbolIdToIndex = new Map(slice.symbolIndex.map((id, i) => [id, i]));

  const compact: CompactGraphSliceV2 = {
    wf: "compact",
    vid: slice.versionId,
    b: {
      mc: slice.budget.maxCards,
      mt: slice.budget.maxEstimatedTokens,
    },
    ss: slice.startSymbols.map((id) =>
      id.slice(0, SYMBOL_ID_COMPACT_WIRE_LENGTH),
    ),
    si: slice.symbolIndex.map((id) =>
      id.slice(0, SYMBOL_ID_COMPACT_WIRE_LENGTH),
    ),
    fp: filePaths,
    et: slice.edges.length > 0 ? edgeTypes : undefined,
    c: slice.cards.map((card) => {
      const compactCard: CompactGraphSliceV2["c"][number] = {
        fi: filePathIndex.get(card.file) ?? 0,
        r: [
          card.range.startLine,
          card.range.startCol,
          card.range.endLine,
          card.range.endCol,
        ],
        k: card.kind,
        n: card.name,
        x: card.exported,
        d: {
          i: card.deps.imports,
          c: card.deps.calls,
        },
      };

      if (card.detailLevel === "full") {
        compactCard.af = card.version.astFingerprint.slice(
          0,
          AST_FINGERPRINT_COMPACT_WIRE_LENGTH,
        );
      }

      if (card.visibility) compactCard.v = card.visibility;
      if (card.signature) compactCard.sig = card.signature;
      if (card.summary) compactCard.sum = card.summary;
      if (card.invariants && card.invariants.length > 0) {
        compactCard.inv = card.invariants;
      }
      if (card.sideEffects && card.sideEffects.length > 0) {
        compactCard.se = card.sideEffects;
      }
      if (card.metrics) {
        const metrics: CompactGraphSliceV2["c"][number]["m"] = {};
        if (card.metrics.fanIn !== undefined) metrics.fi = card.metrics.fanIn;
        if (card.metrics.fanOut !== undefined) metrics.fo = card.metrics.fanOut;
        if (card.metrics.churn30d !== undefined)
          metrics.ch = card.metrics.churn30d;
        if (card.metrics.testRefs && card.metrics.testRefs.length > 0) {
          metrics.t = card.metrics.testRefs;
        }
        if (Object.keys(metrics).length > 0) {
          compactCard.m = metrics;
        }
      }
      if (card.detailLevel && card.detailLevel !== "compact") {
        compactCard.dl = card.detailLevel;
      }

      return compactCard;
    }),
    e: slice.edges.map(([from, to, type, weight]) => [
      from,
      to,
      edgeTypeIndex.get(type) ?? 0,
      weight,
    ]),
  };

  // Card refs with index refs (#6)
  if (slice.cardRefs && slice.cardRefs.length > 0) {
    type CompactCardRefV2 = NonNullable<CompactGraphSliceV2["cr"]>[number];
    compact.cr = slice.cardRefs.map((ref) => {
      const compactRef: CompactCardRefV2 = {
        ci: symbolIdToIndex.get(ref.symbolId) ?? -1,
        e: ref.etag,
      };
      if (ref.detailLevel !== "compact") {
        compactRef.dl = ref.detailLevel;
      }
      return compactRef;
    });
  }

  // Frontier with index refs and why codes (#6, #7)
  if (slice.frontier && slice.frontier.length > 0) {
    compact.f = slice.frontier.map((item) => ({
      ci: symbolIdToIndex.get(item.symbolId) ?? -1,
      s: item.score,
      w: FRONTIER_WHY_CODES[item.why] ?? item.why,
    }));
  }

  // Only attach truncation when actually truncated (#12)
  if (slice.truncation?.truncated) {
    const truncation: NonNullable<CompactGraphSliceV2["t"]> = {
      tr: true,
      dc: slice.truncation.droppedCards,
      de: slice.truncation.droppedEdges,
    };
    if (slice.truncation.howToResume) {
      truncation.res = {
        t: slice.truncation.howToResume.type,
        v: slice.truncation.howToResume.value,
      };
    }
    compact.t = truncation;
  }

  return compact;
}

export function toCompactGraphSliceV3(slice: GraphSlice): CompactGraphSliceV3 {
  const filePaths: string[] = [];
  const filePathIndex = new Map<string, number>();
  for (const card of slice.cards) {
    if (!filePathIndex.has(card.file)) {
      filePathIndex.set(card.file, filePaths.length);
      filePaths.push(card.file);
    }
  }

  const edgeTypes = ["import", "call", "config"];
  const symbolIdToIndex = new Map(slice.symbolIndex.map((id, i) => [id, i]));

  const groupedEdges = new Map<
    number,
    { c: number[]; i: number[]; cf: number[] }
  >();

  for (const [from, to, type, _weight] of slice.edges) {
    if (!groupedEdges.has(from)) {
      groupedEdges.set(from, { c: [], i: [], cf: [] });
    }
    const group = groupedEdges.get(from)!;
    if (type === "import") {
      group.i.push(to);
    } else if (type === "call") {
      group.c.push(to);
    } else {
      group.cf.push(to);
    }
  }

  const compactEdges: CompactGroupedEdgeV3[] = [];
  for (const [from, targets] of groupedEdges) {
    const edge: CompactGroupedEdgeV3 = { from };
    if (targets.c.length > 0) edge.c = targets.c;
    if (targets.i.length > 0) edge.i = targets.i;
    if (targets.cf.length > 0) edge.cf = targets.cf;
    compactEdges.push(edge);
  }

  const compact: CompactGraphSliceV3 = {
    wf: "compact",
    wv: 3,
    vid: slice.versionId,
    b: {
      mc: slice.budget.maxCards,
      mt: slice.budget.maxEstimatedTokens,
    },
    ss: slice.startSymbols.map((id) =>
      id.slice(0, SYMBOL_ID_COMPACT_WIRE_LENGTH),
    ),
    si: slice.symbolIndex.map((id) =>
      id.slice(0, SYMBOL_ID_COMPACT_WIRE_LENGTH),
    ),
    fp: filePaths,
    et: slice.edges.length > 0 ? edgeTypes : undefined,
    c: slice.cards.map((card) => {
      const compactCard: CompactGraphSliceV3["c"][number] = {
        fi: filePathIndex.get(card.file) ?? 0,
        r: [
          card.range.startLine,
          card.range.startCol,
          card.range.endLine,
          card.range.endCol,
        ],
        k: card.kind,
        n: card.name,
        x: card.exported,
        d: {
          i: card.deps.imports,
          c: card.deps.calls,
        },
      };

      if (card.detailLevel === "full") {
        compactCard.af = card.version.astFingerprint.slice(
          0,
          AST_FINGERPRINT_COMPACT_WIRE_LENGTH,
        );
      }

      if (card.visibility) compactCard.v = card.visibility;
      if (card.signature) compactCard.sig = card.signature;
      if (card.summary) compactCard.sum = card.summary;
      if (card.invariants && card.invariants.length > 0) {
        compactCard.inv = card.invariants;
      }
      if (card.sideEffects && card.sideEffects.length > 0) {
        compactCard.se = card.sideEffects;
      }
      if (card.metrics) {
        const metrics: CompactGraphSliceV3["c"][number]["m"] = {};
        if (card.metrics.fanIn !== undefined) metrics.fi = card.metrics.fanIn;
        if (card.metrics.fanOut !== undefined) metrics.fo = card.metrics.fanOut;
        if (card.metrics.churn30d !== undefined)
          metrics.ch = card.metrics.churn30d;
        if (card.metrics.testRefs && card.metrics.testRefs.length > 0) {
          metrics.t = card.metrics.testRefs;
        }
        if (Object.keys(metrics).length > 0) {
          compactCard.m = metrics;
        }
      }
      if (card.detailLevel && card.detailLevel !== "compact") {
        compactCard.dl = card.detailLevel;
      }

      return compactCard;
    }),
    e: compactEdges,
  };

  if (slice.cardRefs && slice.cardRefs.length > 0) {
    type CompactCardRefV2 = NonNullable<CompactGraphSliceV3["cr"]>[number];
    compact.cr = slice.cardRefs.map((ref) => {
      const compactRef: CompactCardRefV2 = {
        ci: symbolIdToIndex.get(ref.symbolId) ?? -1,
        e: ref.etag,
      };
      if (ref.detailLevel !== "compact") {
        compactRef.dl = ref.detailLevel;
      }
      return compactRef;
    });
  }

  if (slice.frontier && slice.frontier.length > 0) {
    compact.f = slice.frontier.map((item) => ({
      ci: symbolIdToIndex.get(item.symbolId) ?? -1,
      s: item.score,
      w: FRONTIER_WHY_CODES[item.why] ?? item.why,
    }));
  }

  if (slice.truncation?.truncated) {
    const truncation: NonNullable<CompactGraphSliceV3["t"]> = {
      tr: true,
      dc: slice.truncation.droppedCards,
      de: slice.truncation.droppedEdges,
    };
    if (slice.truncation.howToResume) {
      truncation.res = {
        t: slice.truncation.howToResume.type,
        v: slice.truncation.howToResume.value,
      };
    }
    compact.t = truncation;
  }

  return compact;
}

export function decodeCompactGraphSliceV3ToV2(
  v3: CompactGraphSliceV3,
): CompactGraphSliceV2 {
  const v2Edges: Array<[number, number, number, number]> = [];
  for (const edge of v3.e) {
    if (edge.i) {
      for (const to of edge.i) {
        v2Edges.push([edge.from, to, 0, 1]);
      }
    }
    if (edge.c) {
      for (const to of edge.c) {
        v2Edges.push([edge.from, to, 1, 1]);
      }
    }
    if (edge.cf) {
      for (const to of edge.cf) {
        v2Edges.push([edge.from, to, 2, 1]);
      }
    }
  }

  return {
    wf: "compact",
    wv: 2,
    vid: v3.vid,
    b: v3.b,
    ss: v3.ss,
    si: v3.si,
    fp: v3.fp,
    et: v3.et,
    c: v3.c,
    cr: v3.cr,
    e: v2Edges,
    f: v3.f,
    t: v3.t,
  };
}

export function decodeCompactEdgesV2ToV1(
  edges: Array<[number, number, number, number]>,
  edgeTypes?: string[],
): Array<[number, number, "import" | "call" | "config", number]> {
  const types = edgeTypes ?? ["import", "call", "config"];
  return edges.map(([from, to, typeIdx, weight]) => [
    from,
    to,
    (types[typeIdx] ?? "import") as "import" | "call" | "config",
    weight,
  ]);
}

export function decodeCompactEdgesV3ToV1(
  edges: CompactGroupedEdgeV3[],
  edgeTypes?: string[],
): Array<[number, number, "import" | "call" | "config", number]> {
  const types = edgeTypes ?? ["import", "call", "config"];
  const result: Array<[number, number, "import" | "call" | "config", number]> =
    [];

  for (const edge of edges) {
    if (edge.i) {
      for (const to of edge.i) {
        result.push([edge.from, to, types[0] as "import", 1]);
      }
    }
    if (edge.c) {
      for (const to of edge.c) {
        result.push([edge.from, to, types[1] as "call", 1]);
      }
    }
    if (edge.cf) {
      for (const to of edge.cf) {
        result.push([edge.from, to, types[2] as "config", 1]);
      }
    }
  }

  return result;
}

/**
 * Handles graph slice build requests.
 * Creates a new slice handle with configurable entry points and budget.
 * Supports policy evaluation and lease-based caching.
 *
 * @param args - Raw arguments containing repoId, task context, and slice parameters
 * @returns Slice build response with handle, lease, ETag, and slice data
 */
export async function handleSliceBuild(
  args: unknown,
): Promise<SliceBuildResponse | SliceErrorResponse> {
  try {
    return await handleSliceBuildInternal(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("Repository not found")) {
      const parsed = safeParseArgs(args);
      return sliceErrorToResponse({
        type: "invalid_repo",
        repoId: parsed?.repoId ?? "unknown",
      });
    }

    if (message.includes("No version found")) {
      const parsed = safeParseArgs(args);
      return sliceErrorToResponse({
        type: "no_version",
        repoId: parsed?.repoId ?? "unknown",
      });
    }

    if (message.includes("Policy denied")) {
      return sliceErrorToResponse({
        type: "policy_denied",
        reason: message.replace("Policy denied slice request: ", ""),
      });
    }

    return sliceErrorToResponse({
      type: "internal",
      message,
    });
  }
}

function safeParseArgs(args: unknown): { repoId?: string } | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  return typeof a.repoId === "string" ? { repoId: a.repoId } : null;
}

async function handleSliceBuildInternal(
  args: unknown,
): Promise<SliceBuildResponse> {
  const request = SliceBuildRequestSchema.parse(args);
  const {
    repoId,
    taskText,
    stackTrace,
    failingTestPath,
    editedFiles,
    entrySymbols,
    knownCardEtags,
    cardDetail,
    wireFormat,
    wireFormatVersion,
    budget,
    minConfidence,
  } = request;

  const buildSliceWithTracing = async (): Promise<SliceBuildResponse> => {
    const requestedWireFormat: SliceBuildWireFormat = wireFormat ?? "compact";
    const effectiveWireFormatVersion =
      requestedWireFormat === "compact" ? (wireFormatVersion ?? 2) : undefined;

    const config = loadConfig();

    if (entrySymbols && entrySymbols.length > 0) {
      for (const symbolId of entrySymbols) {
        consumePrefetchedKey(repoId, `slice:${symbolId}`);
      }
    }
    const repo = db.getRepo(repoId);
    if (!repo) {
      throw new Error(`Repository not found: ${repoId}`);
    }
    const repoConfig = JSON.parse(repo.config_json);
    const mergedPolicy = PolicyConfigSchema.parse({
      ...config.policy,
      ...(repoConfig.policy ?? {}),
    });
    const sliceBudgetDefaults = {
      maxCards: config.slice?.defaultMaxCards ?? DEFAULT_MAX_CARDS,
      maxEstimatedTokens:
        config.slice?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS_SLICE,
    };
    policyEngine.updateConfig({
      maxWindowLines: mergedPolicy.maxWindowLines,
      maxWindowTokens: mergedPolicy.maxWindowTokens,
      requireIdentifiers: mergedPolicy.requireIdentifiers,
      allowBreakGlass: mergedPolicy.allowBreakGlass,
      budgetCaps: sliceBudgetDefaults,
    });

    const policyCaps = policyEngine.getConfig().budgetCaps;
    const requestedBudget = budget ?? {};
    const effectiveBudget = {
      maxCards: clampInt(
        requestedBudget.maxCards ?? sliceBudgetDefaults.maxCards,
        1,
        policyCaps.maxCards,
      ),
      maxEstimatedTokens: clampInt(
        requestedBudget.maxEstimatedTokens ??
          sliceBudgetDefaults.maxEstimatedTokens,
        1,
        policyCaps.maxEstimatedTokens,
      ),
    };
    if (
      (requestedBudget.maxCards &&
        requestedBudget.maxCards > policyCaps.maxCards) ||
      (requestedBudget.maxEstimatedTokens &&
        requestedBudget.maxEstimatedTokens > policyCaps.maxEstimatedTokens)
    ) {
      logger.warn("Clamped slice budget to policy caps", {
        repoId,
        requestedBudget,
        effectiveBudget,
        policyCaps,
      });
    }

    const latestVersion = db.getLatestVersion(repoId);
    if (!latestVersion) {
      throw new Error(
        `No version found for repo ${repoId}. Please run indexing first.`,
      );
    }

    const sliceRequest = {
      repoId,
      versionId: latestVersion.version_id,
      taskText,
      stackTrace,
      failingTestPath,
      editedFiles,
      entrySymbols,
      knownCardEtags,
      cardDetail,
      budget: effectiveBudget,
      minConfidence,
    };

    const policyContext: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: request.repoId,
      versionId: latestVersion.version_id,
      budget: effectiveBudget,
    };

    const policyDecision = policyEngine.evaluate(policyContext);
    const { nextBestAction, requiredFieldsForNext } =
      policyEngine.generateNextBestAction(policyDecision, policyContext);

    logPolicyDecision({
      requestType: policyContext.requestType,
      repoId: policyContext.repoId,
      decision: policyDecision.decision,
      auditHash: policyDecision.auditHash,
      evidenceUsed: policyDecision.evidenceUsed,
      deniedReasons: policyDecision.deniedReasons,
      nextBestAction,
      requiredFieldsForNext,
      context: policyContext,
    });

    if (policyDecision.decision === "deny") {
      const error = createPolicyDenial(
        `Policy denied slice request: ${policyDecision.deniedReasons?.join(", ")}`,
        nextBestAction,
        requiredFieldsForNext,
      );
      throw error;
    }

    const slice: GraphSlice = await buildSlice(sliceRequest);
    const frontierSeeds =
      entrySymbols && entrySymbols.length > 0
        ? entrySymbols
        : slice.cards.slice(0, 12).map((card) => card.symbolId);
    prefetchSliceFrontier(repoId, frontierSeeds);

    const handle = generateSliceHandle();
    const sliceHash = generateSliceHash(slice);
    const lease = createLease(latestVersion.version_id);
    const sliceEtag = createSliceEtag(
      handle,
      latestVersion.version_id,
      sliceHash,
    );

    const handleRow: SliceHandleRow = {
      handle,
      repo_id: repoId,
      created_at: new Date().toISOString(),
      expires_at: lease.expiresAt,
      min_version: lease.minVersion,
      max_version: lease.maxVersion,
      slice_hash: sliceHash,
      spillover_ref: null,
    };

    db.createSliceHandle(handleRow);

    return {
      sliceHandle: handle,
      ledgerVersion: latestVersion.version_id,
      lease,
      sliceEtag,
      slice: serializeSliceForWireFormat(
        slice,
        requestedWireFormat,
        effectiveWireFormatVersion,
      ),
    };
  };

  if (isTracingEnabled()) {
    const attrs: SpanAttributes = {
      repoId,
      budget: budget ?? {},
    };
    if (entrySymbols && entrySymbols.length > 0) {
      attrs.entrySymbolsCount = entrySymbols.length;
    }
    return withSpan(
      SPAN_NAMES.SLICE_BUILD,
      async (span) => {
        const result = await buildSliceWithTracing();
        if ("slice" in result && result.slice) {
          const sliceData = result.slice as CompactGraphSliceV2;
          span.setAttributes({
            "counts.cards": "c" in sliceData ? sliceData.c.length : 0,
            "counts.edges": "e" in sliceData ? (sliceData.e?.length ?? 0) : 0,
            versionId: result.ledgerVersion,
          });
        }
        return result;
      },
      attrs,
    );
  }

  return buildSliceWithTracing();
}

/**
 * Handles slice refresh requests.
 * Refreshes an existing slice handle and returns delta if version changed.
 * Updates lease expiration and tracks version bounds.
 *
 * @param args - Raw arguments containing sliceHandle and knownVersion
 * @returns Slice refresh response with updated lease and delta if applicable
 * @throws {Error} If handle not found or expired
 */
export async function handleSliceRefresh(
  args: unknown,
): Promise<SliceRefreshResponse> {
  const request = SliceRefreshRequestSchema.parse(args);
  const { sliceHandle, knownVersion } = request;

  const handleRow = db.getSliceHandle(sliceHandle);
  if (!handleRow) {
    throw new Error(`Slice handle not found: ${sliceHandle}`);
  }

  const now = new Date();
  if (new Date(handleRow.expires_at) < now) {
    const error = createPolicyDenial(
      `Slice handle expired at ${handleRow.expires_at}. NextBestAction: 'refreshSlice' or build new slice`,
      "refreshSlice",
      {
        refreshSlice: {
          sliceHandle,
          knownVersion,
        },
      },
    );
    throw error;
  }

  const latestVersion = db.getLatestVersion(handleRow.repo_id);
  if (!latestVersion) {
    throw new Error(`No version found for repo ${handleRow.repo_id}`);
  }

  if (knownVersion === latestVersion.version_id) {
    const lease = createLease(latestVersion.version_id);
    db.deleteSliceHandle(sliceHandle);
    const newHandleRow: SliceHandleRow = {
      ...handleRow,
      handle: sliceHandle,
      created_at: new Date().toISOString(),
      expires_at: lease.expiresAt,
      min_version: handleRow.max_version,
      max_version: latestVersion.version_id,
    };
    db.createSliceHandle(newHandleRow);

    return {
      sliceHandle,
      knownVersion,
      currentVersion: latestVersion.version_id,
      notModified: true,
      delta: null,
      lease,
    };
  }

  const delta = computeDelta(
    handleRow.repo_id,
    knownVersion,
    latestVersion.version_id,
  );

  const lease = createLease(latestVersion.version_id);
  db.deleteSliceHandle(sliceHandle);
  const newHandleRow: SliceHandleRow = {
    ...handleRow,
    handle: sliceHandle,
    created_at: new Date().toISOString(),
    expires_at: lease.expiresAt,
    min_version: knownVersion,
    max_version: latestVersion.version_id,
  };
  db.createSliceHandle(newHandleRow);

  return {
    sliceHandle,
    knownVersion,
    currentVersion: latestVersion.version_id,
    notModified: false,
    delta: delta as DeltaPackWithGovernance | null,
    lease,
  };
}

/**
 * Cleans up expired slice handles from the database.
 * Called periodically to remove stale handles.
 *
 * @returns Number of deleted handles
 */
export function cleanupExpiredSliceHandles(): number {
  const now = new Date().toISOString();
  return db.deleteExpiredSliceHandles(now);
}

/**
 * Handles spillover symbol retrieval requests.
 * Fetches symbols that were dropped from a slice in pages.
 * Supports pagination via cursor and optional page size.
 *
 * @param args - Raw arguments containing spilloverHandle, cursor, and pageSize
 * @returns Paged response with symbols and pagination metadata
 * @throws {Error} If spillover handle not found
 */
export async function handleSliceSpilloverGet(
  args: unknown,
): Promise<SliceSpilloverGetResponse> {
  const request = SliceSpilloverGetRequestSchema.parse(args);
  const { spilloverHandle, cursor, pageSize } = request;

  const handleRow = db.getSliceHandle(spilloverHandle);
  if (!handleRow) {
    throw new Error(`Spillover handle not found: ${spilloverHandle}`);
  }

  if (!handleRow.spillover_ref) {
    return {
      spilloverHandle,
      cursor: undefined,
      hasMore: false,
      symbols: [],
    };
  }

  let droppedSymbols: Array<{
    symbolId: string;
    reason: string;
    priority: "must" | "should" | "optional";
  }>;

  try {
    droppedSymbols = JSON.parse(handleRow.spillover_ref);
  } catch (error) {
    throw new Error(
      `Failed to parse spillover_ref JSON for handle ${spilloverHandle}: ${String(error)}`,
    );
  }

  const startIndex = cursor ? parseInt(cursor, 10) : 0;
  if (Number.isNaN(startIndex) || startIndex < 0) {
    throw new Error(`Invalid cursor value: ${cursor} must be a non-negative integer`);
  }
  const size = pageSize ?? SPILLOVER_DEFAULT_PAGE_SIZE;
  const endIndex = startIndex + size;

  const pageSymbols = droppedSymbols.slice(startIndex, endIndex);

  const symbols = pageSymbols
    .map((item) => {
      const symbolRow = db.getSymbol(item.symbolId);
      if (!symbolRow) return null;

      const file = db.getFile(symbolRow.file_id);
      const metrics = db.getMetrics(item.symbolId);

      const deps = {
        imports: [] as string[],
        calls: [] as string[],
      };

      const outgoingEdges = db.getEdgesFrom(item.symbolId);
      const targetSymbolIds = Array.from(
        new Set(outgoingEdges.map((edge) => edge.to_symbol_id)),
      );
      const targetSymbolsById =
        targetSymbolIds.length > 0
          ? db.getSymbolsByIdsLite(targetSymbolIds)
          : new Map<string, { symbol_id: string; name: string }>();

      for (const edge of outgoingEdges) {
        if (edge.type === "import") {
          const depLabel = pickDepLabel(
            edge.to_symbol_id,
            targetSymbolsById.get(edge.to_symbol_id)?.name,
          );
          if (depLabel) {
            deps.imports.push(depLabel);
          }
        } else if (edge.type === "call") {
          const depLabel = pickDepLabel(
            edge.to_symbol_id,
            targetSymbolsById.get(edge.to_symbol_id)?.name,
          );
          if (depLabel) {
            deps.calls.push(depLabel);
          }
        }
      }

      let signature;
      if (symbolRow.signature_json) {
        try {
          signature = JSON.parse(symbolRow.signature_json);
        } catch (error) {
          logger.warn("Failed to parse signature_json JSON", {
            symbolId: item.symbolId,
            error: String(error),
          });
          signature = { name: symbolRow.name };
        }
      } else {
        signature = { name: symbolRow.name };
      }

      let invariants: string[] | undefined;
      if (symbolRow.invariants_json) {
        try {
          invariants = JSON.parse(symbolRow.invariants_json);
        } catch (error) {
          logger.warn("Failed to parse invariants_json JSON", {
            symbolId: item.symbolId,
            error: String(error),
          });
        }
      }

      let sideEffects: string[] | undefined;
      if (symbolRow.side_effects_json) {
        try {
          sideEffects = JSON.parse(symbolRow.side_effects_json);
        } catch (error) {
          logger.warn("Failed to parse side_effects_json JSON", {
            symbolId: item.symbolId,
            error: String(error),
          });
        }
      }

      let metricsData;
      if (metrics) {
        let testRefs: string[] | undefined;
        if (metrics.test_refs_json) {
          try {
            testRefs = JSON.parse(metrics.test_refs_json);
          } catch (error) {
            logger.warn("Failed to parse test_refs_json JSON", {
              symbolId: item.symbolId,
              error: String(error),
            });
          }
        }

        metricsData = {
          fanIn: metrics.fan_in,
          fanOut: metrics.fan_out,
          churn30d: metrics.churn_30d,
          testRefs,
        };
      }

      return {
        symbolId: symbolRow.symbol_id,
        repoId: symbolRow.repo_id,
        file: file?.rel_path ?? "",
        range: {
          startLine: symbolRow.range_start_line,
          startCol: symbolRow.range_start_col,
          endLine: symbolRow.range_end_line,
          endCol: symbolRow.range_end_col,
        },
        kind: symbolRow.kind,
        name: symbolRow.name,
        exported: symbolRow.exported === 1,
        visibility: symbolRow.visibility ?? undefined,
        signature,
        summary: symbolRow.summary ?? undefined,
        invariants,
        sideEffects,
        deps,
        metrics: metricsData,
        version: {
          ledgerVersion: handleRow.max_version ?? "",
          astFingerprint: symbolRow.ast_fingerprint,
        },
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const hasMore = endIndex < droppedSymbols.length;
  const nextCursor = hasMore ? endIndex.toString() : undefined;

  return {
    spilloverHandle,
    cursor: nextCursor,
    hasMore,
    symbols,
  };
}
