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
 * - Sequential dispatch: preserve single-file resolver execution order, but
 *   buffer submissions and drain them in bounded write batches.
 * - Parallel dispatch: stash `(symbolIdsToRefresh, edges)` in a per-batch
 *   buffer and flush ALL files in one `withWriteConn` after `Promise.all`
 *   settles.
 *
 * Treat this as a logical submission, not a durability/commit boundary.
 * The returned promise only means the dispatcher accepted the submission for
 * its current write batch; the dispatcher owns the later LadybugDB drain.
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
}) => void | Promise<void>;

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
  /**
   * Optional provider-row-backed exported symbol details. Python pass-2 uses
   * these fields to map imported classes to their exported methods without
   * issuing one `getSymbolsByFile` read per imported target. Missing map
   * entries are not authoritative; resolvers fall back to DB reads for files
   * that were not preloaded.
   */
  exportedFullSymbolsByFileId?: Map<string, Pass2ExportedSymbolFull[]>;
}

export interface Pass2ExportedSymbolFull extends ExportedSymbolLite {
  repoId: string;
  fileId: string;
  kind: string;
  exported: boolean;
  language: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
}

/**
 * Extraction outputs captured during pass-1 and reused by pass-2 to skip a
 * second tree-sitter parse + extraction pass on the JS main thread. Pass-1
 * already runs `adapter.parse` + `extractSymbols`/`extractImports`/
 * `extractCalls` for every file (the data it persists to LadybugDB) — the
 * pure-JS extraction outputs are deep-copied off the tree-sitter tree, so
 * they remain valid after `tree.delete()`.
 *
 * Populated for TS/JS pass-2 files and C++ files. TS/JS reuses the full
 * extraction. C++ reuses only imports/content for include-index construction:
 * its pass-2 resolver keeps resolver-local call/symbol extraction because
 * generic pass-1 C++ calls are not edge-equivalent to pass-2 C++ calls.
 * Other languages keep their inline re-parse because their resolvers consume
 * the live tree handle (e.g. python's scope walker, java's call-scope index).
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

export const PASS1_EXTRACTION_CACHE_MAX_ENTRIES = 2000;
export const PASS1_EXTRACTION_C_SOURCE_PROTECTED_MAX_BYTES = 16 * 1024 * 1024;
const PASS1_EXTRACTION_C_SOURCE_PROTECTED_EXTENSIONS = new Set([".c", ".h"]);

type Pass1ExtractionCacheEntryMeta = {
  protected: boolean;
  contentBytes: number;
  bucket: Pass1ExtractionCacheBucket;
};

export type Pass1ExtractionCacheBucket =
  | "c"
  | "h"
  | "cc"
  | "cpp"
  | "hpp"
  | "other";

export interface Pass1ExtractionCacheBucketStats {
  entries: number;
  bytes: number;
  stores: number;
  storeBytes: number;
  evictions: number;
  evictionBytes: number;
}

type Pass1ExtractionCacheMeta = {
  entries: Map<string, Pass1ExtractionCacheEntryMeta>;
  storedPaths: Set<string>;
  storedBytesByPath: Map<string, number>;
  protectedBytes: number;
  unprotectedEntries: number;
  protectedStores: number;
  protectedStoreBytes: number;
  unprotectedStores: number;
  unprotectedStoreBytes: number;
  protectedEvictions: number;
  protectedEvictionBytes: number;
  unprotectedEvictions: number;
  unprotectedEvictionBytes: number;
  buckets: Record<Pass1ExtractionCacheBucket, Pass1ExtractionCacheBucketStats>;
};

const pass1ExtractionCacheMeta = new WeakMap<
  Pass1ExtractionCache,
  Pass1ExtractionCacheMeta
>();

function emptyPass1ExtractionBucketStats(): Pass1ExtractionCacheBucketStats {
  return {
    entries: 0,
    bytes: 0,
    stores: 0,
    storeBytes: 0,
    evictions: 0,
    evictionBytes: 0,
  };
}

function emptyPass1ExtractionBuckets(): Record<
  Pass1ExtractionCacheBucket,
  Pass1ExtractionCacheBucketStats
> {
  return {
    c: emptyPass1ExtractionBucketStats(),
    h: emptyPass1ExtractionBucketStats(),
    cc: emptyPass1ExtractionBucketStats(),
    cpp: emptyPass1ExtractionBucketStats(),
    hpp: emptyPass1ExtractionBucketStats(),
    other: emptyPass1ExtractionBucketStats(),
  };
}

function extensionForRelPath(relPath: string): string {
  const normalized = relPath.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex >= 0 ? basename.slice(dotIndex).toLowerCase() : "";
}

function bucketForRelPath(relPath: string): Pass1ExtractionCacheBucket {
  switch (extensionForRelPath(relPath)) {
    case ".c":
      return "c";
    case ".h":
      return "h";
    case ".cc":
      return "cc";
    case ".cpp":
      return "cpp";
    case ".hpp":
      return "hpp";
    default:
      return "other";
  }
}

function isProtectedCSourceExtraction(relPath: string): boolean {
  return PASS1_EXTRACTION_C_SOURCE_PROTECTED_EXTENSIONS.has(
    extensionForRelPath(relPath),
  );
}

function extractionContentBytes(entry: Pass1ExtractionEntry): number {
  return Buffer.byteLength(entry.content, "utf8");
}

function getPass1ExtractionCacheMeta(
  cache: Pass1ExtractionCache,
): Pass1ExtractionCacheMeta {
  let meta = pass1ExtractionCacheMeta.get(cache);
  if (!meta || (cache.size === 0 && meta.entries.size > 0)) {
    meta = {
      entries: new Map(),
      storedPaths: new Set(),
      storedBytesByPath: new Map(),
      protectedBytes: 0,
      unprotectedEntries: 0,
      protectedStores: 0,
      protectedStoreBytes: 0,
      unprotectedStores: 0,
      unprotectedStoreBytes: 0,
      protectedEvictions: 0,
      protectedEvictionBytes: 0,
      unprotectedEvictions: 0,
      unprotectedEvictionBytes: 0,
      buckets: emptyPass1ExtractionBuckets(),
    };
    pass1ExtractionCacheMeta.set(cache, meta);
  }
  return meta;
}

function removePass1ExtractionMeta(
  meta: Pass1ExtractionCacheMeta,
  relPath: string,
  options: { recordEviction?: boolean } = {},
): void {
  const existing = meta.entries.get(relPath);
  if (!existing) {
    return;
  }
  if (existing.protected) {
    meta.protectedBytes -= existing.contentBytes;
    if (options.recordEviction) {
      meta.protectedEvictions++;
      meta.protectedEvictionBytes += existing.contentBytes;
    }
  } else {
    meta.unprotectedEntries--;
    if (options.recordEviction) {
      meta.unprotectedEvictions++;
      meta.unprotectedEvictionBytes += existing.contentBytes;
    }
  }
  const bucket = meta.buckets[existing.bucket];
  bucket.entries--;
  bucket.bytes -= existing.contentBytes;
  if (options.recordEviction) {
    bucket.evictions++;
    bucket.evictionBytes += existing.contentBytes;
  }
  meta.entries.delete(relPath);
}

function setPass1ExtractionMeta(
  meta: Pass1ExtractionCacheMeta,
  relPath: string,
  entry: Pass1ExtractionEntry,
): void {
  const protectedEntry = isProtectedCSourceExtraction(relPath);
  const contentBytes = extractionContentBytes(entry);
  const bucketKey = bucketForRelPath(relPath);
  meta.entries.set(relPath, {
    protected: protectedEntry,
    contentBytes,
    bucket: bucketKey,
  });
  meta.storedPaths.add(relPath);
  meta.storedBytesByPath.set(relPath, contentBytes);
  const bucket = meta.buckets[bucketKey];
  bucket.entries++;
  bucket.bytes += contentBytes;
  bucket.stores++;
  bucket.storeBytes += contentBytes;
  if (protectedEntry) {
    meta.protectedBytes += contentBytes;
    meta.protectedStores++;
    meta.protectedStoreBytes += contentBytes;
  } else {
    meta.unprotectedEntries++;
    meta.unprotectedStores++;
    meta.unprotectedStoreBytes += contentBytes;
  }
}

function firstPass1ExtractionKey(
  cache: Pass1ExtractionCache,
  predicate: (relPath: string) => boolean,
): string | undefined {
  for (const relPath of cache.keys()) {
    if (predicate(relPath)) {
      return relPath;
    }
  }
  return undefined;
}

function evictPass1ExtractionOverflow(cache: Pass1ExtractionCache): void {
  const meta = getPass1ExtractionCacheMeta(cache);
  while (cache.size > 0) {
    const protectedOverflow =
      meta.protectedBytes > PASS1_EXTRACTION_C_SOURCE_PROTECTED_MAX_BYTES;
    const unprotectedOverflow =
      meta.unprotectedEntries > PASS1_EXTRACTION_CACHE_MAX_ENTRIES;
    if (!protectedOverflow && !unprotectedOverflow) {
      break;
    }

    const victimKey = protectedOverflow
      ? firstPass1ExtractionKey(cache, isProtectedCSourceExtraction)
      : firstPass1ExtractionKey(
          cache,
          (relPath) => !isProtectedCSourceExtraction(relPath),
        );
    if (victimKey === undefined) {
      break;
    }
    cache.delete(victimKey);
    removePass1ExtractionMeta(meta, victimKey, { recordEviction: true });
  }
}

export interface Pass1ExtractionCacheStats {
  entries: number;
  protectedEntries: number;
  protectedBytes: number;
  unprotectedEntries: number;
  protectedStores: number;
  protectedStoreBytes: number;
  unprotectedStores: number;
  unprotectedStoreBytes: number;
  protectedEvictions: number;
  protectedEvictionBytes: number;
  unprotectedEvictions: number;
  unprotectedEvictionBytes: number;
  buckets: Record<Pass1ExtractionCacheBucket, Pass1ExtractionCacheBucketStats>;
}

export interface Pass1ExtractionCacheTargetBucketStats {
  targets: number;
  live: number;
  evicted: number;
  neverStored: number;
  targetBytes: number;
  liveBytes: number;
  evictedBytes: number;
  neverStoredBytes: number;
}

export interface Pass1ExtractionCacheTargetCoverageStats {
  targets: number;
  live: number;
  evicted: number;
  neverStored: number;
  targetBytes: number;
  liveBytes: number;
  evictedBytes: number;
  neverStoredBytes: number;
  buckets: Record<
    Pass1ExtractionCacheBucket,
    Pass1ExtractionCacheTargetBucketStats
  >;
}

function emptyPass1ExtractionTargetBucketStats(): Pass1ExtractionCacheTargetBucketStats {
  return {
    targets: 0,
    live: 0,
    evicted: 0,
    neverStored: 0,
    targetBytes: 0,
    liveBytes: 0,
    evictedBytes: 0,
    neverStoredBytes: 0,
  };
}

function emptyPass1ExtractionTargetBuckets(): Record<
  Pass1ExtractionCacheBucket,
  Pass1ExtractionCacheTargetBucketStats
> {
  return {
    c: emptyPass1ExtractionTargetBucketStats(),
    h: emptyPass1ExtractionTargetBucketStats(),
    cc: emptyPass1ExtractionTargetBucketStats(),
    cpp: emptyPass1ExtractionTargetBucketStats(),
    hpp: emptyPass1ExtractionTargetBucketStats(),
    other: emptyPass1ExtractionTargetBucketStats(),
  };
}

/**
 * Snapshot cache policy counters for benchmark diagnostics. Counts are kept
 * alongside the cache because eviction decisions happen inside `store`.
 */
export function getPass1ExtractionCacheStats(
  cache: Pass1ExtractionCache,
): Pass1ExtractionCacheStats {
  const meta = getPass1ExtractionCacheMeta(cache);
  return {
    entries: meta.entries.size,
    protectedEntries: meta.entries.size - meta.unprotectedEntries,
    protectedBytes: meta.protectedBytes,
    unprotectedEntries: meta.unprotectedEntries,
    protectedStores: meta.protectedStores,
    protectedStoreBytes: meta.protectedStoreBytes,
    unprotectedStores: meta.unprotectedStores,
    unprotectedStoreBytes: meta.unprotectedStoreBytes,
    protectedEvictions: meta.protectedEvictions,
    protectedEvictionBytes: meta.protectedEvictionBytes,
    unprotectedEvictions: meta.unprotectedEvictions,
    unprotectedEvictionBytes: meta.unprotectedEvictionBytes,
    buckets: {
      c: { ...meta.buckets.c },
      h: { ...meta.buckets.h },
      cc: { ...meta.buckets.cc },
      cpp: { ...meta.buckets.cpp },
      hpp: { ...meta.buckets.hpp },
      other: { ...meta.buckets.other },
    },
  };
}

/**
 * Classify pass-2 target cache coverage after target selection. This separates
 * eviction misses from targets never stored by pass-1, so cache-policy changes
 * can be gated on removable misses instead of raw readFile attribution.
 */
export function getPass1ExtractionCacheTargetCoverageStats(
  cache: Pass1ExtractionCache,
  targetRelPaths: Iterable<string>,
  targetBytesByRelPath?: ReadonlyMap<string, number>,
): Pass1ExtractionCacheTargetCoverageStats {
  const meta = getPass1ExtractionCacheMeta(cache);
  const buckets = emptyPass1ExtractionTargetBuckets();
  const stats: Pass1ExtractionCacheTargetCoverageStats = {
    targets: 0,
    live: 0,
    evicted: 0,
    neverStored: 0,
    targetBytes: 0,
    liveBytes: 0,
    evictedBytes: 0,
    neverStoredBytes: 0,
    buckets,
  };

  for (const relPath of targetRelPaths) {
    const bucket = buckets[bucketForRelPath(relPath)];
    const targetBytes = targetBytesByRelPath?.get(relPath) ?? 0;
    stats.targets++;
    stats.targetBytes += targetBytes;
    bucket.targets++;
    bucket.targetBytes += targetBytes;
    const liveEntry = meta.entries.get(relPath);
    if (liveEntry) {
      stats.live++;
      stats.liveBytes += liveEntry.contentBytes;
      bucket.live++;
      bucket.liveBytes += liveEntry.contentBytes;
    } else if (meta.storedPaths.has(relPath)) {
      const evictedBytes = meta.storedBytesByPath.get(relPath) ?? 0;
      stats.evicted++;
      stats.evictedBytes += evictedBytes;
      bucket.evicted++;
      bucket.evictedBytes += evictedBytes;
    } else {
      stats.neverStored++;
      stats.neverStoredBytes += targetBytes;
      bucket.neverStored++;
      bucket.neverStoredBytes += targetBytes;
    }
  }

  return stats;
}

/**
 * Insert a pass-1 extraction entry while keeping the cache bounded.
 * The cache is keyed by relative file path, so refreshing an existing entry
 * moves it to the back of insertion order. C pass-2 misses are mostly small
 * `.c`/`.h` source bytes, so they get a separate byte-bound sidecar instead
 * of raising the broad C++/TS/JS entry cap that benchmarked poorly.
 */
export function storePass1Extraction(
  cache: Pass1ExtractionCache,
  relPath: string,
  entry: Pass1ExtractionEntry,
): void {
  const meta = getPass1ExtractionCacheMeta(cache);
  if (cache.has(relPath)) {
    cache.delete(relPath);
    removePass1ExtractionMeta(meta, relPath);
  }
  cache.set(relPath, entry);
  setPass1ExtractionMeta(meta, relPath, entry);

  evictPass1ExtractionOverflow(cache);
}

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
   * themselves — the dispatcher accepts the submission and decides when to
   * drain the current LadybugDB write batch. Always defined when the
   * dispatcher invokes a resolver; the optional marker is only there so test
   * fakes that construct contexts manually do not have to wire it.
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
   * Optional per-resolver phase timing sink. Resolvers use this only for
   * diagnostic attribution; it must not affect resolution behavior.
   */
  recordPhase?: (phaseName: string, elapsedMs: number) => void;
  /**
   * Optional per-resolver count/size metric sink. Resolvers use this for
   * diagnostics such as files read or bytes parsed; it must not affect
   * resolution behavior.
   */
  recordMetric?: (metricName: string, value: number) => void;
  /**
   * Optional bounded per-file phase attribution. This is diagnostic-only and
   * keeps only the slowest few files per resolver phase so benchmark output can
   * identify repeated hot paths without retaining every file timing.
   */
  recordFilePhase?: (
    phaseName: string,
    filePath: string,
    elapsedMs: number,
    bytes?: number,
  ) => void;
  /**
   * Pass-2 file paths that will actually run resolvers after SCIP safe-skip
   * filtering. Language resolvers may use this to avoid building per-source
   * indexes for files whose pass-2 output will never be read.
   */
  pass2TargetPaths?: ReadonlySet<string>;
  /**
   * Pass-1 extraction cache. The TS pass-2 resolver checks this map keyed
   * by `relPath`; on hit, it skips the redundant tree-sitter parse + the
   * three `extract*` calls and reuses the data pass-1 already computed.
   * C-family resolvers reuse only source text/import metadata; they still
   * reparse and perform their stricter pass-2 symbol/call extraction.
   */
  pass1Extractions?: Pass1ExtractionCache;
}

export interface Pass2Resolver {
  readonly id: string;
  supports(target: Pass2Target): boolean;
  /**
   * Optional pass-level preparation before per-file resolution starts. Use this
   * only for deterministic shared indexes that many targets will await anyway;
   * warmup failures are logged and per-file resolution continues normally.
   */
  warmup?(
    targets: readonly Pass2Target[],
    context: Pass2ResolverContext,
  ): Promise<void>;
  resolve(
    target: Pass2Target,
    context: Pass2ResolverContext,
  ): Promise<Pass2ResolverResult>;
}
