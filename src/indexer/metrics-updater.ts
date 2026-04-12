import * as crypto from "crypto";

import type { AppConfig } from "../config/types.js";
import { withTransaction } from "../db/ladybug-core.js";
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
  hasIndexMutations?: boolean;
  includeTimings?: boolean;
  callResolutionTelemetry: CallResolutionTelemetry;
  onProgress?: (progress: IndexProgress) => void;
}

export interface FinalizeIndexingResult {
  summaryStats?: SummaryBatchResult;
  timings?: Record<string, number>;
}

export async function finalizeIndexing({
  repoId,
  versionId,
  appConfig,
  changedFileIds,
  hasIndexMutations,
  includeTimings,
  callResolutionTelemetry,
  onProgress,
}: FinalizeIndexingParams): Promise<FinalizeIndexingResult> {
  const timings: Record<string, number> | undefined = includeTimings ? {} : undefined;
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
  if (changedFileIds && changedFileIds.size === 0 && hasIndexMutations === false) {
    logger.debug("Skipping finalizeIndexing for no-op incremental refresh", {
      repoId,
    });
    return { timings };
  }

  const metricsResult = await measureSubphase("metrics", () =>
    updateMetricsForRepo(repoId, changedFileIds, {
      includeTimings,
    }),
  );
  if (timings && metricsResult.timings) {
    for (const [phaseName, durationMs] of Object.entries(metricsResult.timings)) {
      timings[`metrics.${phaseName}`] = durationMs;
    }
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

    try {
      const embResult = await measureSubphase("semanticEmbeddings", () =>
        refreshSymbolEmbeddings({
          repoId,
          provider: semanticConfig.provider ?? "local",
          model,
          onProgress,
        }),
      );
      logger.info(
        `Embeddings: ${embResult.embedded} embedded, ${embResult.skipped} cached (model: ${model})`,
      );
    } catch (error) {
      logger.warn(`Semantic embedding refresh skipped: ${String(error)}`);
    }
  }

  if (callResolutionTelemetry.pass2EligibleFileCount > 0) {
    try {
      await measureSubphase("audit", async () => {
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
      });
    } catch (error) {
      logger.warn(`Failed to log call-resolution telemetry: ${String(error)}`);
    }
  }

  try {
    const fsResult = await measureSubphase("fileSummaries", async () => {
      const conn = await getLadybugConn();
      return materializeFileSummaries(conn, repoId, {
        changedFileIds,
      });
    });
    logger.info(
      `FileSummary materialisation: ${fsResult.updated}/${fsResult.total} files updated`,
    );
  } catch (error) {
    logger.warn(`FileSummary materialisation skipped: ${String(error)}`);
  }

  return { summaryStats, timings };
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
  let updated = 0;
  const updatedAt = new Date().toISOString();

  // Collect all upserts, then batch-write via the serialized write connection
  // to avoid writing on a read-pool connection (which can crash Kuzu).
  const upserts: Array<{
    fileId: string;
    repoId: string;
    summary: string | null;
    searchText: string | null;
    updatedAt: string;
  }> = [];

  for (const file of files) {
    try {
      const symbols = await ladybugDb.getSymbolsByFile(conn, file.fileId);
      const exportedNames = symbols
        .filter((s) => s.exported)
        .map((s) => s.name);

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
    } catch (err) {
      logger.warn(
        `materializeFileSummaries: failed for ${file.relPath}: ${String(err)}`,
      );
    }
  }

  if (upserts.length > 0) {
    await withWriteConn(async (wConn) => {
      await withTransaction(wConn, async (txConn) => {
        for (const params of upserts) {
          await ladybugDb.upsertFileSummary(txConn, params);
          updated++;
        }
      });
    });
  }

  return { total: files.length, updated };
}
