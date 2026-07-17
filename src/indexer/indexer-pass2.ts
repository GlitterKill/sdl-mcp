import type {
  CallResolutionTelemetry,
  SymbolIndex,
  TsCallResolver,
} from "./edge-builder.js";
import {
  recordPass2ResolverFilePhase,
  recordPass2ResolverMetric,
  recordPass2ResolverPhase,
  recordPass2ResolverResult,
  recordPass2ResolverTarget,
  resolvePass2Targets,
} from "./edge-builder.js";
import type { RepoConfig } from "../config/types.js";
import type { FileMetadata } from "./fileScanner.js";
import { toPass2Target, type Pass2ResolverRegistry } from "./pass2/registry.js";
import {
  getPass1ExtractionCacheStats,
  getPass1ExtractionCacheTargetCoverageStats,
  type Pass1ExtractionCacheBucket,
  type Pass1ExtractionCacheBucketStats,
  type Pass1ExtractionCacheTargetBucketStats,
  type Pass1ExtractionCache,
  type Pass2ImportCache,
  type SubmitEdgeWrite,
} from "./pass2/types.js";
import { getPoolStats } from "../db/ladybug.js";

import { logger } from "../util/logger.js";
import { type IndexProgress } from "./indexer-init.js";
import {
  buildPass2ImportCache,
  type Pass2TimingRecorder,
  type PreloadedPass2ExportedSymbols,
} from "./indexer-pass2-import-cache.js";
import {
  createPass2WriteStats,
  drainBatchAccumulator,
  emptyPass2WriteFlushResult,
  flushBatchAccumulator,
  flushSmallKnownEndpointBufferFinal,
  hasExistingPass2SourceSymbols,
  makeBatchAccumulator,
  onlyZeroEdgeSequentialCredits,
  recordSequentialPass2TelemetryBatch,
  shouldFlushBatchAccumulator,
  type Pass2SmallKnownEndpointBuffer,
  type Pass2WriteStats,
  type SequentialPass2TelemetryCredit,
} from "./indexer-pass2-write.js";

/**
 * Runs a single Pass 2 resolver for `fileMeta` and returns the count of edges
 * created.  Each invocation receives its own snapshot of `createdCallEdges` so
 * that concurrent calls within a batch do not corrupt each other's dedup
 * checks.  New edge-keys are returned so the caller can merge them back into
 * the canonical set after the batch completes.
 *
 * DB writes inside the resolver are already serialised through `withWriteConn`
 * and are idempotent (MERGE semantics), so racing writes are safe.
 */
async function runOnePass2Resolver(params: {
  repoId: string;
  repoRoot: string;
  mode: "full" | "incremental";
  fileMeta: FileMetadata;
  pass2ResolverRegistry: Pass2ResolverRegistry;
  symbolIndex: SymbolIndex;
  tsResolver: TsCallResolver | null;
  config: RepoConfig;
  /**
   * Private copy of the canonical dedup set taken at batch-start.  The
   * resolver mutates this in-place; after resolution the caller merges all
   * keys (including pre-existing ones from the snapshot) back into the
   * canonical set.  Re-adding pre-existing keys is a Set no-op.
   */
  localCreatedCallEdges: Set<string>;
  globalNameToSymbolIds: Map<string, string[]>;
  globalPreferredSymbolId: Map<string, string>;
  callResolutionTelemetry: CallResolutionTelemetry;
  pass2ResolverCache: Map<string, unknown>;
  submitEdgeWrite: SubmitEdgeWrite;
  importCache: Pass2ImportCache;
  pass2TargetPaths: ReadonlySet<string>;
  pass1Extractions?: Pass1ExtractionCache;
}): Promise<{
  edgesCreated: number;
  localEdgeKeys: Set<string>;
  resolverId: string | null;
  elapsedMs: number;
}> {
  const {
    repoId,
    repoRoot,
    mode,
    fileMeta,
    pass2ResolverRegistry,
    symbolIndex,
    tsResolver,
    config,
    localCreatedCallEdges,
    globalNameToSymbolIds,
    globalPreferredSymbolId,
    callResolutionTelemetry,
    pass2ResolverCache,
    submitEdgeWrite,
    importCache,
    pass2TargetPaths,
    pass1Extractions,
  } = params;

  const target = toPass2Target({ ...fileMeta, repoId });
  const resolver = pass2ResolverRegistry.getResolver(target);
  if (!resolver) {
    return {
      edgesCreated: 0,
      localEdgeKeys: localCreatedCallEdges,
      resolverId: null,
      elapsedMs: 0,
    };
  }

  const resolverStartedAt = Date.now();
  const pass2Result = await resolver.resolve(target, {
    repoRoot,
    symbolIndex,
    tsResolver,
    languages: config.languages,
    createdCallEdges: localCreatedCallEdges,
    globalNameToSymbolIds,
    globalPreferredSymbolId,
    telemetry: callResolutionTelemetry,
    cache: pass2ResolverCache,
    mode,
    submitEdgeWrite,
    importCache,
    pass2TargetPaths,
    pass1Extractions,
    recordPhase: (phaseName, elapsedMs) =>
      recordPass2ResolverPhase(
        callResolutionTelemetry,
        resolver.id,
        phaseName,
        elapsedMs,
      ),
    recordMetric: (metricName, value) =>
      recordPass2ResolverMetric(
        callResolutionTelemetry,
        resolver.id,
        metricName,
        value,
      ),
    recordFilePhase: (phaseName, filePath, elapsedMs, bytes) =>
      recordPass2ResolverFilePhase(
        callResolutionTelemetry,
        resolver.id,
        phaseName,
        filePath,
        elapsedMs,
        bytes,
      ),
  });

  return {
    edgesCreated: pass2Result.edgesCreated,
    // Return the mutated local set; caller does a union merge into canonical.
    localEdgeKeys: localCreatedCallEdges,
    resolverId: resolver.id,
    elapsedMs: Date.now() - resolverStartedAt,
  };
}

/** Pass 2 — cross-file call resolution. Returns total new edges created. */
export async function runPass2Resolvers(params: {
  repoId: string;
  repoRoot: string;
  mode: "full" | "incremental";
  pass2EligibleFiles: FileMetadata[];
  changedPass2FilePaths: Set<string>;
  supportsPass2FilePath: (relPath: string) => boolean;
  pass2ResolverRegistry: Pass2ResolverRegistry;
  symbolIndex: SymbolIndex;
  tsResolver: TsCallResolver | null;
  config: RepoConfig;
  /** Number of files to resolve in parallel. Sourced from appConfig.indexing.pass2Concurrency. */
  pass2Concurrency?: number;
  createdCallEdges: Set<string>;
  globalNameToSymbolIds: Map<string, string[]>;
  globalPreferredSymbolId: Map<string, string>;
  callResolutionTelemetry: CallResolutionTelemetry;
  onProgress: ((progress: IndexProgress) => void) | undefined;
  signal?: AbortSignal;
  /**
   * Files that SCIP fully covered (every callable reference occurrence
   * resolved). The dispatcher skips resolver invocation for these to avoid
   * redundant CPU + I/O — pass-2's heuristic writes for those call sites
   * would have been blocked by the `insertEdges` confidence guard anyway.
   * Empty / undefined when SCIP is not configured or returned no coverage.
   * Files in `changedPass2FilePaths` are NEVER skipped regardless of
   * coverage — their content may differ from the SCIP-generated state.
   */
  scipFullyCoveredPaths?: ReadonlySet<string>;
  /**
   * Pass-1 extraction cache. The TS pass-2 resolver checks this map keyed
   * by `relPath`; on hit, it skips the redundant tree-sitter parse + the
   * three `extract*` calls and reuses the data pass-1 already computed.
   * Optional so SCIP-only refresh paths (which never run pass-1) and tests
   * can omit it.
   */
  pass1Extractions?: Pass1ExtractionCache;
  preloadedExportedSymbols?: PreloadedPass2ExportedSymbols;
  recordTiming?: Pass2TimingRecorder;
  writeStats?: Pass2WriteStats;
  onAuthoritativeEdgeWrite?: (
    write: Parameters<SubmitEdgeWrite>[0],
  ) => Promise<void> | void;
}): Promise<number> {
  const {
    repoId,
    repoRoot,
    mode,
    pass2EligibleFiles,
    changedPass2FilePaths,
    supportsPass2FilePath,
    pass2ResolverRegistry,
    symbolIndex,
    tsResolver,
    config,
    createdCallEdges,
    globalNameToSymbolIds,
    globalPreferredSymbolId,
    callResolutionTelemetry,
    onProgress,
    signal,
    scipFullyCoveredPaths,
    pass1Extractions,
    preloadedExportedSymbols,
    recordTiming,
    writeStats,
    onAuthoritativeEdgeWrite,
  } = params;

  const measurePass2Subphase = async <T>(
    phaseName: string,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      recordTiming?.(`pass2.${phaseName}`, Date.now() - startedAt);
    }
  };

  const pass2Targets = await measurePass2Subphase("targetSelection", () =>
    resolvePass2Targets({
      repoId,
      mode,
      pass2Files: pass2EligibleFiles,
      changedPass2FilePaths,
      supportsPass2FilePath,
    }),
  );
  callResolutionTelemetry.pass2Targets = pass2Targets.length;

  // Pre-compute the safe-skip set: files SCIP fully covered MINUS files in
  // the incremental change set (whose content has shifted since SCIP was
  // generated). One Set difference build, then O(1) `.has()` per file in
  // the dispatch loop. No allocation when SCIP isn't configured.
  const safeSkipSet: ReadonlySet<string> = (() => {
    if (!scipFullyCoveredPaths || scipFullyCoveredPaths.size === 0) {
      return new Set();
    }
    if (changedPass2FilePaths.size === 0) {
      return scipFullyCoveredPaths;
    }
    const out = new Set<string>();
    for (const path of scipFullyCoveredPaths) {
      if (!changedPass2FilePaths.has(path)) out.add(path);
    }
    return out;
  })();
  const noExistingSymbolSkipSet = new Set<string>();
  for (const fileMeta of pass2Targets) {
    if (
      !safeSkipSet.has(fileMeta.path) &&
      !hasExistingPass2SourceSymbols(symbolIndex, fileMeta.path)
    ) {
      noExistingSymbolSkipSet.add(fileMeta.path);
    }
  }
  const activePass2TargetPaths = new Set<string>();
  const activePass2TargetBytes = new Map<string, number>();
  for (const fileMeta of pass2Targets) {
    if (
      !safeSkipSet.has(fileMeta.path) &&
      !noExistingSymbolSkipSet.has(fileMeta.path)
    ) {
      activePass2TargetPaths.add(fileMeta.path);
      activePass2TargetBytes.set(fileMeta.path, fileMeta.size);
    }
  }
  recordTiming?.(
    "pass2.dispatch.skippedNoExistingSymbols",
    noExistingSymbolSkipSet.size,
  );

  if (pass1Extractions) {
    const cacheStats = getPass1ExtractionCacheStats(pass1Extractions);
    const targetCoverageStats = getPass1ExtractionCacheTargetCoverageStats(
      pass1Extractions,
      activePass2TargetPaths,
      activePass2TargetBytes,
    );
    const recordCacheBucketStats = (
      bucketName: Pass1ExtractionCacheBucket,
      bucket: Pass1ExtractionCacheBucketStats,
    ): void => {
      const prefix = `pass2.cache.pass1Extraction.bucket.${bucketName}`;
      recordTiming?.(`${prefix}.entries`, bucket.entries);
      recordTiming?.(`${prefix}.bytes`, bucket.bytes);
      recordTiming?.(`${prefix}.stores`, bucket.stores);
      recordTiming?.(`${prefix}.storeBytes`, bucket.storeBytes);
      recordTiming?.(`${prefix}.evictions`, bucket.evictions);
      recordTiming?.(`${prefix}.evictionBytes`, bucket.evictionBytes);
    };
    const recordTargetBucketStats = (
      bucketName: Pass1ExtractionCacheBucket,
      bucket: Pass1ExtractionCacheTargetBucketStats,
    ): void => {
      const prefix = `pass2.cache.pass1Extraction.target.bucket.${bucketName}`;
      recordTiming?.(`${prefix}.targets`, bucket.targets);
      recordTiming?.(`${prefix}.live`, bucket.live);
      recordTiming?.(`${prefix}.evicted`, bucket.evicted);
      recordTiming?.(`${prefix}.neverStored`, bucket.neverStored);
      recordTiming?.(`${prefix}.targetBytes`, bucket.targetBytes);
      recordTiming?.(`${prefix}.liveBytes`, bucket.liveBytes);
      recordTiming?.(`${prefix}.evictedBytes`, bucket.evictedBytes);
      recordTiming?.(`${prefix}.neverStoredBytes`, bucket.neverStoredBytes);
    };
    recordTiming?.(
      "pass2.cache.pass1Extraction.entries",
      cacheStats.entries,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.protectedEntries",
      cacheStats.protectedEntries,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.protectedBytes",
      cacheStats.protectedBytes,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.unprotectedEntries",
      cacheStats.unprotectedEntries,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.protectedStores",
      cacheStats.protectedStores,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.protectedStoreBytes",
      cacheStats.protectedStoreBytes,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.unprotectedStores",
      cacheStats.unprotectedStores,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.unprotectedStoreBytes",
      cacheStats.unprotectedStoreBytes,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.protectedEvictions",
      cacheStats.protectedEvictions,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.protectedEvictionBytes",
      cacheStats.protectedEvictionBytes,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.unprotectedEvictions",
      cacheStats.unprotectedEvictions,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.unprotectedEvictionBytes",
      cacheStats.unprotectedEvictionBytes,
    );
    recordCacheBucketStats("c", cacheStats.buckets.c);
    recordCacheBucketStats("h", cacheStats.buckets.h);
    recordCacheBucketStats("cc", cacheStats.buckets.cc);
    recordCacheBucketStats("cpp", cacheStats.buckets.cpp);
    recordCacheBucketStats("hpp", cacheStats.buckets.hpp);
    recordCacheBucketStats("other", cacheStats.buckets.other);
    recordTiming?.(
      "pass2.cache.pass1Extraction.target.targets",
      targetCoverageStats.targets,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.target.live",
      targetCoverageStats.live,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.target.evicted",
      targetCoverageStats.evicted,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.target.neverStored",
      targetCoverageStats.neverStored,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.target.targetBytes",
      targetCoverageStats.targetBytes,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.target.liveBytes",
      targetCoverageStats.liveBytes,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.target.evictedBytes",
      targetCoverageStats.evictedBytes,
    );
    recordTiming?.(
      "pass2.cache.pass1Extraction.target.neverStoredBytes",
      targetCoverageStats.neverStoredBytes,
    );
    recordTargetBucketStats("c", targetCoverageStats.buckets.c);
    recordTargetBucketStats("h", targetCoverageStats.buckets.h);
    recordTargetBucketStats("cc", targetCoverageStats.buckets.cc);
    recordTargetBucketStats("cpp", targetCoverageStats.buckets.cpp);
    recordTargetBucketStats("hpp", targetCoverageStats.buckets.hpp);
    recordTargetBucketStats("other", targetCoverageStats.buckets.other);
  }

  // Pass-level resolver cache. Promoted from per-batch (was `batchCache`) so
  // parallel batches share the cached symbol/file lookups built by language
  // resolvers (e.g. `getSymbolsByRepo` in cpp/csharp/go/java/rust). Since
  // values are deterministic and `Map.set` is atomic, two parallel resolvers
  // computing the same key just race to set — last write wins, no corruption.
  const pass2ResolverCache = new Map<string, unknown>();

  // Pass-level import cache. Built once with two batched reads against the
  // readPool, eliminating ~30k point-read round-trips that
  // `import-resolution.ts` previously made per refresh (one
  // `getFileByRepoPath` per imported module + one `getSymbolsByFile` per
  // resolved target file). Stays read-only for the duration of pass-2 — no
  // writes mutate File or Symbol rows during pass-2 (writes are confined to
  // call edges via `submitEdgeWrite`).
  const importCache = await measurePass2Subphase("importCache", () =>
    buildPass2ImportCache(repoId, preloadedExportedSymbols),
  );

  // Snapshot writeLimiter stats so we can report a pass-2-only delta. Reveals
  // whether the phase is genuinely writeLimiter-bound (high totalQueueMs +
  // peakQueued near concurrency) or CPU-bound (totalActiveMs ~ wall time).
  const wlBefore = getPoolStats();
  const pass2StartedAt = Date.now();

  const activePass2Targets = pass2Targets
    .filter(
      (fileMeta) =>
        !safeSkipSet.has(fileMeta.path) &&
        !noExistingSymbolSkipSet.has(fileMeta.path),
    )
    .map((fileMeta) => toPass2Target({ ...fileMeta, repoId }));
  const warmupStartedAt = Date.now();
  for (const resolver of pass2ResolverRegistry.listResolvers()) {
    if (!resolver.warmup) continue;
    const resolverTargets = activePass2Targets.filter((target) =>
      resolver.supports(target),
    );
    if (resolverTargets.length === 0) continue;
    try {
      await resolver.warmup(resolverTargets, {
        repoRoot,
        symbolIndex,
        tsResolver,
        languages: config.languages,
        createdCallEdges,
        globalNameToSymbolIds,
        globalPreferredSymbolId,
        telemetry: callResolutionTelemetry,
        cache: pass2ResolverCache,
        mode,
        importCache,
        pass2TargetPaths: activePass2TargetPaths,
        pass1Extractions,
        recordPhase: (phaseName, elapsedMs) =>
          recordPass2ResolverPhase(
            callResolutionTelemetry,
            resolver.id,
            phaseName,
            elapsedMs,
          ),
        recordMetric: (metricName, value) =>
          recordPass2ResolverMetric(
            callResolutionTelemetry,
            resolver.id,
            metricName,
            value,
          ),
        recordFilePhase: (phaseName, filePath, elapsedMs, bytes) =>
          recordPass2ResolverFilePhase(
            callResolutionTelemetry,
            resolver.id,
            phaseName,
            filePath,
            elapsedMs,
            bytes,
          ),
      });
    } catch (error) {
      logger.warn(
        `Pass2 resolver warmup failed for ${resolver.id}; continuing per-file resolution`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
  recordTiming?.("pass2.resolverWarmup", Date.now() - warmupStartedAt);

  const concurrency = Math.max(1, params.pass2Concurrency ?? 1);
  let totalEdgesCreated = 0;
  let pass2Processed = 0;
  const pass2WriteStats = writeStats ?? createPass2WriteStats();
  const smallKnownEndpointBuffer: Pass2SmallKnownEndpointBuffer | undefined =
    mode === "full" ? { edges: [] } : undefined;

  if (concurrency <= 1) {
    // --- Sequential path: deterministic resolver order, bounded write batches ---
    //
    // Keep resolver execution single-threaded for the default/mid CPU path, but
    // coalesce writes exactly like the parallel dispatcher. This cuts
    // withWriteConn handshakes from O(files) to O(files / batch) while preserving
    // the in-memory createdCallEdges ordering that the legacy sequential path
    // relied on for duplicate suppression.
    const { acc: sequentialWriteAcc, submit: sequentialSubmit } =
      makeBatchAccumulator(onAuthoritativeEdgeWrite);
    let filesSinceWriteFlush = 0;
    let filesPendingTelemetryCredit = 0;
    const pendingResolverTelemetryCredits: SequentialPass2TelemetryCredit[] =
      [];

    for (const fileMeta of pass2Targets) {
      if (signal?.aborted) break;
      // SCIP-coverage skip: file fully resolved by SCIP (and not in the
      // changed set), so there is no heuristic edge for pass-2 to add. The
      // `insertEdges` confidence guard would already block downgrade
      // attempts; this skip avoids the wasted resolver execution.
      if (safeSkipSet.has(fileMeta.path)) {
        callResolutionTelemetry.pass2FilesSkippedSCIP++;
        pass2Processed++;
        continue;
      }
      if (noExistingSymbolSkipSet.has(fileMeta.path)) {
        callResolutionTelemetry.pass2FilesSkippedNoExistingSymbols++;
        pass2Processed++;
        continue;
      }
      onProgress?.({
        stage: "pass2",
        current: pass2Processed,
        total: pass2Targets.length,
        currentFile: fileMeta.path,
      });
      const resolver = pass2ResolverRegistry.getResolver(
        toPass2Target({ ...fileMeta, repoId }),
      );
      if (!resolver) {
        callResolutionTelemetry.pass2FilesProcessed++;
        pass2Processed++;
        continue;
      }
      const resolverStartedAt = Date.now();
      const pass2Result = await resolver.resolve(
        toPass2Target({ ...fileMeta, repoId }),
        {
          repoRoot,
          symbolIndex,
          tsResolver,
          languages: config.languages,
          createdCallEdges,
          globalNameToSymbolIds,
          globalPreferredSymbolId,
          telemetry: callResolutionTelemetry,
          cache: pass2ResolverCache,
          mode,
          submitEdgeWrite: sequentialSubmit,
          importCache,
          pass2TargetPaths: activePass2TargetPaths,
          pass1Extractions,
          recordPhase: (phaseName, elapsedMs) =>
            recordPass2ResolverPhase(
              callResolutionTelemetry,
              resolver.id,
              phaseName,
              elapsedMs,
            ),
          recordMetric: (metricName, value) =>
            recordPass2ResolverMetric(
              callResolutionTelemetry,
              resolver.id,
              metricName,
              value,
            ),
          recordFilePhase: (phaseName, filePath, elapsedMs, bytes) =>
            recordPass2ResolverFilePhase(
              callResolutionTelemetry,
              resolver.id,
              phaseName,
              filePath,
              elapsedMs,
              bytes,
            ),
        },
      );
      pendingResolverTelemetryCredits.push({
        resolverId: resolver.id,
        edgesCreated: pass2Result.edgesCreated,
        elapsedMs: Date.now() - resolverStartedAt,
      });
      filesSinceWriteFlush++;
      filesPendingTelemetryCredit++;
      if (
        shouldFlushBatchAccumulator(
          sequentialWriteAcc,
          filesSinceWriteFlush,
        )
      ) {
        const flushResult = await drainBatchAccumulator(
          sequentialWriteAcc,
          mode,
          pass2WriteStats,
          smallKnownEndpointBuffer,
        );
        if (
          flushResult.persistedEdges > 0 ||
          (flushResult.deferredEdges === 0 &&
            onlyZeroEdgeSequentialCredits(pendingResolverTelemetryCredits))
        ) {
          totalEdgesCreated += pendingResolverTelemetryCredits.reduce(
            (sum, credit) => sum + credit.edgesCreated,
            0,
          );
          recordSequentialPass2TelemetryBatch(
            callResolutionTelemetry,
            pendingResolverTelemetryCredits,
            filesPendingTelemetryCredit,
          );
          pendingResolverTelemetryCredits.length = 0;
          filesPendingTelemetryCredit = 0;
        }
        filesSinceWriteFlush = 0;
      }
      pass2Processed++;
    }
    const finalFlushResult = await drainBatchAccumulator(
      sequentialWriteAcc,
      mode,
      pass2WriteStats,
      smallKnownEndpointBuffer,
    );
    if (
      finalFlushResult.persistedEdges > 0 ||
      (finalFlushResult.deferredEdges === 0 &&
        onlyZeroEdgeSequentialCredits(pendingResolverTelemetryCredits))
    ) {
      totalEdgesCreated += pendingResolverTelemetryCredits.reduce(
        (sum, credit) => sum + credit.edgesCreated,
        0,
      );
      recordSequentialPass2TelemetryBatch(
        callResolutionTelemetry,
        pendingResolverTelemetryCredits,
        filesPendingTelemetryCredit,
      );
      pendingResolverTelemetryCredits.length = 0;
      filesPendingTelemetryCredit = 0;
    }
    const finalSmallCopyFlushResult =
      smallKnownEndpointBuffer
        ? await flushSmallKnownEndpointBufferFinal(
            smallKnownEndpointBuffer,
            pass2WriteStats,
          )
        : emptyPass2WriteFlushResult();
    if (
      finalSmallCopyFlushResult.persistedEdges > 0 ||
      onlyZeroEdgeSequentialCredits(pendingResolverTelemetryCredits)
    ) {
      totalEdgesCreated += pendingResolverTelemetryCredits.reduce(
        (sum, credit) => sum + credit.edgesCreated,
        0,
      );
      recordSequentialPass2TelemetryBatch(
        callResolutionTelemetry,
        pendingResolverTelemetryCredits,
        filesPendingTelemetryCredit,
      );
      pendingResolverTelemetryCredits.length = 0;
      filesPendingTelemetryCredit = 0;
    }
  } else {
    // --- Parallel path: bounded concurrency with per-file isolated dedup sets ---
    //
    // TELEMETRY NOTE: Counters in callResolutionTelemetry may be slightly
    // inaccurate under concurrency due to interleaved increments. This is
    // acceptable because telemetry is diagnostic only and does not affect
    // indexing correctness. The alternative (cloning telemetry per resolver
    // and merging) would add significant complexity for marginal benefit.
    //
    // Each file in a batch receives a *snapshot* of createdCallEdges taken
    // at batch-start so resolvers do not race on the shared set.  After the
    // batch finishes we union all new keys back into the canonical set.
    //
    // DB writes inside resolvers are already serialised by withWriteConn and
    // use MERGE semantics, so concurrent writes of the same edge are idempotent.
    type ParallelBatchResult = Awaited<ReturnType<typeof runOnePass2Resolver>>;
    type PendingParallelTelemetryCredit = {
      filesProcessed: number;
      resolverTargets: string[];
      resolverResults: Array<{
        resolverId: string;
        edgesCreated: number;
        elapsedMs: number;
      }>;
    };
    const pendingParallelTelemetryCredits: PendingParallelTelemetryCredit[] = [];
    const buildParallelTelemetryCredit = (
      batch: FileMetadata[],
      batchResults: ParallelBatchResult[],
    ): PendingParallelTelemetryCredit => {
      const resolverTargets: string[] = [];
      for (const fileMeta of batch) {
        const resolver = pass2ResolverRegistry.getResolver(
          toPass2Target({ ...fileMeta, repoId }),
        );
        if (resolver) resolverTargets.push(resolver.id);
      }
      const resolverResults: PendingParallelTelemetryCredit["resolverResults"] =
        [];
      for (const result of batchResults) {
        if (result.resolverId !== null) {
          resolverResults.push({
            resolverId: result.resolverId,
            edgesCreated: result.edgesCreated,
            elapsedMs: result.elapsedMs,
          });
        }
      }
      return {
        filesProcessed: batch.length,
        resolverTargets,
        resolverResults,
      };
    };
    const mergeParallelCreatedEdges = (
      batchResults: readonly ParallelBatchResult[],
    ): void => {
      for (const result of batchResults) {
        for (const key of result.localEdgeKeys) {
          createdCallEdges.add(key);
        }
      }
    };
    const creditParallelTelemetry = (
      credit: PendingParallelTelemetryCredit,
    ): void => {
      callResolutionTelemetry.pass2FilesProcessed += credit.filesProcessed;
      for (const resolverId of credit.resolverTargets) {
        recordPass2ResolverTarget(callResolutionTelemetry, resolverId);
      }
      for (const result of credit.resolverResults) {
        totalEdgesCreated += result.edgesCreated;
        recordPass2ResolverResult(callResolutionTelemetry, result.resolverId, {
          edgesCreated: result.edgesCreated,
          elapsedMs: result.elapsedMs,
        });
      }
    };
    const creditPendingParallelTelemetry = (): void => {
      for (const pending of pendingParallelTelemetryCredits) {
        creditParallelTelemetry(pending);
      }
      pendingParallelTelemetryCredits.length = 0;
    };

    for (
      let batchStart = 0;
      batchStart < pass2Targets.length;
      batchStart += concurrency
    ) {
      if (signal?.aborted) break;

      const batchEnd = Math.min(batchStart + concurrency, pass2Targets.length);
      const rawBatch = pass2Targets.slice(batchStart, batchEnd);

      // Drop files SCIP fully resolved, plus files with no source symbols,
      // before launching resolvers. Counted toward pass-2 progress so
      // diagnostics stay accurate, but no resolver runs and no DB writes issue.
      let skippedInBatch = 0;
      const batch: typeof rawBatch = [];
      for (const fileMeta of rawBatch) {
        if (safeSkipSet.has(fileMeta.path)) {
          callResolutionTelemetry.pass2FilesSkippedSCIP++;
          skippedInBatch++;
        } else if (noExistingSymbolSkipSet.has(fileMeta.path)) {
          callResolutionTelemetry.pass2FilesSkippedNoExistingSymbols++;
          skippedInBatch++;
        } else {
          batch.push(fileMeta);
        }
      }
      pass2Processed += skippedInBatch;
      if (batch.length === 0) {
        // Whole batch was SCIP-covered; nothing to dispatch.
        continue;
      }

      // Snapshot the canonical dedup set for this batch.
      const batchSnapshot = new Set(createdCallEdges);

      // Emit progress for the first file in this batch.
      if (batch[0]) {
        onProgress?.({
          stage: "pass2",
          current: pass2Processed,
          total: pass2Targets.length,
          currentFile: batch[0].path,
        });
      }

      // Per-batch write accumulator: every resolver in this batch submits
      // its (symbolIdsToRefresh, edges) into the same buffer; one combined
      // `withWriteConn` flushes the whole batch after `Promise.all` settles.
      // Cuts writeLimiter handshakes from O(batch.length) to 1 per batch and
      // amortises the delete-then-insert tx setup across N files.
      const { acc: batchWriteAcc, submit: batchSubmit } =
        makeBatchAccumulator(onAuthoritativeEdgeWrite);

      // Launch all files in this batch concurrently, each with its own
      // local copy of the dedup set.
      const batchPromises = batch.map((fileMeta) => {
        // Each resolver gets an independent copy so mutations don't race.
        const localCreatedCallEdges = new Set(batchSnapshot);
        return runOnePass2Resolver({
          repoId,
          repoRoot,
          mode,
          fileMeta,
          pass2ResolverRegistry,
          symbolIndex,
          tsResolver,
          config,
          localCreatedCallEdges,
          globalNameToSymbolIds,
          globalPreferredSymbolId,
          callResolutionTelemetry,
          pass2ResolverCache,
          submitEdgeWrite: batchSubmit,
          importCache,
          pass2TargetPaths: activePass2TargetPaths,
          pass1Extractions,
        });
      });

      const batchResults = await Promise.all(batchPromises);
      const telemetryCredit = buildParallelTelemetryCredit(batch, batchResults);

      // Single combined write for the whole batch. Runs BEFORE the canonical
      // dedup-set merge so a write failure doesn't leave the in-memory state
      // claiming edges that never made it to disk. A failure here is logged
      // via withWriteConn's pool error path and propagates out — pass-2's
      // existing higher-level catch (in indexer.ts) will record it.
      const flushResult = await flushBatchAccumulator(
        batchWriteAcc,
        mode,
        pass2WriteStats,
        smallKnownEndpointBuffer,
      );
      mergeParallelCreatedEdges(batchResults);

      if (flushResult.deferredEdges > 0 && flushResult.persistedEdges === 0) {
        pendingParallelTelemetryCredits.push(telemetryCredit);
      } else {
        if (flushResult.flushedBufferedEdges > 0) {
          creditPendingParallelTelemetry();
        }
        creditParallelTelemetry(telemetryCredit);
      }

      pass2Processed += batch.length;
    }
    const finalSmallCopyFlushResult =
      smallKnownEndpointBuffer
        ? await flushSmallKnownEndpointBufferFinal(
            smallKnownEndpointBuffer,
            pass2WriteStats,
          )
        : emptyPass2WriteFlushResult();
    if (finalSmallCopyFlushResult.persistedEdges > 0) {
      creditPendingParallelTelemetry();
    }
  }

  if (pass2Targets.length > 0) {
    onProgress?.({
      stage: "pass2",
      current: pass2Targets.length,
      total: pass2Targets.length,
    });
  }

  // writeLimiter delta — confirms / refutes the writeLimiter-bound diagnosis.
  // High `writeQueueMs` relative to wall time => writes serialised behind the
  // single mutex (pass-2 is writeLimiter-bound). Low queue time + low active
  // time => phase is CPU- or read-bound. peakQueued near `concurrency`
  // indicates resolvers were piling on faster than the writer could clear.
  const wlAfter = getPoolStats();
  const wallMs = Date.now() - pass2StartedAt;
  recordTiming?.("pass2.resolverDispatch", wallMs);
  const writeRuns = wlAfter.writeTotalRuns - wlBefore.writeTotalRuns;
  const writeActiveMs =
    wlAfter.writeTotalActiveMs - wlBefore.writeTotalActiveMs;
  const writeQueueMs = wlAfter.writeTotalQueueMs - wlBefore.writeTotalQueueMs;
  recordTiming?.("pass2.writeActive", writeActiveMs);
  recordTiming?.("pass2.writeQueue", writeQueueMs);
  recordTiming?.("pass2.write.copyEnsure", pass2WriteStats.copyEnsureMs);
  recordTiming?.(
    "pass2.write.copyEnsure.symbolMetadata",
    pass2WriteStats.copyEnsureSymbolMetadataMs,
  );
  recordTiming?.(
    "pass2.write.copyEnsure.symbolMetadata.probeExisting",
    pass2WriteStats.copyEnsureSymbolProbeMs,
  );
  recordTiming?.(
    "pass2.write.copyEnsure.symbolMetadata.copyMissing.csvMaterialize",
    pass2WriteStats.copyEnsureSymbolCopyMissingCsvMs,
  );
  recordTiming?.(
    "pass2.write.copyEnsure.symbolMetadata.copyMissing.copyFrom",
    pass2WriteStats.copyEnsureSymbolCopyMissingFromMs,
  );
  recordTiming?.(
    "pass2.write.copyEnsure.symbolMetadata.matchExisting",
    pass2WriteStats.copyEnsureSymbolMatchExistingMs,
  );
  recordTiming?.(
    "pass2.write.copyEnsure.symbolMetadata.mergeFallback",
    pass2WriteStats.copyEnsureSymbolMergeFallbackMs,
  );
  recordTiming?.(
    "pass2.write.copyEnsure.repoLink",
    pass2WriteStats.copyEnsureRepoLinkMs,
  );
  recordTiming?.("pass2.write.copyInsert", pass2WriteStats.copyInsertMs);
  recordTiming?.(
    "pass2.write.copyInsert.txnBegin",
    pass2WriteStats.copyInsertTxnBeginMs,
  );
  recordTiming?.(
    "pass2.write.copyInsert.txnBody",
    pass2WriteStats.copyInsertTxnBodyMs,
  );
  recordTiming?.(
    "pass2.write.copyInsert.txnCommit",
    pass2WriteStats.copyInsertTxnCommitMs,
  );
  recordTiming?.(
    "pass2.write.copyInsert.csvMaterialize",
    pass2WriteStats.copyInsertCsvMaterializeMs,
  );
  recordTiming?.(
    "pass2.write.copyInsert.copyFrom",
    pass2WriteStats.copyInsertCopyFromMs,
  );
  recordTiming?.(
    "pass2.write.copyInsert.tempCleanup",
    pass2WriteStats.copyInsertTempCleanupMs,
  );
  recordTiming?.("pass2.write.repairInsert", pass2WriteStats.repairInsertMs);
  recordTiming?.(
    "pass2.write.repairInsert.prepareRows",
    pass2WriteStats.repairPrepareRowsMs,
  );
  recordTiming?.(
    "pass2.write.repairInsert.sourceRepoLink.symbolMetadata",
    pass2WriteStats.repairSourceRepoLinkSymbolMetadataMs,
  );
  recordTiming?.(
    "pass2.write.repairInsert.sourceRepoLink.repoLink",
    pass2WriteStats.repairSourceRepoLinkRepoLinkMs,
  );
  recordTiming?.(
    "pass2.write.repairInsert.endpointMetadata",
    pass2WriteStats.repairEndpointMetadataMs,
  );
  recordTiming?.(
    "pass2.write.repairInsert.targetMetadata",
    pass2WriteStats.repairTargetMetadataMs,
  );
  recordTiming?.(
    "pass2.write.repairInsert.targetRepoLink",
    pass2WriteStats.repairTargetRepoLinkMs,
  );
  recordTiming?.(
    "pass2.write.repairInsert.relationshipCreate",
    pass2WriteStats.repairRelationshipCreateMs,
  );
  recordTiming?.(
    "pass2.write.repairInsert.relationshipUpdate",
    pass2WriteStats.repairRelationshipUpdateMs,
  );
  logger.info("Pass-2 writeLimiter telemetry", {
    mode,
    pass2Files: pass2Targets.length,
    pass2FilesSkippedSCIP: callResolutionTelemetry.pass2FilesSkippedSCIP,
    pass2FilesSkippedNoExistingSymbols:
      callResolutionTelemetry.pass2FilesSkippedNoExistingSymbols,
    edgesCreated: totalEdgesCreated,
    wallMs,
    writeRuns,
    writeActiveMs,
    writeQueueMs,
    writeQueueShare: wallMs > 0 ? Math.round((writeQueueMs / wallMs) * 100) : 0,
    peakQueuedDuringPass: wlAfter.writePeakQueued,
    peakActiveDuringPass: wlAfter.writePeakActive,
    concurrency,
    writeDetails: pass2WriteStats,
  });

  return totalEdgesCreated;
}

export {
  buildPreloadedPass2ExportedSymbolsFromRows,
} from "./indexer-pass2-import-cache.js";
export { finalizeEdges } from "./indexer-finalize-edges.js";
export { refreshSymbolIndexFromDb } from "./indexer-pass2-symbol-index.js";
export {
  DEFAULT_PASS2_KNOWN_ENDPOINT_COPY_BUFFER_MAX_EDGES,
  createPass2WriteStats,
  flushBatchAccumulator,
  insertPass2Edges,
  makeBatchAccumulator,
  makeImmediateSubmit,
  resolvePass2KnownEndpointCopyBufferMaxEdges,
  shouldFlushBatchAccumulator,
  splitPass2EdgesForFullMode,
  toPass2KnownEndpointCopyEdge,
} from "./indexer-pass2-write.js";
