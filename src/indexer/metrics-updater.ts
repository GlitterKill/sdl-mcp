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
  callResolutionTelemetry: CallResolutionTelemetry;
  onProgress?: (progress: IndexProgress) => void;
}

export interface FinalizeIndexingResult {
  summaryStats?: SummaryBatchResult;
}

export async function finalizeIndexing({
  repoId,
  versionId,
  appConfig,
  changedFileIds,
  callResolutionTelemetry,
  onProgress,
}: FinalizeIndexingParams): Promise<FinalizeIndexingResult> {
  await updateMetricsForRepo(repoId, changedFileIds);

  let summaryStats: SummaryBatchResult | undefined;

  if (appConfig.semantic?.enabled) {
    const model = appConfig.semantic.model ?? "all-MiniLM-L6-v2";


    // 1. LLM Summaries (if opted-in) — all text-based models benefit from
    //    LLM summaries when available. Summaries are generated before embeddings
    //    so the embedding step can incorporate them.
    if (appConfig.semantic.generateSummaries) {
      try {
        summaryStats = await generateSummariesForRepo(repoId, appConfig, onProgress);
        logger.info(
          `Summaries: ${summaryStats.generated} generated, ${summaryStats.skipped} cached, ${summaryStats.failed} failed ($${summaryStats.totalCostUsd.toFixed(4)})`,
        );
      } catch (error) {
        logger.warn(`Summary generation skipped: ${String(error)}`);
      }
    }

    // 2. Embeddings — uses summaries when available (High tier),
    //    or raw symbol text (Low/Medium tier).
    try {
      const embResult = await refreshSymbolEmbeddings({
        repoId,
        provider: appConfig.semantic.provider ?? "local",
        model,
        onProgress,
      });
      logger.info(
        `Embeddings: ${embResult.embedded} embedded, ${embResult.skipped} cached (model: ${model})`,
      );
    } catch (error) {
      logger.warn(`Semantic embedding refresh skipped: ${String(error)}`);
    }
  }


  if (callResolutionTelemetry.pass2EligibleFileCount > 0) {
    try {
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
    } catch (error) {
      logger.warn(`Failed to log call-resolution telemetry: ${String(error)}`);
    }
  }


  // Materialise FileSummary nodes for hybrid entity retrieval.
  try {
    const conn = await getLadybugConn();
    const fsResult = await materializeFileSummaries(conn, repoId);
    logger.info(
      `FileSummary materialisation: ${fsResult.updated}/${fsResult.total} files updated`,
    );
  } catch (error) {
    logger.warn(`FileSummary materialisation skipped: ${String(error)}`);
  }

  return { summaryStats };
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
): Promise<{ total: number; updated: number }> {
  const files = await ladybugDb.getFilesByRepo(conn, repoId);
  let updated = 0;

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
        updatedAt: new Date().toISOString(),
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
