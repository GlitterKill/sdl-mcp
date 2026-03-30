import type { GraphSlice } from "../types.js";
import type {
  CompactGraphSlice,
  CompactGraphSliceV2,
  CompactGraphSliceV3,
  CompactGroupedEdgeV3,
  SliceBuildWireFormat,
} from "../tools.js";
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
): GraphSlice | CompactGraphSlice | CompactGraphSliceV2 | CompactGraphSliceV3 | AgentWireSlice {
  if (wireFormat === "agent") {
    return toAgentGraphSlice(slice);
  }
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

  if (slice.memories && slice.memories.length > 0) {
    compact.memories = slice.memories;
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
  const filePaths: string[] = [];
  const filePathIndex = new Map<string, number>();
  for (const card of slice.cards) {
    if (!filePathIndex.has(card.file)) {
      filePathIndex.set(card.file, filePaths.length);
      filePaths.push(card.file);
    }
  }

  const edgeTypes = ["import", "call", "config"];
  const edgeTypeIndex = new Map(edgeTypes.map((t, i) => [t, i]));
  const symbolIdToIndex = new Map(slice.symbolIndex.map((id, i) => [id, i]));

  const compact: CompactGraphSliceV2 = {
    wf: "compact",
    wv: 2,
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

  if (slice.frontier && slice.frontier.length > 0) {
    compact.f = slice.frontier.map((item) => ({
      ci: symbolIdToIndex.get(item.symbolId) ?? -1,
      s: item.score,
      w: FRONTIER_WHY_CODES[item.why] ?? item.why,
    }));
  }

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

  if (slice.memories && slice.memories.length > 0) {
    compact.memories = slice.memories;
  }

  // Always include legend for compact wire format readability
  compact._legend = {
    wf: "wireFormat",
    wv: "wireFormatVersion",
    vid: "versionId",
    b: "budget (mc=maxCards, mt=maxTokens)",
    ss: "seedSymbols (first 16 chars of symbolId)",
    si: "sliceSymbolIds",
    fp: "filePaths",
    et: "edgeTypes",
    c: "cards (fi=fileIndex, r=range, k=kind, n=name, x=exported, d=deps, sig=signature, sum=summary, dl=detailLevel)",
    e: "edges [sourceCardIndex, targetCardIndex, edgeTypeIndex, confidence]",
    f: "frontier (ci=cardIndex, s=score, w=why: c=call/i=import)",
    t: "truncation (tr=truncated, dc=droppedCards, de=droppedEdges, res=resumeInfo)",
  };

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

  if (slice.memories && slice.memories.length > 0) {
    compact.memories = slice.memories;
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
    ...(v3.staleSymbols && v3.staleSymbols.length > 0 ? { staleSymbols: v3.staleSymbols } : {}),
    ...(v3.memories && v3.memories.length > 0 ? { memories: v3.memories } : {}),
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
