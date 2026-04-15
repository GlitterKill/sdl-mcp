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
import {
  toPass2Target,
  type Pass2ResolverRegistry,
} from "./pass2/registry.js";
import { withWriteConn } from "../db/ladybug.js";
import {
  buildGlobalPreferredSymbolIds,
  type IndexProgress,
  type LadybugConn,
} from "./indexer-init.js";

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
      addToSymbolIndex(refreshed, filePath, symbol.symbolId, symbol.name, symbol.kind as SymbolKind);
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
}): Promise<{ edgesCreated: number; localEdgeKeys: Set<string>; resolverId: string | null; elapsedMs: number }> {
  const {
    repoId, repoRoot, fileMeta, pass2ResolverRegistry, symbolIndex, tsResolver,
    config, localCreatedCallEdges, globalNameToSymbolIds, globalPreferredSymbolId,
    callResolutionTelemetry, pass2ResolverCache,
  } = params;

  const target = toPass2Target({ ...fileMeta, repoId });
  const resolver = pass2ResolverRegistry.getResolver(target);
  if (!resolver) {
    return { edgesCreated: 0, localEdgeKeys: localCreatedCallEdges, resolverId: null, elapsedMs: 0 };
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
}): Promise<number> {
  const {
    repoId, repoRoot, mode, pass2EligibleFiles, changedPass2FilePaths,
    supportsPass2FilePath, pass2ResolverRegistry, symbolIndex, tsResolver,
    config, createdCallEdges, globalNameToSymbolIds, globalPreferredSymbolId,
    callResolutionTelemetry, onProgress, signal,
  } = params;

  const pass2Targets = await resolvePass2Targets({
    repoId,
    mode,
    pass2Files: pass2EligibleFiles,
    changedPass2FilePaths,
    supportsPass2FilePath,
  });
  callResolutionTelemetry.pass2Targets = pass2Targets.length;

  // Resolver cache - shared in sequential mode, per-batch in parallel mode to avoid compute-once races.
  const pass2ResolverCache = new Map<string, unknown>();

  const concurrency = Math.max(1, params.pass2Concurrency ?? 1);
  let totalEdgesCreated = 0;
  let pass2Processed = 0;

  if (concurrency <= 1) {
    // --- Sequential path (default, identical to original behaviour) ---
    for (const fileMeta of pass2Targets) {
      if (signal?.aborted) break;
      callResolutionTelemetry.pass2FilesProcessed++;
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
    for (let batchStart = 0; batchStart < pass2Targets.length; batchStart += concurrency) {
      if (signal?.aborted) break;

      const batchEnd = Math.min(batchStart + concurrency, pass2Targets.length);
      const batch = pass2Targets.slice(batchStart, batchEnd);

      // Snapshot the canonical dedup set for this batch.
      const batchSnapshot = new Set(createdCallEdges);
      // Per-batch cache avoids compute-once races on package index builds.
      const batchCache = new Map<string, unknown>();

      // Emit progress for the first file in this batch.
      if (batch[0]) {
        onProgress?.({
          stage: "pass2",
          current: pass2Processed,
          total: pass2Targets.length,
          currentFile: batch[0].path,
        });
      }

      // Record targets before launching — recordPass2ResolverTarget is synchronous and cheap.
      for (const fileMeta of batch) {
        const resolver = pass2ResolverRegistry.getResolver(toPass2Target({ ...fileMeta, repoId }));
        if (resolver) recordPass2ResolverTarget(callResolutionTelemetry, resolver.id);
      }

      callResolutionTelemetry.pass2FilesProcessed += batch.length;

      // Launch all files in this batch concurrently, each with its own
      // local copy of the dedup set.
      const batchPromises = batch.map((fileMeta) => {
        // Each resolver gets an independent copy so mutations don't race.
        const localCreatedCallEdges = new Set(batchSnapshot);
        return runOnePass2Resolver({
          repoId,
          repoRoot,
          fileMeta,
          pass2ResolverRegistry,
          symbolIndex,
          tsResolver,
          config,
          localCreatedCallEdges,
          globalNameToSymbolIds,
          globalPreferredSymbolId,
          callResolutionTelemetry,
          pass2ResolverCache: batchCache,
        });
      });

      const batchResults = await Promise.all(batchPromises);

      // Sequentially merge results back into the canonical state.
      for (const result of batchResults) {
        totalEdgesCreated += result.edgesCreated;
        // Union the resolver's local set (snapshot + new keys) back into canonical.
        // Re-adding keys already in canonical is a Set no-op.
        for (const key of result.localEdgeKeys) {
          createdCallEdges.add(key);
        }
        if (result.resolverId !== null) {
          recordPass2ResolverResult(callResolutionTelemetry, result.resolverId, {
            edgesCreated: result.edgesCreated,
            elapsedMs: result.elapsedMs,
          });
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
  const measure = measurePhase ??
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
