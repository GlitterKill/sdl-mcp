import * as crypto from "crypto";

import type { AppConfig } from "../config/types.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { updateMetricsForRepo } from "../graph/metrics.js";
import { logger } from "../util/logger.js";
import { refreshSymbolEmbeddings } from "./embeddings.js";
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
  onProgress?: (progress: IndexProgress) => void;
}

export interface FinalizeIndexingResult {
  summaryStats?: SummaryBatchResult;
  timings?: Record<string, number>;
  sharedGraph?: {
    callEdges: Array<{ callerId: string; calleeId: string }>;
    clusterEdges: Array<{ fromSymbolId: string; toSymbolId: string }>;
  };
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
  const semanticConfig = appConfig.semantic;
  const shouldRunSemanticRefresh =
    semanticConfig?.enabled &&
    (changedFileIds === undefined || changedFileIds.size > 0);

  if (shouldRunSemanticRefresh) {
    const model = semanticConfig.model ?? "jina-embeddings-v2-base-code";

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

    /* sdl.context: multi-model embedding pass.
     *
     * P3: Run models in parallel. Each model owns an independent ONNX
     * session and writes to a distinct vec column on the Symbol node, so
     * the only shared resource is the LadybugDB write lock — and that
     * lock is already serialized by withWriteConn() inside each pass.
     * Running them concurrently overlaps ONNX inference (CPU-bound) with
     * each other's idle write-lock waits, roughly halving wall time when
     * two models are configured AND at least one stays on the per-row
     * write path.
     *
     * Trade-off when both models exceed VECTOR_REBUILD_THRESHOLD: both
     * passes drop their HNSW index, share the writeLimiter slot for
     * batched writes, and each rebuilds at the end. Wall time is no
     * worse than sequential (writes serialize through the lock either
     * way) but the index-down window for each model spans the union of
     * both passes' write phases. During that window, hybrid retrieval
     * for either model degrades to FTS+other-model only — orchestrator
     * silently catches QUERY_VECTOR_INDEX failures and returns []. The
     * window is bounded by total bulk-write time (typically tens of
     * seconds), and only first-time / full-reindex runs hit it.
     *
     * Per-model embeddingConcurrency now defaults to 1: with the batched
     * UNWIND writes (P1) and the HNSW rebuild path (P2), the dominant
     * cost is ONNX inference itself rather than write contention, and a
     * single batch fully utilises the ONNX thread pool. Concurrency >1
     * just oversubscribes CPUs across the parallel model passes. */
    const extraModels = semanticConfig.additionalModels ?? [];
    const modelsToEmbed: string[] = [
      model,
      ...extraModels.filter((m) => m !== model),
    ];
    await Promise.all(
      modelsToEmbed.map(async (embModel) => {
        try {
          const embResult = await measureSubphase(
            `semanticEmbeddings:${embModel}`,
            () =>
              refreshSymbolEmbeddings({
                repoId,
                provider: semanticConfig.provider ?? "local",
                model: embModel,
                onProgress,
                concurrency: semanticConfig.embeddingConcurrency,
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
      }),
    );
  }

  return { summaryStats, timings, sharedGraph: metricsResult.sharedGraph };
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

  const upserts: Array<{
    fileId: string;
    repoId: string;
    summary: string | null;
    searchText: string | null;
    updatedAt: string;
  }> = [];

  for (const file of files) {
    const exportedNames = exportedByFile.get(file.fileId) ?? [];
    const searchText = ladybugDb.buildFileSummarySearchText(
      file.relPath,
      exportedNames,
    );
    upserts.push({
      fileId: file.fileId,
      repoId,
      summary: null,
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
