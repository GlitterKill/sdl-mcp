import * as crypto from "crypto";

import type { AppConfig } from "../config/types.js";
import { resolveSemanticEmbeddingModelPlan } from "../config/semantic-embedding-model-plan.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { classifyDependencyTarget } from "../db/symbol-placeholders.js";
import { updateMetricsForRepo } from "../graph/metrics.js";
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
      const repaired = await ladybugDb.normalizeDependencyPlaceholderSymbols(
        wConn,
        repoId,
      );
      const pruned = await ladybugDb.pruneIsolatedPlaceholderSymbols(
        wConn,
        repoId,
      );
      if (
        repaired.fileBackedRepaired > 0 ||
        repaired.dependencyPlaceholdersRepaired > 0 ||
        pruned > 0
      ) {
        logger.info(
          "Normalized dependency placeholder quality",
          {
            repoId,
            fileBackedRepaired: repaired.fileBackedRepaired,
            dependencyPlaceholdersRepaired:
              repaired.dependencyPlaceholdersRepaired,
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
    }),
  );
  const fileSummariesTask = measureSubphase("fileSummaries", async () => {
    const fsConn = await getLadybugConn();
    return materializeFileSummaries(fsConn, repoId, { changedFileIds });
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
  },
): Promise<{ total: number; updated: number }> {
  const changedFileIds = options?.changedFileIds;
  let files: ladybugDb.FileRow[];

  if (changedFileIds) {
    if (changedFileIds.size === 0) {
      return { total: 0, updated: 0 };
    }

    // Incremental runs only need to refresh FileSummary rows for files whose
    // symbol exports changed; deleted-file cleanup already happens earlier in
    // the file deletion path.
    const fileMap = await ladybugDb.getFilesByIds(conn, [...changedFileIds]);
    files = [...fileMap.values()]
      .filter((file) => file.repoId === repoId)
      .sort((a, b) => a.relPath.localeCompare(b.relPath));
  } else {
    files = await ladybugDb.getFilesByRepo(conn, repoId);
  }
  const updatedAt = new Date().toISOString();

  // Grouped read: fetch exported symbol names for all target files in one
  // round trip instead of one query per file.
  const fileIds = files.map((f) => f.fileId);
  const exportedByFile = await ladybugDb.getExportedSymbolsByFileIds(
    conn,
    fileIds,
  );
  const symbolFactsByFile = await ladybugDb.getFileSummarySymbolFactsByFileIds(
    conn,
    fileIds,
  );

  const upserts: Array<{
    fileId: string;
    repoId: string;
    summary: string | null;
    searchText: string | null;
    updatedAt: string;
  }> = [];

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
    upserts.push({
      fileId: file.fileId,
      repoId,
      summary,
      searchText,
      updatedAt,
    });
  }

  if (upserts.length > 0) {
    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertFileSummaryBatch(wConn, upserts);
    });
  }

  return { total: files.length, updated: upserts.length };
}
