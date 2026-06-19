// Engine parity harness runner (Task 1.13).
//
// Parses a fixture with BOTH the TypeScript Pass-1 engine (via the language
// adapter registry) and the Rust Pass-1 engine (via parseFilesRust), then
// returns field-level diffs under a documented allowlist. Used by the
// engine-parity integration test to walk every fixture and assert parity.
//
// Avoids the heavy processFile() pipeline (Ladybug DB, import resolution,
// summariser) — calls adapter.extractSymbols/extractImports/extractCalls
// directly so we only compare raw Pass-1 output.

import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import {
  getAdapterForExtension,
  loadBuiltInAdapters,
} from "../../dist/indexer/adapter/registry.js";
import type { LanguageAdapter } from "../../dist/indexer/adapter/LanguageAdapter.js";
import type { ExtractedCall, ExtractedSymbol } from "../../dist/indexer/treesitter/extractCalls.js";
import type { ExtractedImport } from "../../dist/indexer/treesitter/extractImports.js";
import {
  isRustEngineAvailable,
  parseFilesRust,
  type RustExtractedSymbol,
  type RustParseResult,
} from "../../dist/indexer/rustIndexer.js";
import type { FileMetadata } from "../../dist/indexer/fileScanner.js";

export interface ParityDiff {
  kind: "missing-in-rust" | "extra-in-rust" | "field-mismatch";
  index: number;
  path: string;
  ts?: unknown;
  rust?: unknown;
}

export interface ParityResult {
  symbolDiffs: ParityDiff[];
  importDiffs: ParityDiff[];
  callDiffs: ParityDiff[];
  skipped?: string;
}

// Exclude because: Kotlin has no published tree-sitter-kotlin Rust crate;
// the native engine falls back to TS for .kt / .kts, so parity is trivially
// satisfied via fallback rather than side-by-side extraction.
const RUST_UNSUPPORTED_EXTENSIONS = new Set(["kt", "kts"]);

// Exclude because: RustExtractedSymbol adds compile-time enrichment
// (fingerprints, summaries, role tags, search text). The TS Pass-1 engine
// never computes these fields, so they would always diff.
const SYMBOL_FIELD_EXCLUDES = new Set<string>([
  "symbolId",        // Exclude because: Rust-only fingerprint hash.
  "nodeId",          // Exclude because: TS/Rust encode node ids differently.
  "astFingerprint",  // Exclude because: Rust-only enrichment.
  "summary",         // Exclude because: Rust-only enrichment.
  "invariantsJson",  // Exclude because: Rust-only enrichment (JSON string).
  "sideEffectsJson", // Exclude because: Rust-only enrichment (JSON string).
  "roleTagsJson",    // Exclude because: Rust-only enrichment (JSON string).
  "roleTags",        // Exclude because: Rust-only role tags pre-serialise.
  "searchText",      // Exclude because: Rust-only enrichment.
]);

// Exclude because: isResolved / calleeSymbolId / candidateCount are Pass-2
// concerns. mapNativeCall always emits isResolved=false with no
// calleeSymbolId; TS extractCalls may populate them via a local symbolMap.
const CALL_FIELD_EXCLUDES = new Set<string>([
  "isResolved",
  "calleeSymbolId",
  "callerNodeId",
  "candidateCount",
]);

type HasRange = { range: { startLine: number; startCol: number } };

function sortByRange<T extends HasRange & { name?: string; calleeIdentifier?: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => {
    if (a.range.startLine !== b.range.startLine) return a.range.startLine - b.range.startLine;
    if (a.range.startCol !== b.range.startCol) return a.range.startCol - b.range.startCol;
    return (a.name ?? a.calleeIdentifier ?? "").localeCompare(b.name ?? b.calleeIdentifier ?? "");
  });
}

// Exclude because: ExtractedImport has no range field; sort by specifier for
// a deterministic order.
function sortImports(arr: ExtractedImport[]): ExtractedImport[] {
  return [...arr].sort((a, b) => a.specifier.localeCompare(b.specifier));
}

function symbolOwnerKey(sym: ExtractedSymbol | RustExtractedSymbol): string {
  return `${sym.kind}:${sym.name}@${sym.range.startLine}:${sym.range.startCol}`;
}

interface OwnerEntry {
  key: string;
  range: ExtractedSymbol["range"] | RustExtractedSymbol["range"];
}

type OwnerIndex = Map<string, OwnerEntry[]>;

function addOwner(owners: OwnerIndex, id: string, entry: OwnerEntry): void {
  const existing = owners.get(id);
  if (existing) {
    existing.push(entry);
  } else {
    owners.set(id, [entry]);
  }
}

function buildNodeOwnerMap(symbols: Array<ExtractedSymbol | RustExtractedSymbol>): OwnerIndex {
  const owners: OwnerIndex = new Map();
  for (const sym of symbols) {
    const entry: OwnerEntry = { key: symbolOwnerKey(sym), range: sym.range };
    addOwner(owners, entry.key, entry);
    const nodeId = (sym as { nodeId?: unknown }).nodeId;
    if (typeof nodeId === "string" && nodeId.length > 0) {
      addOwner(owners, nodeId, entry);
    }
  }
  addOwner(owners, "global", { key: "<module>", range: { startLine: 0, startCol: 0, endLine: Number.MAX_SAFE_INTEGER, endCol: 0 } });
  addOwner(owners, "<module>", { key: "<module>", range: { startLine: 0, startCol: 0, endLine: Number.MAX_SAFE_INTEGER, endCol: 0 } });
  return owners;
}

function ownerContainsCall(owner: OwnerEntry, call: ExtractedCall): boolean {
  const startsBefore =
    owner.range.startLine < call.range.startLine ||
    (owner.range.startLine === call.range.startLine && owner.range.startCol <= call.range.startCol);
  const endsAfter =
    owner.range.endLine > call.range.endLine ||
    (owner.range.endLine === call.range.endLine && owner.range.endCol >= call.range.endCol);
  return startsBefore && endsAfter;
}

function rangeSize(range: OwnerEntry["range"]): number {
  return ((range.endLine - range.startLine) * 1_000_000) + (range.endCol - range.startCol);
}

function projectCallerOwner(call: ExtractedCall, owners: OwnerIndex): string | undefined {
  const callerNodeId = (call as { callerNodeId?: unknown }).callerNodeId;
  if (callerNodeId === undefined || callerNodeId === null || callerNodeId === "") {
    return undefined;
  }
  if (typeof callerNodeId !== "string") {
    return String(callerNodeId);
  }
  const candidates = owners.get(callerNodeId);
  if (!candidates || candidates.length === 0) {
    return `unresolved:${callerNodeId}`;
  }
  if (candidates.length === 1) {
    return candidates[0]!.key;
  }
  const containing = candidates
    .filter((owner) => ownerContainsCall(owner, call))
    .sort((a, b) => rangeSize(a.range) - rangeSize(b.range));
  return (containing[0] ?? candidates[0])!.key;
}

function projectSymbol(sym: ExtractedSymbol | RustExtractedSymbol): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sym)) {
    if (SYMBOL_FIELD_EXCLUDES.has(k)) continue;
    if (k === "signature" && v && typeof v === "object") {
      // Exclude because: TS/Rust may differ on whitespace inside param types
      // (e.g. "Foo<Bar,Baz>" vs "Foo<Bar, Baz>"); normalise whitespace.
      const sig = v as { params?: Array<{ name: string; type?: string }>; returns?: string; generics?: string[] };
      out.signature = {
        params: sig.params?.map((p) => ({
          name: p.name,
          type: typeof p.type === "string" ? p.type.replace(/\s+/g, " ").trim() : p.type,
        })),
        returns: sig.returns,
        generics: sig.generics,
      };
      continue;
    }
    // Exclude because: TS may omit decorators entirely when none, Rust may
    // emit an empty array; treat [] and undefined as equal.
    if (k === "decorators" && Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

function projectCall(call: ExtractedCall, owners: OwnerIndex): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(call)) {
    if (CALL_FIELD_EXCLUDES.has(k)) continue;
    out[k] = v;
  }
  out.callerOwner = projectCallerOwner(call, owners);
  return out;
}

// Exclude because: treat undefined vs missing as equal for optional fields.
function projectImport(i: ExtractedImport): Record<string, unknown> {
  return {
    specifier: i.specifier,
    isRelative: i.isRelative,
    isExternal: i.isExternal,
    imports: i.imports,
    defaultImport: i.defaultImport ?? undefined,
    namespaceImport: i.namespaceImport ?? undefined,
    isReExport: i.isReExport,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      if (ao[k] === undefined && bo[k] === undefined) continue;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

function diffArrays<T>(
  ts: T[],
  rust: T[],
  project: (v: T, side: "ts" | "rust") => Record<string, unknown>,
  labelOf: (v: T) => string,
): ParityDiff[] {
  const diffs: ParityDiff[] = [];
  const len = Math.max(ts.length, rust.length);
  for (let i = 0; i < len; i++) {
    if (i >= rust.length) {
      diffs.push({ kind: "missing-in-rust", index: i, path: labelOf(ts[i]!), ts: project(ts[i]!, "ts") });
      continue;
    }
    if (i >= ts.length) {
      diffs.push({ kind: "extra-in-rust", index: i, path: labelOf(rust[i]!), rust: project(rust[i]!, "rust") });
      continue;
    }
    const a = project(ts[i]!, "ts");
    const b = project(rust[i]!, "rust");
    if (!deepEqual(a, b)) {
      diffs.push({ kind: "field-mismatch", index: i, path: labelOf(ts[i]!), ts: a, rust: b });
    }
  }
  return diffs;
}

export async function runEngineParityCheck(fixturePath: string, repoRoot: string): Promise<ParityResult> {
  loadBuiltInAdapters();

  const absFixture = resolve(fixturePath);
  const absRepoRoot = resolve(repoRoot);
  const ext = absFixture.split(".").pop()?.toLowerCase() ?? "";
  // Registry stores extensions with a leading dot (.ts, .c); fixtures
  // only give us the bare suffix (ts, c).
  const adapter: LanguageAdapter | null = getAdapterForExtension(`.${ext}`);
  if (!adapter) {
    return { symbolDiffs: [], importDiffs: [], callDiffs: [], skipped: `no-adapter:${ext}` };
  }

  const content = readFileSync(absFixture, "utf8");

  // TS Pass-1
  const tree = adapter.parse(content, absFixture);
  if (!tree) return { symbolDiffs: [], importDiffs: [], callDiffs: [], skipped: "ts-parse-failed" };
  const tsSymbols = adapter.extractSymbols(tree, content, absFixture) as ExtractedSymbol[];
  const tsImports = adapter.extractImports(tree, content, absFixture);
  const tsCalls = adapter.extractCalls(tree, content, absFixture, tsSymbols);

  // Rust Pass-1
  if (!isRustEngineAvailable()) {
    return { symbolDiffs: [], importDiffs: [], callDiffs: [], skipped: "native-addon-unavailable" };
  }
  if (RUST_UNSUPPORTED_EXTENSIONS.has(ext)) {
    return { symbolDiffs: [], importDiffs: [], callDiffs: [], skipped: `rust-unsupported:${ext}` };
  }
  const relPath = relative(absRepoRoot, absFixture).split(sep).join("/");
  const fileMeta: FileMetadata = { path: relPath, size: Buffer.byteLength(content, "utf8"), mtime: Date.now() };
  const rustResults = parseFilesRust("parity-harness", absRepoRoot, [fileMeta]);
  if (!rustResults || rustResults.length === 0 || rustResults[0] === null) {
    return { symbolDiffs: [], importDiffs: [], callDiffs: [], skipped: "rust-returned-null" };
  }
  const rustResult: RustParseResult = rustResults[0]!;
  if (rustResult.parseError) {
    return { symbolDiffs: [], importDiffs: [], callDiffs: [], skipped: `rust-parse-error` };
  }

  const tsOwnerMap = buildNodeOwnerMap(tsSymbols);
  const rustOwnerMap = buildNodeOwnerMap(rustResult.symbols);

  return {
    symbolDiffs: diffArrays(
      sortByRange(tsSymbols),
      sortByRange(rustResult.symbols),
      projectSymbol,
      (s) => `${s.kind}:${s.name}@${s.range.startLine}:${s.range.startCol}`,
    ),
    importDiffs: diffArrays(
      sortImports(tsImports),
      sortImports(rustResult.imports),
      projectImport,
      (i) => `import:${i.specifier}`,
    ),
    callDiffs: diffArrays(
      sortByRange(tsCalls),
      sortByRange(rustResult.calls),
      (call, side) => projectCall(call, side === "ts" ? tsOwnerMap : rustOwnerMap),
      (c) => `call:${c.calleeIdentifier}@${c.range.startLine}:${c.range.startCol}`,
    ),
  };
}
