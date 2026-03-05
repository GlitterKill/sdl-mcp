import type { SymbolRow as LegacySymbolRow } from "../../db/schema.js";
import type { SymbolRow } from "../../db/kuzu-queries.js";

export function toLegacySymbolRow(symbol: SymbolRow): LegacySymbolRow {
  return {
    symbol_id: symbol.symbolId,
    repo_id: symbol.repoId,
    file_id: 0,
    kind: symbol.kind as LegacySymbolRow["kind"],
    name: symbol.name,
    exported: symbol.exported ? 1 : 0,
    visibility: symbol.visibility as LegacySymbolRow["visibility"],
    language: symbol.language,
    range_start_line: symbol.rangeStartLine,
    range_start_col: symbol.rangeStartCol,
    range_end_line: symbol.rangeEndLine,
    range_end_col: symbol.rangeEndCol,
    ast_fingerprint: symbol.astFingerprint,
    signature_json: symbol.signatureJson,
    summary: symbol.summary,
    invariants_json: symbol.invariantsJson,
    side_effects_json: symbol.sideEffectsJson,
    updated_at: symbol.updatedAt,
  };
}
