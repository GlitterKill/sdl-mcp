/**
 * Window Loader port.
 *
 * Required by Code Window Enforcement (`enforceCodeWindow` in code/enforce.ts).
 * The presence of two adapters — `LadybugWindowLoader` (production) and
 * `FakeWindowLoader` (test fixture) — makes this a real seam, not a
 * hypothetical one.
 */

import { extractCodeWindow } from "./windows.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { getLadybugConn } from "../db/ladybug.js";
import type {
  CodeWindowResponseApproved,
  RepoId,
  SymbolId,
  SymbolKind,
  Visibility,
} from "../domain/types.js";
import type { SymbolRow } from "../db/schema.js";

export interface WindowLoader {
  loadWindow(
    repoId: RepoId,
    symbolId: SymbolId,
  ): Promise<CodeWindowResponseApproved | null>;
  getSymbol(symbolId: string): Promise<SymbolRow | null>;
}

const SYMBOL_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  "function",
  "class",
  "interface",
  "type",
  "module",
  "method",
  "constructor",
  "variable",
]);

const VISIBILITIES: ReadonlySet<Visibility> = new Set<Visibility>([
  "public",
  "protected",
  "private",
  "exported",
  "internal",
]);

function narrowSymbolKind(kind: string, symbolId: string): SymbolKind {
  if ((SYMBOL_KINDS as ReadonlySet<string>).has(kind)) {
    return kind as SymbolKind;
  }
  throw new Error(
    `Invalid SymbolKind "${kind}" for symbol ${symbolId} loaded from graph DB`,
  );
}

function narrowVisibility(
  visibility: string | null | undefined,
  symbolId: string,
): Visibility | null {
  if (visibility == null) return null;
  if ((VISIBILITIES as ReadonlySet<string>).has(visibility)) {
    return visibility as Visibility;
  }
  throw new Error(
    `Invalid Visibility "${visibility}" for symbol ${symbolId} loaded from graph DB`,
  );
}

export class LadybugWindowLoader implements WindowLoader {
  async loadWindow(
    repoId: RepoId,
    symbolId: SymbolId,
  ): Promise<CodeWindowResponseApproved | null> {
    const result = await extractCodeWindow(repoId, symbolId);
    if (!result || !result.approved) return null;
    return result;
  }

  async getSymbol(symbolId: string): Promise<SymbolRow | null> {
    const conn = await getLadybugConn();
    const symbol = await ladybugDb.getSymbol(conn, symbolId);
    if (!symbol) return null;
    return {
      symbol_id: symbol.symbolId,
      repo_id: symbol.repoId,
      file_id: 0,
      kind: narrowSymbolKind(symbol.kind, symbol.symbolId),
      name: symbol.name,
      exported: symbol.exported ? 1 : 0,
      visibility: narrowVisibility(symbol.visibility, symbol.symbolId),
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
}
