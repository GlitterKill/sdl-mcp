import type {
  CallResolutionTelemetry,
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "./edge-builder.js";
import {
  addToSymbolIndex,
  cleanupUnresolvedEdges,
  recordPass2ResolverResult,
  recordPass2ResolverTarget,
  resolvePass2Targets,
  resolvePendingCallEdges,
} from "./edge-builder.js";
import type { ConfigEdge } from "./configEdges.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type { SymbolKind } from "../domain/types.js";
import type { RepoConfig } from "../config/types.js";
import type { FileMetadata } from "./fileScanner.js";
import { toPass2Target, type Pass2ResolverRegistry } from "./pass2/registry.js";
import type {
  Pass1ExtractionCache,
  Pass2ImportCache,
  SubmitEdgeWrite,
} from "./pass2/types.js";
import { getLadybugConn, withWriteConn, getPoolStats } from "../db/ladybug.js";
import { logger } from "../util/logger.js";
import {
  buildGlobalPreferredSymbolIds,
  type IndexProgress,
  type LadybugConn,
} from "./indexer-init.js";

/**
 * Build a `submitEdgeWrite` that flushes immediately on each call. Used by the
 * sequential pass-2 dispatch path — preserves the legacy "one write per file"
 * shape so single-threaded indexing still benefits from the dispatcher-owned
 * delete-then-insert tx without any coalescing semantics.
 */
/** @internal exported for tests; do not import from product code. */
export function makeImmediateSubmit(
  mode: "full" | "incremental",
): SubmitEdgeWrite {
  return async ({ symbolIdsToRefresh, edges }) => {
    if (symbolIdsToRefresh.length === 0 && edges.length === 0) return;
    await withWriteConn(async (wConn) => {
      if (mode !== "full" && symbolIdsToRefresh.length > 0) {
        await ladybugDb.deleteOutgoingEdgesByTypeForSymbols(
          wConn,
          symbolIdsToRefresh,
          "call",
        );
      }
      if (edges.length > 0) {
        await ladybugDb.insertEdges(wConn, edges);
      }
    });
  };
}

interface BatchWriteAccumulator {
  symbolIdsToRefresh: string[];
  edges: ladybugDb.EdgeRow[];
}

/**
 * Build a `submitEdgeWrite` that defers the write into a shared accumulator.
 * Used by the parallel pass-2 dispatch path so all files in one concurrency
 * batch issue a single combined `withWriteConn`. The accumulator is mutated
 * synchronously from each resolver's submit call — JS event-loop semantics
 * guarantee no torn writes between the `.push(...)` calls in concurrent
 * closures.
 */
/** @internal exported for tests; do not import from product code. */
export function makeBatchAccumulator(): {
  acc: BatchWriteAccumulator;
  submit: SubmitEdgeWrite;
} {
  const acc: BatchWriteAccumulator = { symbolIdsToRefresh: [], edges: [] };
  const submit: SubmitEdgeWrite = async ({ symbolIdsToRefresh, edges }) => {
    if (symbolIdsToRefresh.length > 0) {
      acc.symbolIdsToRefresh.push(...symbolIdsToRefresh);
    }
    if (edges.length > 0) {
      acc.edges.push(...edges);
    }
  };
  return { acc, submit };
}

/** @internal exported for tests; do not import from product code. */
export async function flushBatchAccumulator(
  acc: BatchWriteAccumulator,
  mode: "full" | "incremental",
): Promise<void> {
  if (acc.symbolIdsToRefresh.length === 0 && acc.edges.length === 0) return;
  await withWriteConn(async (wConn) => {
    if (mode !== "full" && acc.symbolIdsToRefresh.length > 0) {
      await ladybugDb.deleteOutgoingEdgesByTypeForSymbols(
        wConn,
        acc.symbolIdsToRefresh,
        "call",
      );
    }
    if (acc.edges.length > 0) {
      await ladybugDb.insertEdges(wConn, acc.edges);
    }
  });
}

/**
 * Build the pass-2 import resolution cache with two batched reads:
 *
 *   1. `getFilesByRepo` — every File row keyed by `relPath`.
 *   2. `getExportedSymbolsLiteByFileIds` — exported `(symbolId, name)` tuples
 *      grouped by `fileId`.
 *
 * Both batches run on a single read connection. Replaces the per-file
 * `getFileByRepoPath` and `getSymbolsByFile` round-trips that
 * `import-resolution.ts` previously made on every imported module — for a
 * 1000-file TS repo with 20 imports/file × 1.5 candidate paths each, that
 * collapsed ~30k point reads into 2 batched queries.
 */
async function buildPass2ImportCache(
  repoId: string,
): Promise<Pass2ImportCache> {
  const conn = await getLadybugConn();
  const files = await ladybugDb.getFilesByRepo(conn, repoId);
  const fileByRelPath = new Map<string, ladybugDb.FileRow>();
  for (const file of files) {
    fileByRelPath.set(file.relPath, file);
  }
  const exportedSymbolsByFileId =
    await ladybugDb.getExportedSymbolsLiteByFileIds(
      conn,
      files.map((f) => f.fileId),
    );
  return { fileByRelPath, exportedSymbolsByFileId };
}

type FinalizeEdgesPhaseMeasurer = <T>(
  phaseName: string,
  fn: () => Promise<T> | T,
) => Promise<T>;

/**
 * Rebuild the in-memory `symbolIndex` and `globalNameToSymbolIds` from the DB
 * after Pass 1 so Pass 2 resolvers see all freshly indexed symbols.
 */
export async function refreshSymbolIndexFromDb(
  conn: LadybugConn,
  repoId: string,
  symbolIndex: SymbolIndex,
  globalNameToSymbolIds: Map<string, string[]>,
  globalPreferredSymbolId?: Map<string, string>,
): Promise<void> {
  const refreshed: SymbolIndex = new Map();
  const allFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const filePathById = new Map(allFiles.map((f) => [f.fileId, f.relPath]));
  const symbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  for (const symbol of symbols) {
    const filePath = filePathById.get(symbol.fileId);
    if (filePath)
      addToSymbolIndex(
        refreshed,
        filePath,
        symbol.symbolId,
        symbol.name,
        symbol.kind as SymbolKind,
      );
  }
  symbolIndex.clear();
  for (const [fp, names] of refreshed) symbolIndex.set(fp, names);

  // Refresh global name index so Pass 2 can heuristically resolve cross-file calls.
  globalNameToSymbolIds.clear();
  const allSymbolsByName = new Map<string, ladybugDb.SymbolLiteRow[]>();
  for (const symbol of symbols) {
    const byId = globalNameToSymbolIds.get(symbol.name) ?? [];
    byId.push(symbol.symbolId);
    globalNameToSymbolIds.set(symbol.name, byId);
    const byName = allSymbolsByName.get(symbol.name) ?? [];
    byName.push({
      symbolId: symbol.symbolId,
      repoId: symbol.repoId,
      fileId: symbol.fileId,
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
    });
    allSymbolsByName.set(symbol.name, byName);
  }
  for (const ids of globalNameToSymbolIds.values()) {
    ids.sort();
    for (let i = ids.length - 1; i > 0; i--) {
      if (ids[i] === ids[i - 1]) ids.splice(i, 1);
    }
  }

  // Refresh preferred symbol disambiguation map
  if (globalPreferredSymbolId) {
    globalPreferredSymbolId.clear();
    const refreshedPreferred = buildGlobalPreferredSymbolIds(allSymbolsByName);
    for (const [name, id] of refreshedPreferred) {
      globalPreferredSymbolId.set(name, id);
    }
  }
}

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
    pass1Extractions,
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
  } = params;

  const pass2Targets = await resolvePass2Targets({
    repoId,
    mode,
    pass2Files: pass2EligibleFiles,
    changedPass2FilePaths,
    supportsPass2FilePath,
  });
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
  const importCache = await buildPass2ImportCache(repoId);

  // Snapshot writeLimiter stats so we can report a pass-2-only delta. Reveals
  // whether the phase is genuinely writeLimiter-bound (high totalQueueMs +
  // peakQueued near concurrency) or CPU-bound (totalActiveMs ~ wall time).
  const wlBefore = getPoolStats();
  const pass2StartedAt = Date.now();

  const concurrency = Math.max(1, params.pass2Concurrency ?? 1);
  let totalEdgesCreated = 0;
  let pass2Processed = 0;

  // Sequential path uses an immediate-flush submit (one withWriteConn per file,
  // identical to the legacy behaviour). The parallel path replaces it per
  // batch with a coalescing accumulator.
  const sequentialSubmit = makeImmediateSubmit(mode);

  if (concurrency <= 1) {
    // --- Sequential path (default, identical to original behaviour) ---
    for (const fileMeta of pass2Targets) {
      if (signal?.aborted) break;
      callResolutionTelemetry.pass2FilesProcessed++;
      // SCIP-coverage skip: file fully resolved by SCIP (and not in the
      // changed set), so there is no heuristic edge for pass-2 to add. The
      // `insertEdges` confidence guard would already block downgrade
      // attempts; this skip avoids the wasted resolver execution.
      if (safeSkipSet.has(fileMeta.path)) {
        callResolutionTelemetry.pass2FilesSkippedSCIP++;
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
        pass2Processed++;
        continue;
      }
      recordPass2ResolverTarget(callResolutionTelemetry, resolver.id);
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
          pass1Extractions,
        },
      );
      recordPass2ResolverResult(callResolutionTelemetry, resolver.id, {
        edgesCreated: pass2Result.edgesCreated,
        elapsedMs: Date.now() - resolverStartedAt,
      });
      totalEdgesCreated += pass2Result.edgesCreated;
      pass2Processed++;
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
    for (
      let batchStart = 0;
      batchStart < pass2Targets.length;
      batchStart += concurrency
    ) {
      if (signal?.aborted) break;

      const batchEnd = Math.min(batchStart + concurrency, pass2Targets.length);
      const rawBatch = pass2Targets.slice(batchStart, batchEnd);

      // SCIP-coverage skip: drop files SCIP fully resolved (and not in the
      // changed set) before launching resolvers. Counted toward
      // `pass2FilesSkippedSCIP` and `pass2Processed` so progress + telemetry
      // stay accurate, but no resolver runs and no DB writes are issued.
      let skippedInBatch = 0;
      const batch: typeof rawBatch = [];
      for (const fileMeta of rawBatch) {
        if (safeSkipSet.has(fileMeta.path)) {
          callResolutionTelemetry.pass2FilesSkippedSCIP++;
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
        makeBatchAccumulator();

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
          pass1Extractions,
        });
      });

      const batchResults = await Promise.all(batchPromises);

      // Single combined write for the whole batch. Runs BEFORE the canonical
      // dedup-set merge so a write failure doesn't leave the in-memory state
      // claiming edges that never made it to disk. A failure here is logged
      // via withWriteConn's pool error path and propagates out — pass-2's
      // existing higher-level catch (in indexer.ts) will record it.
      await flushBatchAccumulator(batchWriteAcc, mode);

      // Telemetry only credits files whose edges actually persisted. Bumping
      // these before the flush would mark files "processed" even on a write
      // failure that propagates out of this loop without committing edges.
      for (const fileMeta of batch) {
        const resolver = pass2ResolverRegistry.getResolver(
          toPass2Target({ ...fileMeta, repoId }),
        );
        if (resolver)
          recordPass2ResolverTarget(callResolutionTelemetry, resolver.id);
      }
      callResolutionTelemetry.pass2FilesProcessed += batch.length;

      // Sequentially merge results back into the canonical state.
      for (const result of batchResults) {
        totalEdgesCreated += result.edgesCreated;
        // Union the resolver's local set (snapshot + new keys) back into canonical.
        // Re-adding keys already in canonical is a Set no-op.
        for (const key of result.localEdgeKeys) {
          createdCallEdges.add(key);
        }
        if (result.resolverId !== null) {
          recordPass2ResolverResult(
            callResolutionTelemetry,
            result.resolverId,
            {
              edgesCreated: result.edgesCreated,
              elapsedMs: result.elapsedMs,
            },
          );
        }
      }

      pass2Processed += batch.length;
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
  const writeRuns = wlAfter.writeTotalRuns - wlBefore.writeTotalRuns;
  const writeActiveMs =
    wlAfter.writeTotalActiveMs - wlBefore.writeTotalActiveMs;
  const writeQueueMs = wlAfter.writeTotalQueueMs - wlBefore.writeTotalQueueMs;
  logger.info("Pass-2 writeLimiter telemetry", {
    mode,
    pass2Files: pass2Targets.length,
    pass2FilesSkippedSCIP: callResolutionTelemetry.pass2FilesSkippedSCIP,
    edgesCreated: totalEdgesCreated,
    wallMs,
    writeRuns,
    writeActiveMs,
    writeQueueMs,
    writeQueueShare: wallMs > 0 ? Math.round((writeQueueMs / wallMs) * 100) : 0,
    peakQueuedDuringPass: wlAfter.writePeakQueued,
    peakActiveDuringPass: wlAfter.writePeakActive,
    concurrency,
  });

  return totalEdgesCreated;
}

/** Resolve pending call edges, clean up dangling edges, and persist config edges. */
export async function finalizeEdges(params: {
  repoId: string;
  pendingCallEdges: PendingCallEdge[];
  symbolIndex: SymbolIndex;
  createdCallEdges: Set<string>;
  allConfigEdges: ConfigEdge[];
  configEdgeWeight: number;
  measurePhase?: FinalizeEdgesPhaseMeasurer;
}): Promise<{ configEdgesCreated: number }> {
  const {
    repoId,
    pendingCallEdges,
    symbolIndex,
    createdCallEdges,
    allConfigEdges,
    configEdgeWeight,
    measurePhase,
  } = params;
  const measure =
    measurePhase ??
    (async <T>(_phaseName: string, fn: () => Promise<T> | T): Promise<T> =>
      await fn());

  await measure(
    "resolvePendingCalls",
    async () =>
      await resolvePendingCallEdges(
        pendingCallEdges,
        symbolIndex,
        createdCallEdges,
        repoId,
      ),
  );
  await measure(
    "cleanupUnresolvedBuiltins",
    async () => await cleanupUnresolvedEdges(repoId),
  );

  const now = new Date().toISOString();
  const configEdgesToInsert: ladybugDb.EdgeRow[] = allConfigEdges.map(
    (edge) => ({
      repoId,
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: "config",
      weight: edge.weight ?? configEdgeWeight,
      confidence: 1.0,
      resolution: "exact",
      provenance: edge.provenance ?? "config",
      createdAt: now,
    }),
  );
  await measure(
    "insertConfigEdges",
    async () =>
      await withWriteConn(async (wConn) => {
        await ladybugDb.insertEdges(wConn, configEdgesToInsert);
      }),
  );
  return { configEdgesCreated: configEdgesToInsert.length };
}
