import type * as ladybugDb from "../../db/ladybug-queries.js";
import type { ExportedSymbolLite } from "../../db/ladybug-symbols.js";
import type { CallResolutionTelemetry } from "../edge-builder/telemetry.js";
import type { SymbolIndex, TsCallResolver } from "../edge-builder/types.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import type { ExtractedCall } from "../treesitter/extractCalls.js";
import type { ExtractedSymbol } from "../treesitter/extractSymbols.js";

export interface Pass2Target {
  repoId?: string;
  fileId?: string;
  filePath: string;
  extension: string;
  language: string;
}

export interface Pass2ResolverResult {
  edgesCreated: number;
}

/**
 * Per-file write submission used by every Pass-2 resolver. The dispatcher
 * decides how to materialise the write:
 *
 * - Sequential dispatch: call `withWriteConn` immediately so the resolver
 *   sees the same single-write-per-file behaviour as before.
 * - Parallel dispatch: stash `(symbolIdsToRefresh, edges)` in a per-batch
 *   buffer and flush ALL files in one `withWriteConn` after `Promise.all`
 *   settles. Cuts writeLimiter handshakes from O(filesPerBatch) to 1.
 *
 * Resolvers MUST call this exactly once per file when they have any
 * `symbolIdsToRefresh` (the in-memory dedup cleanup of `createdCallEdges`
 * happens inline before the call; only the SQL DELETE+INSERT is deferred).
 * Empty `edges` is permitted — the dispatcher will still issue the
 * incremental-mode DELETE so stale call edges are cleared even when the
 * file no longer emits any calls.
 */
export type SubmitEdgeWrite = (params: {
  symbolIdsToRefresh: string[];
  edges: ladybugDb.EdgeRow[];
}) => Promise<void>;

/**
 * Pass-level read cache populated once at the start of `runPass2Resolvers`
 * and reused by every resolver in the parallel batch. Eliminates the
 * per-import-statement `getFileByRepoPath` round-trip and the per-resolved-
 * file `getSymbolsByFile` round-trip that previously dominated pass-2 read
 * traffic — for a 1000-file TS repo with ~20 imports/file × ~1.5 candidate
 * paths each, that was ~30k point reads through the readPool every refresh.
 *
 * Both maps are read-only once handed to resolvers. They stay valid for the
 * full pass-2 run because no writes mutate `File` or `Symbol` rows during
 * pass-2 (writes are confined to call edges via `submitEdgeWrite`).
 */
export interface Pass2ImportCache {
  /** Repo-wide `relPath -> File` lookup. Replaces `getFileByRepoPath`. */
  fileByRelPath: Map<string, ladybugDb.FileRow>;
  /**
   * Per-file exported `(symbolId, name)` tuples. Replaces the
   * `getSymbolsByFile(...).filter(s => s.exported)` pattern in
   * `import-resolution.ts`. Populated only for files that have at least
   * one exported symbol — `Map.get` returning `undefined` is the
   * "no exports" answer.
   */
  exportedSymbolsByFileId: Map<string, ExportedSymbolLite[]>;
}

/**
 * Extraction outputs captured during pass-1 and reused by pass-2 to skip a
 * second tree-sitter parse + extraction pass on the JS main thread. Pass-1
 * already runs `adapter.parse` + `extractSymbols`/`extractImports`/
 * `extractCalls` for every file (the data it persists to LadybugDB) — the
 * pure-JS extraction outputs are deep-copied off the tree-sitter tree, so
 * they remain valid after `tree.delete()`.
 *
 * Currently populated only for files where the TS pass-2 resolver applies
 * (`isTsCallResolutionFile`). Other languages keep their inline re-parse
 * because their resolvers consume the live tree handle (e.g. python's
 * scope walker, java's call-scope index).
 */
export interface Pass1ExtractionEntry {
  /**
   * The shape `pass2.ts` builds via `extractedSymbols.map(...)`. `signature`
   * and `visibility` are optional to match `SymbolWithNodeId` (the rust /
   * worker-pool extraction shape) where these fields can be absent for
   * symbol kinds that lack them.
   */
  symbolsWithNodeIds: Array<{
    nodeId: string;
    kind: ExtractedSymbol["kind"];
    name: string;
    exported: boolean;
    range: ExtractedSymbol["range"];
    signature?: ExtractedSymbol["signature"];
    visibility?: ExtractedSymbol["visibility"];
  }>;
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  /**
   * Source content captured at parse time. The TS pass-2 resolver feeds it
   * to `resolveImportTargets` for the CommonJS `require()` regex sweep.
   * Holding it across pass-1→pass-2 costs ~5MB / 1000 typical TS files.
   */
  content: string;
}

/** `relPath -> Pass1ExtractionEntry` cache, owned by the pass-2 dispatcher. */
export type Pass1ExtractionCache = Map<string, Pass1ExtractionEntry>;

export interface Pass2ResolverContext {
  repoRoot: string;
  symbolIndex: SymbolIndex;
  tsResolver: TsCallResolver | null;
  languages: string[];
  createdCallEdges: Set<string>;
  globalNameToSymbolIds?: Map<string, string[]>;
  globalPreferredSymbolId?: Map<string, string>;
  telemetry?: CallResolutionTelemetry;
  cache?: Map<string, unknown>;
  /**
   * Indexer mode. Resolvers use this to skip clearing existing call edges
   * (`deleteOutgoingEdgesByTypeForSymbols`) on full-index runs since the
   * graph starts empty — the DELETE has to scan the unindexed
   * `DEPENDS_ON.edgeType` property and produces zero output, but still
   * occupies the writeLimiter slot for tens of seconds across thousands
   * of resolver invocations. Defaults to "incremental" if a caller
   * forgets to set it (safe default — does the work).
   */
  mode?: "full" | "incremental";
  /**
   * Dispatcher-provided write sink. Resolvers MUST call this once per file
   * (after building `edgesToInsert`) instead of calling `withWriteConn`
   * themselves — the dispatcher decides whether to flush immediately or
   * batch across the parallel-pass concurrency window. Always defined when
   * the dispatcher invokes a resolver; the optional marker is only there
   * so test fakes that construct contexts manually do not have to wire it.
   */
  submitEdgeWrite?: SubmitEdgeWrite;
  /**
   * Pass-level import cache populated once at dispatcher start. When
   * defined, `resolveImportTargets` skips `getFileByRepoPath` /
   * `getSymbolsByFile` round-trips and reads from the cache. Optional so
   * test fakes and the live-index draft path (which call resolvers
   * outside the dispatcher) can omit it and fall back to direct DB reads.
   */
  importCache?: Pass2ImportCache;
  /**
   * Pass-1 extraction cache. The TS pass-2 resolver checks this map keyed
   * by `relPath`; on hit, it skips the redundant tree-sitter parse + the
   * three `extract*` calls and reuses the data pass-1 already computed.
   * Other-language resolvers ignore this — they need the live tree handle
   * for scope walkers and call-scope indexes that operate on AST nodes.
   */
  pass1Extractions?: Pass1ExtractionCache;
}

export interface Pass2Resolver {
  readonly id: string;
  supports(target: Pass2Target): boolean;
  resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult>;
}
