import type { GraphSlice } from "../types.js";
import type {
  CompactGraphSliceV3,
  CompactGroupedEdgeV3,
  SliceBuildWireFormat,
} from "../tools.js";
import { WireFormatRetiredError } from "../errors.js";
import {
  encodePackedSlice,
  decideFormatDetailed,
  isPackedEnabled,
  resolveThreshold,
  resolveTokenThreshold,
} from "../wire/packed/index.js";
import { estimateTokens, estimatePackedTokens } from "../../util/tokenize.js";
import type { WireFormatResult } from "../wire/packed/index.js";
import type { Visibility } from "../../domain/types.js";
import {
  AST_FINGERPRINT_COMPACT_WIRE_LENGTH,
  SYMBOL_ID_COMPACT_WIRE_LENGTH,
} from "../../config/constants.js";



const VISIBILITY_VALUES: readonly Visibility[] = [
  "public",
  "protected",
  "private",
  "exported",
  "internal",
] as const;


// --- Agent wire format types ---

export interface AgentWireCard {
  name: string;
  kind: string;
  file: string;
  lines: { start: number; end: number };
  exported: boolean;
  signature?: string;
  summary?: string;
  imports: Array<{ name: string; confidence?: number }>;
  calls: Array<{ name: string; confidence?: number }>;
}

export interface AgentWireEdge {
  from: string;
  to: string;
  type: string;
  confidence: number;
}

export interface AgentWireSlice {
  wireFormat: "agent";
  version: string;
  budget: { maxCards: number; maxTokens: number };
  seedSymbols: string[];
  cards: AgentWireCard[];
  edges: AgentWireEdge[];
  memories?: Array<{ memoryId: string; type: string; title: string; tags: string[] }>;
  frontier?: Array<{ name: string; file: string; why: string }>;
  truncation?: { truncated: boolean; totalAvailable: number; included: number };
}

function flattenSignature(sig: Record<string, unknown> | undefined): string | undefined {
  if (!sig) return undefined;
  const params = sig.params as Array<{ name: string; type?: string }> | undefined;
  if (!params || params.length === 0) {
    const name = sig.name as string | undefined;
    return name ?? undefined;
  }
  return "(" + params.map((p) => p.name + (p.type ?? "")).join(", ") + ")";
}

export function toAgentGraphSlice(slice: GraphSlice): AgentWireSlice {
  // Build symbolId -> card name map
  const idToName = new Map<string, string>();
  const idToFile = new Map<string, string>();
  for (const card of slice.cards) {
    idToName.set(card.symbolId, card.name);
    idToFile.set(card.symbolId, card.file);
  }

  const cardSymbolIds = new Set(slice.cards.map((c) => c.symbolId));

  // Build cards
  const cards: AgentWireCard[] = slice.cards.map((card) => ({
    name: card.name,
    kind: card.kind,
    file: card.file,
    lines: { start: card.range.startLine, end: card.range.endLine },
    exported: card.exported ?? false,
    signature: flattenSignature(card.signature as Record<string, unknown> | undefined),
    summary: card.summary ?? undefined,
    imports: (card.deps?.imports ?? []).map((dep) => ({
      name: idToName.get(dep.symbolId) ?? dep.symbolId,
      ...(dep.confidence != null && dep.confidence !== 1 ? { confidence: dep.confidence } : {}),
    })),
    calls: (card.deps?.calls ?? []).map((dep) => ({
      name: idToName.get(dep.symbolId) ?? dep.symbolId,
      ...(dep.confidence != null && dep.confidence !== 1 ? { confidence: dep.confidence } : {}),
    })),
  }));

  // Build edges with readable names
  const edges: AgentWireEdge[] = (slice.edges ?? []).map(([fromIdx, toIdx, type, weight]) => ({
    from: slice.cards[fromIdx]?.name ?? String(fromIdx),
    to: slice.cards[toIdx]?.name ?? String(toIdx),
    type: String(type),
    confidence: weight,
  }));

  // Filter memories to only those with linkedSymbols in the slice
  const filteredMemories = (slice.memories ?? [])
    .filter((m) =>
      m.linkedSymbols.length === 0 ||
      m.linkedSymbols.some((sid) => cardSymbolIds.has(sid)),
    )
    .map((m) => ({
      memoryId: m.memoryId,
      type: m.type,
      title: m.title,
      tags: m.tags,
    }));

  // Build seed symbols using names
  const seedSymbols = (slice.startSymbols ?? []).map(
    (sid) => idToName.get(sid) ?? sid,
  );

  const result: AgentWireSlice = {
    wireFormat: "agent",
    version: slice.versionId,
    budget: {
      maxCards: slice.budget.maxCards,
      maxTokens: slice.budget.maxEstimatedTokens,
    },
    seedSymbols,
    cards,
    edges,
  };

  if (filteredMemories.length > 0) {
    result.memories = filteredMemories;
  }

  if (slice.frontier && slice.frontier.length > 0) {
    result.frontier = slice.frontier.map((item) => ({
      name: idToName.get(item.symbolId) ?? item.symbolId,
      file: idToFile.get(item.symbolId) ?? "",
      why: item.why,
    }));
  }

  if (slice.truncation) {
    result.truncation = {
      truncated: slice.truncation.truncated,
      totalAvailable: slice.truncation.droppedCards + slice.cards.length,
      included: slice.cards.length,
    };
  }

  return result;
}

export function normalizeVisibility(
  value: string | null,
): Visibility | undefined {
  if (!value) return undefined;
  return (VISIBILITY_VALUES as readonly string[]).includes(value)
    ? (value as Visibility)
    : undefined;
}

export function serializeSliceForWireFormat(
  slice: GraphSlice,
  wireFormat: SliceBuildWireFormat,
  wireFormatVersion?: number,
  options?: {
    includeLegend?: boolean;
    packedThreshold?: number;
    packedTokenThreshold?: number;
    packedEnabled?: boolean;
  },
): WireFormatResult {
  if (wireFormatVersion === 1 || wireFormatVersion === 2) {
    throw new WireFormatRetiredError(wireFormatVersion);
  }

  if (wireFormat === "readable" || wireFormat === "standard") {
    return { format: wireFormat, payload: slice as unknown as object };
  }
  if (wireFormat === "agent") {
    return { format: "agent", payload: toAgentGraphSlice(slice) };
  }

  if (wireFormat === "packed" || wireFormat === "auto") {
    if (!isPackedEnabled(options?.packedEnabled)) {
      if (wireFormat === "packed") {
        throw new WireFormatRetiredError(0);
      }
      return { format: "compact", payload: toCompactGraphSliceV3(slice) };
    }
    const compact = toCompactGraphSliceV3(slice);
    const jsonStr = JSON.stringify(compact);
    const packedStr = encodePackedSlice(slice);
    const jsonTokens = estimateTokens(jsonStr);
    const packedTokens = estimatePackedTokens(packedStr);
    const detail = decideFormatDetailed(
      wireFormat,
      {
        jsonBytes: jsonStr.length,
        packedBytes: packedStr.length,
        jsonTokens,
        packedTokens,
      },
      resolveThreshold({ callThreshold: options?.packedThreshold }),
      resolveTokenThreshold({
        callTokenThreshold: options?.packedTokenThreshold,
      }),
    );
    if (detail.decision === "packed") {
      return {
        format: "packed",
        payload: packedStr,
        encoderId: "sl1",
        jsonBytes: jsonStr.length,
        packedBytes: packedStr.length,
        jsonTokens,
        packedTokens,
        axisHit: detail.axisHit ?? "bytes",
      };
    }
    return { format: "compact", payload: compact };

  }

  if (wireFormat === "compact") {
    return { format: "compact", payload: toCompactGraphSliceV3(slice) };
  }

  return { format: "standard", payload: slice as unknown as object };
}




/** Backward-compatible alias for v1 compact serializer. */



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

  if (slice.memories && slice.memories.length > 0) {
    compact.memories = slice.memories;
  }

  return compact;
}

