import * as crypto from "crypto";

import type { AppConfig } from "../config/types.js";
import { resolveSemanticEmbeddingModelPlan } from "../config/semantic-embedding-model-plan.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { classifyDependencyTarget } from "../db/symbol-placeholders.js";
import { updateMetricsForRepo } from "../graph/metrics.js";
import type { FoldedCentralityResult } from "../graph/metrics.js";
import {
  createFtsIndex,
  dropFtsIndex,
  ENTITY_FTS_INDEX_NAMES,
} from "../retrieval/index-lifecycle.js";
import { logger } from "../util/logger.js";
import { refreshSymbolEmbeddings } from "./embeddings.js";
import {
  refreshFileSummaryEmbeddings,
  type FileSummaryEmbeddingRefreshResult,
} from "./file-summary-embeddings.js";
import type { CallResolutionTelemetry } from "./edge-builder.js";
import type { IndexProgress } from "./indexer.js";
import {
  generateSummariesForRepo,
  type SummaryBatchResult,
} from "./summary-generator.js";

export type { SummaryBatchResult } from "./summary-generator.js";

export interface FinalizeIndexingParams {
  repoId: string;
  versionId: string;
  appConfig: AppConfig;
  changedFileIds?: Set<string>;
  changedTestFilePaths?: Set<string>;
  preloadedSymbolFactsByFile?: ReadonlyMap<
    string,
    readonly ladybugDb.FileSummarySymbolFactRow[]
  >;
  hasIndexMutations?: boolean;
  includeTimings?: boolean;
  callResolutionTelemetry: CallResolutionTelemetry;
  deferSemanticRefresh?: boolean;
  onProgress?: (progress: IndexProgress) => void;
}

export interface FinalizeIndexingResult {
  summaryStats?: SummaryBatchResult;
  fileSummaryEmbeddingStats?: Record<string, FileSummaryEmbeddingRefreshResult>;
  semanticDeferred?: boolean;
  qualityStats?: IndexQualityStats;
  timings?: Record<string, number>;
  sharedGraph?: {
    callEdges: Array<{ callerId: string; calleeId: string }>;
    clusterEdges: Array<{ fromSymbolId: string; toSymbolId: string }>;
  };
  foldedCentrality?: FoldedCentralityResult;
}

export interface IndexQualityStats {
  unresolvedTargets: number;
  externalTargets: number;
  untypedPlaceholderTargets: number;
  placeholderTargetMismatches: number;
  isolatedPlaceholders: number;
  placeholderCounts: Record<string, number>;
  missingSignatureByKind: Record<string, number>;
  scipPhaseCounts: Record<string, number>;
}

export async function finalizeIndexing({
  repoId,
  versionId,
  appConfig,
  changedFileIds,
  changedTestFilePaths,
  preloadedSymbolFactsByFile,
  hasIndexMutations,
  includeTimings,
  callResolutionTelemetry,
  deferSemanticRefresh = false,
  onProgress,
}: FinalizeIndexingParams): Promise<FinalizeIndexingResult> {
  const timings: Record<string, number> | undefined = includeTimings
    ? {}
    : undefined;
  const measureSubphase = async <T>(
    phaseName: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const startMs = Date.now();
    try {
      return await fn();
    } finally {
      if (timings) {
        timings[phaseName] = Date.now() - startMs;
      }
    }
  };

  // Incremental no-op refreshes can reuse the current version, so rerunning the
  // repo-wide post-index phases is pure overhead.
  if (
    changedFileIds &&
    changedFileIds.size === 0 &&
    hasIndexMutations === false
  ) {
    logger.debug("Skipping finalizeIndexing for no-op incremental refresh", {
      repoId,
    });
    return { timings };
  }

  await measureSubphase("symbolStatusNormalize", async () => {
    await withWriteConn(async (wConn) => {
      const normalizeScope =
        changedFileIds && changedFileIds.size > 0
          ? { fileIds: changedFileIds }
          : undefined;
      const repaired = await ladybugDb.normalizeDependencyPlaceholderSymbols(
        wConn,
        repoId,
        normalizeScope,
      );
      const providerCallProvenanceRepaired =
        await ladybugDb.normalizeProviderFirstCallEdgeProvenance(wConn, repoId);
      const pruned = await ladybugDb.pruneIsolatedPlaceholderSymbols(
        wConn,
        repoId,
      );
      if (
        repaired.fileBackedRepaired > 0 ||
        repaired.dependencyPlaceholdersRepaired > 0 ||
        providerCallProvenanceRepaired > 0 ||
        pruned > 0
      ) {
        logger.info(
          "Normalized dependency placeholder quality",
          {
            repoId,
            fileBackedRepaired: repaired.fileBackedRepaired,
            dependencyPlaceholdersRepaired:
              repaired.dependencyPlaceholdersRepaired,
            providerCallProvenanceRepaired,
            isolatedPlaceholdersPruned: pruned,
          },
        );
      }
    });
  });

  // Parallelise metrics, fileSummaries, and audit. Each phase acquires its
  // own writer via `withWriteConn` which serializes through a single write
  // connection (correct, no wall-time win — but keeps call sites independent).
  const metricsTask = measureSubphase("metrics", () =>
    updateMetricsForRepo(repoId, changedFileIds, {
      includeTimings,
      changedTestFilePaths,
      algorithmRefresh: appConfig.indexing?.algorithmRefresh,
    }),
  );
  const fileSummariesTask = measureSubphase("fileSummaries", async () => {
    const fsConn = await getLadybugConn();
    return materializeFileSummaries(fsConn, repoId, {
      changedFileIds,
      includeTimings,
      preloadedSymbolFactsByFile,
    });
  }).catch((error) => {
    logger.warn(`FileSummary materialisation skipped: ${String(error)}`);
    return null;
  });
  const auditTask =
    callResolutionTelemetry.pass2EligibleFileCount > 0
      ? measureSubphase("audit", async () => {
          await withWriteConn(async (wConn) => {
            await ladybugDb.insertAuditEvent(wConn, {
              eventId: `audit_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`,
              timestamp: new Date().toISOString(),
              tool: "index.callResolution",
              decision: "stats",
              repoId,
              symbolId: null,
              detailsJson: JSON.stringify({
                versionId,
                ...callResolutionTelemetry,
              }),
            });
          });
        }).catch((error) => {
          logger.warn(
            `Failed to log call-resolution telemetry: ${String(error)}`,
          );
          return null;
        })
      : Promise.resolve(null);

  const [metricsResult, fsResult] = await Promise.all([
    metricsTask,
    fileSummariesTask,
    auditTask,
  ]);
  if (timings && metricsResult.timings) {
    for (const [phaseName, durationMs] of Object.entries(
      metricsResult.timings,
    )) {
      timings[`metrics.${phaseName}`] = durationMs;
    }
  }
  if (timings && fsResult?.timings) {
    for (const [phaseName, durationMs] of Object.entries(fsResult.timings)) {
      timings[`fileSummaries.${phaseName}`] = durationMs;
    }
  }
  if (fsResult) {
    logger.info(
      `FileSummary materialisation: ${fsResult.updated}/${fsResult.total} files updated`,
    );
  }

  let summaryStats: SummaryBatchResult | undefined;
  let fileSummaryEmbeddingStats:
    | Record<string, FileSummaryEmbeddingRefreshResult>
    | undefined;
  const semanticConfig = appConfig.semantic;
  const shouldRunSemanticRefresh =
    semanticConfig?.enabled &&
    (changedFileIds === undefined || changedFileIds.size > 0);
  const semanticDeferred = Boolean(
    shouldRunSemanticRefresh && deferSemanticRefresh,
  );

  if (semanticDeferred) {
    logger.info("Semantic refresh deferred until semantic readiness", {
      repoId,
      versionId,
    });
  }

  if (shouldRunSemanticRefresh && !semanticDeferred) {
    const modelPlan = resolveSemanticEmbeddingModelPlan(semanticConfig);
    if (modelPlan.unsupportedModels.length > 0) {
      logger.warn(
        `Unsupported semantic embedding models skipped: ${modelPlan.unsupportedModels.join(", ")}`,
      );
    }

    // Summaries are generated first so embeddings can incorporate them.
    if (semanticConfig.generateSummaries) {
      try {
        summaryStats = await measureSubphase("semanticSummaries", () =>
          generateSummariesForRepo(repoId, appConfig, onProgress),
        );
        logger.info(
          `Summaries: ${summaryStats.generated} generated, ${summaryStats.skipped} cached, ${summaryStats.failed} failed ($${summaryStats.totalCostUsd.toFixed(4)})`,
        );
      } catch (error) {
        logger.warn(`Summary generation skipped: ${String(error)}`);
      }
    }

    /* sdl.context: lane-specific embedding pass.
     *
     * The specialized profile keeps the expensive semantic tail focused:
     * Jina embeds code-shaped Symbol payloads, while Nomic embeds the more
     * prose-heavy FileSummary payloads. The max-recall profile intentionally
     * restores both models on both lanes for users who prefer recall over
     * index time. Per-lane arrays override either profile. */
    const retrievalConfig = semanticConfig.retrieval;
    const shouldRunFileSummaryEmbeddings =
      (retrievalConfig?.mode ?? "hybrid") === "hybrid" &&
      retrievalConfig?.vector?.enabled !== false;

    if (shouldRunFileSummaryEmbeddings) {
      fileSummaryEmbeddingStats = {};
      // FileSummary payloads are much larger than symbol cards. Keep model
      // lanes serialized here so hybrid file vectors cannot multiply ONNX/DML
      // memory pressure across every configured embedding model.
      for (const embModel of modelPlan.fileSummaryEmbeddingModels) {
        try {
          fileSummaryEmbeddingStats[embModel] = await measureSubphase(
            `fileSummaryEmbeddings:${embModel}`,
            () =>
              refreshFileSummaryEmbeddings({
                repoId,
                provider: semanticConfig.provider ?? "local",
                model: embModel,
                fileIds: changedFileIds ? [...changedFileIds] : undefined,
                onProgress,
                concurrency: semanticConfig.embeddingConcurrency,
                batchSize: semanticConfig.fileSummaryEmbeddingBatchSize,
                maxChars: semanticConfig.fileSummaryEmbeddingMaxChars,
              }),
          );
        } catch (error) {
          logger.warn(
            `FileSummary embedding refresh degraded for ${embModel}: ${String(error)}`,
          );
          fileSummaryEmbeddingStats[embModel] = {
            embedded: 0,
            skipped: 0,
            missing: 0,
            degraded: true,
          };
        }
      }
    }

    // Incremental embedding scope: hydrate the affected-symbol subset that
    // metrics already computed (changed files + 1-hop edge neighbours).
    // Without this, refreshSymbolEmbeddings reads ALL repo symbols every
    // run, builds card hashes for ~8k symbols, and pays the pre-pass cost
    // even when 99% are cache hits — the dominant wall-time on incremental
    // refreshes. Full-repo runs (affectedSymbolIds undefined) keep the
    // previous behaviour and let refreshSymbolEmbeddings load by repo.
    let scopedSymbols: ladybugDb.SymbolRow[] | undefined;
    if (
      metricsResult.affectedSymbolIds &&
      metricsResult.affectedSymbolIds.size > 0
    ) {
      const conn = await getLadybugConn();
      const hydrated = await ladybugDb.getSymbolsByIds(conn, [
        ...metricsResult.affectedSymbolIds,
      ]);
      scopedSymbols = [...hydrated.values()];
      logger.debug(
        `Embedding scope: ${scopedSymbols.length} affected symbols ` +
          `(from ${metricsResult.affectedSymbolIds.size} affected IDs)`,
      );
    }

    const runOneModel = async (embModel: string): Promise<void> => {
      try {
        const embResult = await measureSubphase(
          `semanticEmbeddings:${embModel}`,
          () =>
            refreshSymbolEmbeddings({
              repoId,
              provider: semanticConfig.provider ?? "local",
              model: embModel,
              symbols: scopedSymbols,
              onProgress,
              concurrency: semanticConfig.embeddingConcurrency,
              batchSize: semanticConfig.embeddingBatchSize,
            }),
        );
        logger.info(
          `Embeddings: ${embResult.embedded} embedded, ${embResult.skipped} cached (model: ${embModel})`,
        );
      } catch (error) {
        logger.warn(
          `Semantic embedding refresh skipped for ${embModel}: ${String(error)}`,
        );
      }
    };

    if (semanticConfig.embeddingsSequential) {
      // Sequential: each model holds the full ORT thread budget end-to-end,
      // weights stay hot in L3 cache, and model-handoff scheduling overhead
      // disappears. Wins on systems where ORT serializes parallel sessions
      // at the thread-pool layer (observed alternation pattern).
      for (const embModel of modelPlan.symbolEmbeddingModels) {
        await runOneModel(embModel);
      }
    } else {
      // Parallel: launch all models via Promise.all so independent thread
      // pools can overlap. Best when ORT does NOT serialize sessions —
      // model jobs interleave at the batch boundary and total wall time is
      // close to max(model_a, model_b).
      await Promise.all(
        modelPlan.symbolEmbeddingModels.map((embModel) => runOneModel(embModel)),
      );
    }
  }

  const qualityStats = await measureSubphase("qualityAudit", () =>
    collectIndexQualityStats(repoId),
  ).catch((error) => {
    logger.warn(`Index quality audit skipped: ${String(error)}`);
    return undefined;
  });

  return {
    summaryStats,
    fileSummaryEmbeddingStats,
    semanticDeferred: semanticDeferred || undefined,
    qualityStats,
    timings,
    sharedGraph: metricsResult.sharedGraph,
    foldedCentrality: metricsResult.foldedCentrality,
  };
}

async function collectIndexQualityStats(
  repoId: string,
): Promise<IndexQualityStats> {
  const conn = await getLadybugConn();
  const unresolvedRow = await ladybugDb.querySingle<{
    unresolvedTargets: unknown;
  }>(
    conn,
    `MATCH (a:Symbol {repoId: $repoId})-[d:DEPENDS_ON]->(b:Symbol)
     WHERE coalesce(b.symbolStatus, '') = 'unresolved'
     RETURN count(d) AS unresolvedTargets`,
    { repoId },
  );
  const untypedRow = await ladybugDb.querySingle<{
    untypedPlaceholderTargets: unknown;
  }>(
    conn,
    `MATCH (a:Symbol {repoId: $repoId})-[d:DEPENDS_ON]->(b:Symbol)
     WHERE NOT (b)-[:SYMBOL_IN_FILE]->(:File)
       AND (b.symbolStatus IS NULL OR b.symbolStatus = '')
     RETURN count(d) AS untypedPlaceholderTargets`,
    { repoId },
  );
  const externalRow = await ladybugDb.querySingle<{
    externalTargets: unknown;
  }>(
    conn,
    `MATCH (a:Symbol {repoId: $repoId})-[d:DEPENDS_ON]->(b:Symbol)
     WHERE coalesce(b.symbolStatus, '') = 'external'
        OR coalesce(b.external, false) = true
     RETURN count(d) AS externalTargets`,
    { repoId },
  );
  const missingSignatureRows = await ladybugDb.queryAll<{
    kind: string;
    count: unknown;
  }>(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
       AND (s.signatureJson IS NULL OR s.signatureJson = '')
     RETURN s.kind AS kind, count(s) AS count`,
    { repoId },
  );
  const placeholderRows = await ladybugDb.queryAll<{
    symbolId: string;
    status: string | null;
    kind: string | null;
    target: string | null;
  }>(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})
     WHERE NOT (s)-[:SYMBOL_IN_FILE]->(:File)
       AND (
         s.symbolId STARTS WITH 'unresolved:'
         OR coalesce(s.symbolStatus, '') = 'unresolved'
         OR coalesce(s.symbolStatus, '') = 'external'
       )
     RETURN s.symbolId AS symbolId,
            s.symbolStatus AS status,
            s.placeholderKind AS kind,
            s.placeholderTarget AS target`,
    { repoId },
  );
  const isolatedRow = await ladybugDb.querySingle<{
    count: unknown;
  }>(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})
     WHERE NOT (s)-[:SYMBOL_IN_FILE]->(:File)
       AND (
         s.symbolId STARTS WITH 'unresolved:'
         OR coalesce(s.symbolStatus, '') = 'unresolved'
         OR coalesce(s.symbolStatus, '') = 'external'
       )
       AND NOT (:Symbol)-[:DEPENDS_ON]->(s)
       AND NOT (s)-[:DEPENDS_ON]->(:Symbol)
     RETURN count(s) AS count`,
    { repoId },
  );
  const scipPhaseRows = await ladybugDb.queryAll<{
    phase: string;
    count: unknown;
  }>(
    conn,
    `MATCH (a:Symbol {repoId: $repoId})-[d:DEPENDS_ON]->(:Symbol)
     WHERE d.resolutionPhase = 'scip' OR d.resolverId = 'scip'
     RETURN d.resolutionPhase AS phase, count(d) AS count`,
    { repoId },
  );
  let placeholderTargetMismatches = 0;
  const placeholderCounts: Record<string, number> = {};
  for (const row of placeholderRows) {
    if (row.symbolId.startsWith("unresolved:")) {
      const meta = classifyDependencyTarget(row.symbolId);
      if (
        row.status !== meta.symbolStatus ||
        (row.kind ?? "") !== (meta.placeholderKind ?? "") ||
        (row.target ?? "") !== (meta.placeholderTarget ?? "")
      ) {
        placeholderTargetMismatches++;
      }
    }
    const key = `${row.status ?? "unknown"}:${row.kind ?? "unknown"}`;
    placeholderCounts[key] = (placeholderCounts[key] ?? 0) + 1;
  }

  return {
    unresolvedTargets: ladybugDb.toNumber(
      unresolvedRow?.unresolvedTargets ?? 0,
    ),
    externalTargets: ladybugDb.toNumber(externalRow?.externalTargets ?? 0),
    untypedPlaceholderTargets: ladybugDb.toNumber(
      untypedRow?.untypedPlaceholderTargets ?? 0,
    ),
    placeholderTargetMismatches,
    isolatedPlaceholders: ladybugDb.toNumber(isolatedRow?.count ?? 0),
    placeholderCounts,
    missingSignatureByKind: Object.fromEntries(
      missingSignatureRows.map((row) => [
        row.kind ?? "unknown",
        ladybugDb.toNumber(row.count),
      ]),
    ),
    scipPhaseCounts: Object.fromEntries(
      scipPhaseRows.map((row) => [
        row.phase ?? "unknown",
        ladybugDb.toNumber(row.count),
      ]),
    ),
  };
}

/**
 * Materialise FileSummary nodes for every file in the repository.
 *
 * For each file, this queries its exported symbols, builds a search-friendly
 * text string, and upserts a FileSummary node in LadybugDB so it can be
 * retrieved by the hybrid-retrieval pipeline.
 */
export async function materializeFileSummaries(
  conn: import("kuzu").Connection,
  repoId: string,
  options?: {
    changedFileIds?: Set<string>;
    preloadedSymbolFactsByFile?: ReadonlyMap<
      string,
      readonly ladybugDb.FileSummarySymbolFactRow[]
    >;
    includeTimings?: boolean;
  },
): Promise<{
  total: number;
  updated: number;
  timings?: Record<string, number>;
}> {
  const timings: Record<string, number> | undefined = options?.includeTimings
    ? {}
    : undefined;
  const measureSubphase = async <T>(
    phaseName: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      if (timings) {
        timings[phaseName] = Date.now() - startedAt;
      }
    }
  };
  const recordSubphase = (phaseName: string, durationMs: number): void => {
    if (timings) {
      timings[phaseName] = durationMs;
    }
  };
  const changedFileIds = options?.changedFileIds;
  let files: ladybugDb.FileRow[];
  const buildResult = (total: number, updated: number) => ({
    total,
    updated,
    ...(timings ? { timings } : {}),
  });

  if (changedFileIds) {
    if (changedFileIds.size === 0) {
      return buildResult(0, 0);
    }

    // Incremental runs only need to refresh FileSummary rows for files whose
    // symbol exports changed; deleted-file cleanup already happens earlier in
    // the file deletion path.
    const fileMap = await measureSubphase("loadFiles", () =>
      ladybugDb.getFilesByIds(conn, [...changedFileIds]),
    );
    files = [...fileMap.values()]
      .filter((file) => file.repoId === repoId)
      .sort((a, b) => a.relPath.localeCompare(b.relPath));
  } else {
    files = await measureSubphase("loadFiles", () =>
      ladybugDb.getFilesByRepo(conn, repoId),
    );
  }
  const updatedAt = new Date().toISOString();

  const fileIds = files.map((f) => f.fileId);
  const targetFileIds = new Set(fileIds);
  const fullRepoSummaryRefresh = changedFileIds === undefined;
  const symbolFactsByFile = clonePreloadedFileSummaryFacts(
    options?.preloadedSymbolFactsByFile,
    targetFileIds,
  );
  const filesMissingPreloadedFacts = files
    .filter((file) => !symbolFactsByFile.has(file.fileId))
    .map((file) => file.fileId);
  const loadedSymbolFactsByFile = await measureSubphase(
    "loadSymbolFacts",
    () => {
      if (filesMissingPreloadedFacts.length === 0) {
        return Promise.resolve(
          new Map<string, ladybugDb.FileSummarySymbolFactRow[]>(),
        );
      }
      if (fullRepoSummaryRefresh && symbolFactsByFile.size === 0) {
        return ladybugDb.getFileSummarySymbolFactsByRepo(conn, repoId);
      }
      return ladybugDb.getFileSummarySymbolFactsByFileIds(
        conn,
        filesMissingPreloadedFacts,
      );
    },
  );
  mergeFileSummarySymbolFacts(symbolFactsByFile, loadedSymbolFactsByFile);
  sortFileSummarySymbolFacts(symbolFactsByFile);
  const exportedByFile = buildExportedNamesByFile(symbolFactsByFile);
  recordSubphase("loadExportedSymbols", 0);
  const existingSummaries = await measureSubphase(
    "loadExistingSummaries",
    async () => {
      if (!fullRepoSummaryRefresh) {
        return ladybugDb.getFileSummariesByFileIds(conn, fileIds);
      }
      const rows = await ladybugDb.getFileSummariesForRepo(conn, repoId);
      return new Map(rows.map((row) => [row.fileId, row]));
    },
  );

  type FileSummaryUpsert = {
    fileId: string;
    repoId: string;
    summary: string | null;
    searchText: string | null;
    updatedAt: string;
  };

  const existingUpserts: FileSummaryUpsert[] = [];
  const newUpserts: FileSummaryUpsert[] = [];

  const buildStartedAt = Date.now();
  for (const file of files) {
    const exportedNames = exportedByFile.get(file.fileId) ?? [];
    const summary = ladybugDb.buildFileSummaryHybridPayload({
      relPath: file.relPath,
      language: file.language,
      symbols: symbolFactsByFile.get(file.fileId) ?? [],
    });
    const searchText = ladybugDb.buildFileSummarySearchText(
      file.relPath,
      exportedNames,
      summary,
    );
    const existing = existingSummaries.get(file.fileId);
    if (
      existing?.repoId === repoId &&
      (existing.summary ?? null) === (summary ?? null) &&
      (existing.searchText ?? null) === (searchText ?? null)
    ) {
      continue;
    }
    const upsert = {
      fileId: file.fileId,
      repoId,
      summary,
      searchText,
      updatedAt,
    };
    if (existing?.repoId === repoId) {
      existingUpserts.push(upsert);
    } else {
      newUpserts.push(upsert);
    }
  }
  recordSubphase("buildPayloads", Date.now() - buildStartedAt);

  const updated = existingUpserts.length + newUpserts.length;
  if (updated > 0) {
    await measureSubphase("writeSummaries", () =>
      withWriteConn(async (wConn) => {
        if (existingUpserts.length > 0) {
          await measureSubphase("writeExistingSummaries", () =>
            ladybugDb.updateExistingFileSummaryBatch(wConn, existingUpserts),
          );
        } else {
          recordSubphase("writeExistingSummaries", 0);
        }

        if (newUpserts.length > 0) {
          await measureSubphase("writeNewSummaries", async () => {
            // LadybugDB 0.16.x native FTS maintenance during bulk node loads
            // is crash-prone (same family as the Cluster/Symbol FTS
            // drop-rebuild workarounds elsewhere in the indexer). Drop the
            // FileSummary FTS index around the COPY lane and recreate it
            // afterwards. If the drop cannot be proven, skip COPY entirely
            // and take the merge-safe upsert path with the index in place —
            // per-row MERGE maintenance is the historically safe shape.
            const ftsDrop = await dropFtsIndex(
              wConn,
              "FileSummary",
              ENTITY_FTS_INDEX_NAMES.fileSummary,
            );
            if (ftsDrop.status === "failed") {
              await ladybugDb.upsertFileSummaryBatch(wConn, newUpserts);
              return;
            }
            try {
              try {
                await ladybugDb.insertNewFileSummaryBatch(wConn, newUpserts);
              } catch (error) {
                logger.warn(
                  "FileSummary COPY insert failed; retrying with merge-safe upsert",
                  { error: error instanceof Error ? error.message : String(error) },
                );
                await ladybugDb.upsertFileSummaryBatch(wConn, newUpserts);
              }
            } finally {
              // Only recreate what we actually dropped; an "absent" result
              // means the index was never there (e.g. deferred on an empty
              // table) and must stay that way for ensureEntityIndexes.
              if (ftsDrop.status === "dropped") {
                await createFtsIndex(
                  wConn,
                  "FileSummary",
                  ENTITY_FTS_INDEX_NAMES.fileSummary,
                );
              }
            }
          });
        } else {
          recordSubphase("writeNewSummaries", 0);
        }
      }),
    );
    if (timings) {
      const activeWriteMs =
        (timings.writeExistingSummaries ?? 0) +
        (timings.writeNewSummaries ?? 0);
      recordSubphase(
        "writeWait",
        Math.max(0, (timings.writeSummaries ?? 0) - activeWriteMs),
      );
    }
  } else {
    recordSubphase("writeSummaries", 0);
    recordSubphase("writeWait", 0);
    recordSubphase("writeExistingSummaries", 0);
    recordSubphase("writeNewSummaries", 0);
  }

  return buildResult(files.length, updated);
}

export function buildPreloadedFileSummarySymbolFactsFromRows(params: {
  files: Iterable<Pick<ladybugDb.FileRow, "fileId">>;
  symbols: Iterable<
    Pick<
      ladybugDb.SymbolRow,
      | "fileId"
      | "name"
      | "kind"
      | "exported"
      | "signatureJson"
      | "summary"
      | "rangeStartLine"
      | "symbolStatus"
    >
  >;
}): Map<string, ladybugDb.FileSummarySymbolFactRow[]> {
  const byFile = new Map<string, ladybugDb.FileSummarySymbolFactRow[]>();
  for (const file of params.files) {
    byFile.set(file.fileId, []);
  }
  for (const symbol of params.symbols) {
    if ((symbol.symbolStatus ?? "real") !== "real") continue;
    const list = byFile.get(symbol.fileId);
    if (!list) continue;
    list.push({
      fileId: symbol.fileId,
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
      signatureJson: symbol.signatureJson,
      summary: symbol.summary,
      rangeStartLine: symbol.rangeStartLine,
    });
  }
  sortFileSummarySymbolFacts(byFile);
  return byFile;
}

function clonePreloadedFileSummaryFacts(
  preloaded:
    | ReadonlyMap<string, readonly ladybugDb.FileSummarySymbolFactRow[]>
    | undefined,
  targetFileIds: ReadonlySet<string>,
): Map<string, ladybugDb.FileSummarySymbolFactRow[]> {
  const cloned = new Map<string, ladybugDb.FileSummarySymbolFactRow[]>();
  if (!preloaded) return cloned;
  for (const [fileId, facts] of preloaded) {
    if (!targetFileIds.has(fileId)) continue;
    cloned.set(
      fileId,
      facts.map((fact) => ({ ...fact })),
    );
  }
  return cloned;
}

function mergeFileSummarySymbolFacts(
  target: Map<string, ladybugDb.FileSummarySymbolFactRow[]>,
  source: ReadonlyMap<string, readonly ladybugDb.FileSummarySymbolFactRow[]>,
): void {
  for (const [fileId, facts] of source) {
    const existing = target.get(fileId);
    if (existing) {
      existing.push(...facts.map((fact) => ({ ...fact })));
    } else {
      target.set(
        fileId,
        facts.map((fact) => ({ ...fact })),
      );
    }
  }
}

function sortFileSummarySymbolFacts(
  factsByFile: Map<string, ladybugDb.FileSummarySymbolFactRow[]>,
): void {
  for (const facts of factsByFile.values()) {
    facts.sort((a, b) => {
      if (a.exported !== b.exported) return a.exported ? -1 : 1;
      return a.rangeStartLine - b.rangeStartLine;
    });
  }
}

function buildExportedNamesByFile(
  factsByFile: ReadonlyMap<
    string,
    readonly ladybugDb.FileSummarySymbolFactRow[]
  >,
): Map<string, string[]> {
  const exportedByFile = new Map<string, string[]>();
  for (const [fileId, facts] of factsByFile) {
    const names = facts
      .filter((fact) => fact.exported)
      .map((fact) => fact.name);
    if (names.length > 0) {
      exportedByFile.set(fileId, names);
    }
  }
  return exportedByFile;
}
