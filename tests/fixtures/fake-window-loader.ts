/**
 * FakeWindowLoader — test fixture implementing the WindowLoader port.
 *
 * Lets enforce.ts unit tests run without a real LadybugDB or filesystem.
 * Two adapters of WindowLoader (this fake + LadybugWindowLoader) confirm
 * the port is a real seam, not a hypothetical one.
 *
 * The fixture imports the real `SymbolRow` type from `dist/db/schema.js`
 * (not a redeclared shape) so that schema additions surface as fixture
 * compile errors instead of silent structural-typing drift.
 */

import type { WindowLoader } from "../../dist/code/window-loader.js";
import type {
  CodeWindowResponseApproved,
  RepoId,
  SymbolId,
  SymbolKind,
  Visibility,
} from "../../dist/domain/types.js";
import type { SymbolRow } from "../../dist/db/schema.js";

export interface FakeWindowLoaderOptions {
  windows?: Map<string, CodeWindowResponseApproved>;
  symbols?: Map<string, SymbolRow>;
  failLoadFor?: Set<string>;
  failGetSymbolFor?: Set<string>;
}

export class FakeWindowLoader implements WindowLoader {
  private windows: Map<string, CodeWindowResponseApproved>;
  private symbols: Map<string, SymbolRow>;
  private failLoadFor: Set<string>;
  private failGetSymbolFor: Set<string>;
  public loadCalls: Array<{ repoId: RepoId; symbolId: SymbolId }> = [];
  public getSymbolCalls: string[] = [];

  constructor(opts: FakeWindowLoaderOptions = {}) {
    this.windows = opts.windows ?? new Map();
    this.symbols = opts.symbols ?? new Map();
    this.failLoadFor = opts.failLoadFor ?? new Set();
    this.failGetSymbolFor = opts.failGetSymbolFor ?? new Set();
  }

  async loadWindow(
    repoId: RepoId,
    symbolId: SymbolId,
  ): Promise<CodeWindowResponseApproved | null> {
    this.loadCalls.push({ repoId, symbolId });
    if (this.failLoadFor.has(symbolId)) return null;
    return this.windows.get(symbolId) ?? null;
  }

  async getSymbol(symbolId: string): Promise<SymbolRow | null> {
    this.getSymbolCalls.push(symbolId);
    if (this.failGetSymbolFor.has(symbolId)) return null;
    return this.symbols.get(symbolId) ?? null;
  }
}

export function buildFakeWindow(
  symbolId: string,
  code: string,
  opts: {
    repoId?: string;
    file?: string;
    startLine?: number;
    endLine?: number;
  } = {},
): CodeWindowResponseApproved {
  const startLine = opts.startLine ?? 1;
  const endLine = opts.endLine ?? code.split("\n").length;
  return {
    approved: true,
    repoId: opts.repoId ?? "test-repo",
    symbolId,
    file: opts.file ?? "src/test.ts",
    range: { startLine, startCol: 0, endLine, endCol: 0 },
    code,
    whyApproved: [],
    estimatedTokens: Math.ceil(code.length / 4),
  };
}

export function buildFakeSymbol(
  symbolId: string,
  name: string,
  opts: {
    repoId?: string;
    signatureParams?: string[];
    kind?: SymbolKind;
    visibility?: Visibility | null;
  } = {},
): SymbolRow {
  return {
    symbol_id: symbolId,
    repo_id: opts.repoId ?? "test-repo",
    file_id: 0,
    kind: opts.kind ?? "function",
    name,
    exported: 1,
    visibility: opts.visibility ?? "public",
    language: "ts",
    range_start_line: 1,
    range_start_col: 0,
    range_end_line: 10,
    range_end_col: 0,
    ast_fingerprint: `fp-${symbolId}`,
    signature_json: opts.signatureParams
      ? JSON.stringify({
          name,
          params: opts.signatureParams.map((p) => ({ name: p })),
        })
      : null,
    summary: null,
    invariants_json: null,
    side_effects_json: null,
    updated_at: "2026-05-01T00:00:00.000Z",
  };
}
