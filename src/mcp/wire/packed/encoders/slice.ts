/**
 * `sl1` slice encoder for sdl.slice.build responses.
 *
 * Column ordering pivots on what agents read first: id → kind → name →
 * summary, so a truncate-parser can skip tail without losing pivot data.
 */

import type { GraphSlice } from "../../../types.js";
import { encodeSchemaDriven } from "../schema.js";
import type { TableSpec } from "../types.js";

const CARDS_SPEC: TableSpec = {
  tag: "c",
  key: "cards",
  columns: [
    { name: "id", type: "str" },
    { name: "f", type: "str", intern: true },
    { name: "k", type: "str" },
    { name: "n", type: "str" },
    { name: "e", type: "bool" },
    { name: "s", type: "str" },
    { name: "sum", type: "str" },
  ],
};

const EDGES_SPEC: TableSpec = {
  tag: "e",
  key: "edges",
  columns: [
    { name: "from", type: "str", intern: true },
    { name: "to", type: "str", intern: true },
    { name: "type", type: "str" },
    { name: "w", type: "float" },
  ],
};

const REFS_SPEC: TableSpec = {
  tag: "r",
  key: "cardRefs",
  columns: [
    { name: "symbolId", type: "str" },
    { name: "etag", type: "str" },
  ],
};

const FRONTIER_SPEC: TableSpec = {
  tag: "fr",
  key: "frontier",
  columns: [
    { name: "symbolId", type: "str" },
    { name: "score", type: "float" },
    { name: "why", type: "str" },
  ],
};

function flattenSignature(
  sig: { params?: Array<{ name: string; type?: string }> } | undefined | null,
): string {
  if (!sig) return "";
  const params = sig.params;
  if (!params || params.length === 0) return "";
  return "(" + params.map((p) => p.name + (p.type ?? "")).join(", ") + ")";
}

export function encodePackedSlice(slice: GraphSlice): string {
  const cardRows = slice.cards.map((card) => ({
    id: card.symbolId,
    f: card.file,
    k: card.kind,
    n: card.name,
    e: card.exported,
    s: flattenSignature(
      card.signature as
        | { params?: Array<{ name: string; type?: string }> }
        | undefined,
    ),
    sum: card.summary ?? "",
  }));

  const symbolIndex = slice.symbolIndex ?? [];
  const edgeRows = slice.edges.map(([from, to, type, weight]) => ({
    from: symbolIndex[from] ?? String(from),
    to: symbolIndex[to] ?? String(to),
    type,
    w: weight,
  }));

  const refRows = (slice.cardRefs ?? []).map((ref) => ({
    symbolId: ref.symbolId,
    etag: ref.etag,
  }));

  const frontierRows = (slice.frontier ?? []).map((item) => ({
    symbolId: item.symbolId,
    score: item.score,
    why: item.why,
  }));

  const legendCandidates = slice.cards.map((c) => c.file);

  return encodeSchemaDriven({
    toolName: "slice.build",
    encoderId: "sl1",
    scalars: {
      versionId: slice.versionId,
      sliceVersion: 3,
      frontierCount: frontierRows.length,
    },
    scalarTypes: {
      versionId: "str",
      sliceVersion: "int",
      frontierCount: "int",
    },
    tables: [
      { spec: CARDS_SPEC, rows: cardRows },
      { spec: EDGES_SPEC, rows: edgeRows },
      { spec: REFS_SPEC, rows: refRows },
      { spec: FRONTIER_SPEC, rows: frontierRows },
    ],
    legendCandidates,
  });
}

export const SLICE_ENCODER_ID = "sl1";
