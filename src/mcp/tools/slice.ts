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
  SymbolSignature,
} from "../types.js";
import { buildSlice } from "../../graph/slice.js";
import {
  type SliceErrorResponse,
  sliceErrorToResponse,
} from "../../graph/slice/result.js";
import * as crypto from "crypto";
import { computeDelta } from "../../delta/diff.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { SymbolKind, Visibility } from "../../db/schema.js";
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
import { recordToolTrace } from "../../graph/prefetch-model.js";
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
import {
  createPolicyDenial,
  DatabaseError,
  ValidationError,
} from "../errors.js";
import { pickDepLabel } from "../../util/depLabels.js";
import {
  withSpan,
  SPAN_NAMES,
  isTracingEnabled,
  type SpanAttributes,
} from "../../util/tracing.js";
import { attachRawContext } from "../token-usage.js";

const VISIBILITY_VALUES: readonly Visibility[] = [
  "public",
  "protected",
  "private",
  "exported",
  "internal",
] as const;

function normalizeVisibility(value: string | null): Visibility | undefined {
  if (!value) return undefined;
  return (VISIBILITY_VALUES as readonly string[]).includes(value)
    ? (value as Visibility)
    : undefined;
}

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
      if (card.callResolution && card.callResolution.calls.length > 0) {
        compactCard.cr = card.callResolution.calls;
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

  if (slice.staleSymbols && slice.staleSymbols.length > 0) {
    compact.staleSymbols = slice.staleSymbols;
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
      if (card.callResolution && card.callResolution.calls.length > 0) {
        compactCard.cr = card.callResolution.calls;
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

  if (slice.staleSymbols && slice.staleSymbols.length > 0) {
    compact.staleSymbols = slice.staleSymbols;
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
      if (card.callResolution && card.callResolution.calls.length > 0) {
        compactCard.cr = card.callResolution.calls;
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

  if (slice.staleSymbols && slice.staleSymbols.length > 0) {
    compact.staleSymbols = slice.staleSymbols;
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
  // Validate that at least one entry hint is provided before parsing the full
  // request. This check must come first since taskText is now optional in the
  // schema and the internal handler relies on start-node resolution to proceed.
  const rawArgs = safeParseArgs(args);
  if (rawArgs !== null) {
    const a = args as Record<string, unknown>;
    const hasAnyEntryHint =
      (Array.isArray(a.entrySymbols) && a.entrySymbols.length > 0) ||
      Boolean(a.taskText) ||
      (Array.isArray(a.editedFiles) && a.editedFiles.length > 0) ||
      Boolean(a.stackTrace) ||
      Boolean(a.failingTestPath);

    if (!hasAnyEntryHint) {
      return sliceErrorToResponse({
        type: "no_symbols",
        repoId: rawArgs.repoId ?? "unknown",
      });
    }
  }

  try {
    return await handleSliceBuildInternal(args);
  } catch (error) {
    const parsed = safeParseArgs(args);

    if (error instanceof DatabaseError) {
      return sliceErrorToResponse({
        type: "invalid_repo",
        repoId: parsed?.repoId ?? "unknown",
      });
    }

    if (error instanceof ValidationError) {
      return sliceErrorToResponse({
        type: "no_version",
        repoId: parsed?.repoId ?? "unknown",
      });
    }

    // PolicyDenialError (from createPolicyDenial) has code === POLICY_ERROR
    const codeError = error as { code?: string };
    if (codeError.code === "POLICY_ERROR") {
      const message = error instanceof Error ? error.message : String(error);
      return sliceErrorToResponse({
        type: "policy_denied",
        reason: message.replace("Policy denied slice request: ", ""),
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    return sliceErrorToResponse({
      type: "internal",
      message,
    });
  }
}

function safeParseArgs(args: unknown): { repoId?: string } | null {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return null;
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
    minCallConfidence,
    includeResolutionMetadata,
  } = request;

  recordToolTrace({
    repoId,
    taskType: "slice",
    tool: "slice.build",
    symbolId: entrySymbols?.[0],
  });

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
    const conn = await getLadybugConn();

    const repo = await ladybugDb.getRepo(conn, repoId);
    if (!repo) {
      throw new DatabaseError(`Repository not found: ${repoId}`);
    }
    const repoConfig = JSON.parse(repo.configJson);
    const mergedPolicy = PolicyConfigSchema.parse({
      ...config.policy,
      ...(repoConfig.policy ?? {}),
    });
    const sliceBudgetDefaults = {
      maxCards: config.slice?.defaultMaxCards ?? DEFAULT_MAX_CARDS,
      maxEstimatedTokens:
        config.slice?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS_SLICE,
    };
    const policyEngine = new PolicyEngine();
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

    const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
    if (!latestVersion) {
      throw new ValidationError(
        `No version found for repo ${repoId}. Please run indexing first.`,
      );
    }

    const sliceRequest = {
      repoId,
      versionId: latestVersion.versionId,
      taskText,
      stackTrace,
      failingTestPath,
      editedFiles,
      entrySymbols,
      knownCardEtags,
      cardDetail,
      budget: effectiveBudget,
      minConfidence,
      minCallConfidence:
        minCallConfidence ?? mergedPolicy.defaultMinCallConfidence,
      includeResolutionMetadata,
    };

    const policyContext: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: request.repoId,
      versionId: latestVersion.versionId,
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
    const lease = createLease(latestVersion.versionId);
    const sliceEtag = createSliceEtag(
      handle,
      latestVersion.versionId,
      sliceHash,
    );

    const handleRow: ladybugDb.SliceHandleRow = {
      handle,
      repoId,
      createdAt: new Date().toISOString(),
      expiresAt: lease.expiresAt,
      minVersion: lease.minVersion,
      maxVersion: lease.maxVersion,
      sliceHash: sliceHash,
      spilloverRef: null,
    };

    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertSliceHandle(wConn, handleRow);
    });

    // For a fresh build, staleSymbols is always empty since we just built
    // from the current version. Assign explicitly to signal feature is active.
    slice.staleSymbols = [];

    const cardSymbolIds = slice.cards.map((c) => c.symbolId);
    const symbolMap = await ladybugDb.getSymbolsByIds(conn, cardSymbolIds);
    const fileIds = [
      ...new Set(Array.from(symbolMap.values()).map((s) => s.fileId)),
    ];

    const response = {
      sliceHandle: handle,
      ledgerVersion: latestVersion.versionId,
      lease,
      sliceEtag,
      slice: serializeSliceForWireFormat(
        slice,
        requestedWireFormat,
        effectiveWireFormatVersion,
      ),
    };
    attachRawContext(response, { fileIds });
    return response;
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

  const conn = await getLadybugConn();
  const handleRow = await ladybugDb.getSliceHandle(conn, sliceHandle);
  if (handleRow) {
    recordToolTrace({
      repoId: handleRow.repoId,
      taskType: "slice",
      tool: "slice.refresh",
    });
  }
  if (!handleRow) {
    throw new Error(`Slice handle not found: ${sliceHandle}`);
  }

  const now = new Date();
  if (new Date(handleRow.expiresAt) < now) {
    const error = createPolicyDenial(
      `Slice handle expired at ${handleRow.expiresAt}. NextBestAction: 'refreshSlice' or build new slice`,
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

  const latestVersion = await ladybugDb.getLatestVersion(
    conn,
    handleRow.repoId,
  );
  if (!latestVersion) {
    throw new Error(`No version found for repo ${handleRow.repoId}`);
  }

  if (knownVersion === latestVersion.versionId) {
    const lease = createLease(latestVersion.versionId);
    const newHandleRow: ladybugDb.SliceHandleRow = {
      ...handleRow,
      handle: sliceHandle,
      createdAt: new Date().toISOString(),
      expiresAt: lease.expiresAt,
      minVersion: handleRow.maxVersion,
      maxVersion: latestVersion.versionId,
    };
    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertSliceHandle(wConn, newHandleRow);
    });

    return {
      sliceHandle,
      knownVersion,
      currentVersion: latestVersion.versionId,
      notModified: true,
      delta: null,
      lease,
    };
  }

  const delta = await computeDelta(
    handleRow.repoId,
    knownVersion,
    latestVersion.versionId,
  );

  const lease = createLease(latestVersion.versionId);
  const newHandleRow: ladybugDb.SliceHandleRow = {
    ...handleRow,
    handle: sliceHandle,
    createdAt: new Date().toISOString(),
    expiresAt: lease.expiresAt,
    minVersion: knownVersion,
    maxVersion: latestVersion.versionId,
  };
  await withWriteConn(async (wConn) => {
    await ladybugDb.upsertSliceHandle(wConn, newHandleRow);
  });

  const response = {
    sliceHandle,
    knownVersion,
    currentVersion: latestVersion.versionId,
    notModified: false,
    delta: delta as DeltaPackWithGovernance | null,
    lease,
  };

  if (delta && delta.changedSymbols.length > 0) {
    const changedIds = delta.changedSymbols.map((c) => c.symbolId);
    const symbolMap = await ladybugDb.getSymbolsByIds(conn, changedIds);
    attachRawContext(response, {
      fileIds: [
        ...new Set(Array.from(symbolMap.values()).map((s) => s.fileId)),
      ],
    });
  }

  return response;
}

/**
 * Cleans up expired slice handles from the database.
 * Called periodically to remove stale handles.
 *
 * @returns Number of deleted handles
 */
export async function cleanupExpiredSliceHandles(): Promise<number> {
  const now = new Date().toISOString();
  return withWriteConn(async (wConn) => {
    return ladybugDb.deleteExpiredSliceHandles(wConn, now);
  });
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

  const conn = await getLadybugConn();
  const handleRow = await ladybugDb.getSliceHandle(conn, spilloverHandle);
  if (!handleRow) {
    throw new Error(`Spillover handle not found: ${spilloverHandle}`);
  }

  recordToolTrace({
    repoId: handleRow.repoId,
    taskType: "slice",
    tool: "slice.spillover",
  });

  if (!handleRow.spilloverRef) {
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
    droppedSymbols = JSON.parse(handleRow.spilloverRef);
  } catch (error) {
    throw new Error(
      `Failed to parse spillover_ref JSON for handle ${spilloverHandle}: ${String(error)}`,
      { cause: error },
    );
  }

  const startIndex = cursor ? parseInt(cursor, 10) : 0;
  if (Number.isNaN(startIndex) || startIndex < 0) {
    throw new Error(
      `Invalid cursor value: ${cursor} must be a non-negative integer`,
    );
  }
  const size = pageSize ?? SPILLOVER_DEFAULT_PAGE_SIZE;
  const endIndex = startIndex + size;

  const pageSymbols = droppedSymbols.slice(startIndex, endIndex);

  const symbolIds = pageSymbols.map((item) => item.symbolId);
  const symbolsById = await ladybugDb.getSymbolsByIds(conn, symbolIds);
  const pageFileIds = [
    ...new Set(Array.from(symbolsById.values()).map((s) => s.fileId)),
  ];
  const filesById = await ladybugDb.getFilesByIds(conn, pageFileIds);
  const metricsById = await ladybugDb.getMetricsBySymbolIds(conn, symbolIds);
  const edgesFromBySymbol = await ladybugDb.getEdgesFromSymbols(
    conn,
    symbolIds,
  );

  const allTargetIds = new Set<string>();
  for (const edges of edgesFromBySymbol.values()) {
    for (const edge of edges) {
      allTargetIds.add(edge.toSymbolId);
    }
  }
  const targetSymbolsById =
    allTargetIds.size > 0
      ? await ladybugDb.getSymbolsByIdsLite(conn, Array.from(allTargetIds))
      : new Map<string, { symbolId: string; name: string; kind: string }>();

  const spilloverFileIds: string[] = [];
  const symbols = pageSymbols
    .map((item) => {
      const symbolRow = symbolsById.get(item.symbolId);
      if (!symbolRow) return null;

      spilloverFileIds.push(symbolRow.fileId);
      const file = filesById.get(symbolRow.fileId) ?? null;
      const metrics = metricsById.get(item.symbolId) ?? null;

      const deps = {
        imports: [] as string[],
        calls: [] as string[],
      };

      const outgoingEdges = edgesFromBySymbol.get(item.symbolId) ?? [];
      for (const edge of outgoingEdges) {
        if (edge.edgeType === "import") {
          const depLabel = pickDepLabel(
            edge.toSymbolId,
            targetSymbolsById.get(edge.toSymbolId)?.name,
          );
          if (depLabel) deps.imports.push(depLabel);
        } else if (edge.edgeType === "call") {
          const depLabel = pickDepLabel(
            edge.toSymbolId,
            targetSymbolsById.get(edge.toSymbolId)?.name,
          );
          if (depLabel) deps.calls.push(depLabel);
        }
      }

      let signature: SymbolSignature = { name: symbolRow.name };
      if (symbolRow.signatureJson) {
        try {
          const parsed: unknown = JSON.parse(symbolRow.signatureJson);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const candidate = parsed as Partial<SymbolSignature>;
            signature = {
              ...candidate,
              name:
                typeof candidate.name === "string"
                  ? candidate.name
                  : symbolRow.name,
            };
          }
        } catch (error) {
          logger.warn("Failed to parse signatureJson JSON", {
            symbolId: item.symbolId,
            error: String(error),
          });
        }
      }

      let invariants: string[] | undefined;
      if (symbolRow.invariantsJson) {
        try {
          invariants = JSON.parse(symbolRow.invariantsJson);
        } catch (error) {
          logger.warn("Failed to parse invariantsJson JSON", {
            symbolId: item.symbolId,
            error: String(error),
          });
        }
      }

      let sideEffects: string[] | undefined;
      if (symbolRow.sideEffectsJson) {
        try {
          sideEffects = JSON.parse(symbolRow.sideEffectsJson);
        } catch (error) {
          logger.warn("Failed to parse sideEffectsJson JSON", {
            symbolId: item.symbolId,
            error: String(error),
          });
        }
      }

      let metricsData;
      if (metrics) {
        let testRefs: string[] | undefined;
        if (metrics.testRefsJson) {
          try {
            testRefs = JSON.parse(metrics.testRefsJson);
          } catch (error) {
            logger.warn("Failed to parse testRefsJson JSON", {
              symbolId: item.symbolId,
              error: String(error),
            });
          }
        }

        metricsData = {
          fanIn: metrics.fanIn,
          fanOut: metrics.fanOut,
          churn30d: metrics.churn30d,
          testRefs,
        };
      }

      return {
        symbolId: symbolRow.symbolId,
        repoId: symbolRow.repoId,
        file: file?.relPath ?? "",
        range: {
          startLine: symbolRow.rangeStartLine,
          startCol: symbolRow.rangeStartCol,
          endLine: symbolRow.rangeEndLine,
          endCol: symbolRow.rangeEndCol,
        },
        kind: symbolRow.kind as SymbolKind,
        name: symbolRow.name,
        exported: symbolRow.exported,
        visibility: normalizeVisibility(symbolRow.visibility),
        signature,
        summary: symbolRow.summary ?? undefined,
        invariants,
        sideEffects,
        deps,
        metrics: metricsData,
        version: {
          ledgerVersion: handleRow.maxVersion ?? "",
          astFingerprint: symbolRow.astFingerprint,
        },
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const hasMore = endIndex < droppedSymbols.length;
  const nextCursor = hasMore ? endIndex.toString() : undefined;

  const response = {
    spilloverHandle,
    cursor: nextCursor,
    hasMore,
    symbols,
  };
  attachRawContext(response, { fileIds: [...new Set(spilloverFileIds)] });
  return response;
}
