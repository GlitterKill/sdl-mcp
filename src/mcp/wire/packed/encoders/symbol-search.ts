/**
 * `ss1` symbol-search encoder for sdl.symbol.search responses.
 */

import { encodeSchemaDriven } from "../schema.js";
import type { TableSpec } from "../types.js";
import {
  aliasPackedSymbolId,
  appendIntroducedShortIds,
  packedShortIdsActive,
  type PackedShortIdOptions,
} from "../short-ids.js";

interface SymbolSearchHit {
  symbolId: string;
  file?: string;
  line?: number;
  kind?: string;
  score?: number;
  name?: string;
}

interface SymbolSearchInput {
  query?: string;
  total?: number;
  results: SymbolSearchHit[];
}

const HITS_SPEC: TableSpec = {
  tag: "h",
  key: "results",
  columns: [
    { name: "symbolId", type: "str", intern: true },
    { name: "file", type: "str", intern: true },
    { name: "line", type: "int" },
    { name: "kind", type: "str" },
    { name: "score", type: "float" },
    { name: "name", type: "str" },
  ],
};

export function encodePackedSymbolSearch(
  input: SymbolSearchInput,
  options: PackedShortIdOptions = {},
): string {
  const introduced = new Map<string, string>();
  const encoderId = packedShortIdsActive(options)
    ? SYMBOL_SEARCH_SHORT_ID_ENCODER_ID
    : SYMBOL_SEARCH_ENCODER_ID;
  const rows = input.results.map((r) => ({
    symbolId: aliasPackedSymbolId(r.symbolId, options, introduced),
    file: r.file ?? "",
    line: r.line ?? 0,
    kind: r.kind ?? "",
    score: r.score ?? 0,
    name: r.name ?? "",
  }));
  const payload = encodeSchemaDriven({
    toolName: "symbol.search",
    encoderId,
    scalars: {
      query: input.query ?? "",
      total: input.total ?? rows.length,
    },
    scalarTypes: { query: "str", total: "int" },
    tables: [{ spec: HITS_SPEC, rows }],
    legendCandidates: input.results
      .map((r) => r.file ?? "")
      .filter((f) => f.length > 0),
  });
  return appendIntroducedShortIds(payload, introduced, options);
}

export const SYMBOL_SEARCH_ENCODER_ID = "ss1";
export const SYMBOL_SEARCH_SHORT_ID_ENCODER_ID = "ss2";
