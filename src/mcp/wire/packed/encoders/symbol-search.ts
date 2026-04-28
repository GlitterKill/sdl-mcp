/**
 * `ss1` symbol-search encoder for sdl.symbol.search responses.
 */

import { encodeSchemaDriven } from "../schema.js";
import type { TableSpec } from "../types.js";

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

export function encodePackedSymbolSearch(input: SymbolSearchInput): string {
  const rows = input.results.map((r) => ({
    symbolId: r.symbolId,
    file: r.file ?? "",
    line: r.line ?? 0,
    kind: r.kind ?? "",
    score: r.score ?? 0,
    name: r.name ?? "",
  }));
  return encodeSchemaDriven({
    toolName: "symbol.search",
    encoderId: "ss1",
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
}

export const SYMBOL_SEARCH_ENCODER_ID = "ss1";
