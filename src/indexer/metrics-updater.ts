import * as crypto from "crypto";

import type { AppConfig } from "../config/types.js";
import { withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { updateMetricsForRepo } from "../graph/metrics.js";
import { logger } from "../util/logger.js";
import { refreshSymbolEmbeddings } from "./embeddings.js";
import { getAnnIndexManager } from "./ann-index.js";
import type { CallResolutionTelemetry } from "./edge-builder.js";
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
}: FinalizeIndexingParams): Promise<FinalizeIndexingResult> {
  await updateMetricsForRepo(repoId, changedFileIds);

  let summaryStats: SummaryBatchResult | undefined;

  if (appConfig.semantic?.enabled) {
    const model = appConfig.semantic.model ?? "all-MiniLM-L6-v2";
    const isCodeModel = model === "nomic-embed-code-v1";

    // 1. Summaries first (if opted-in AND using MiniLM) — so MiniLM can embed them.
    //    nomic-embed-code doesn't need summaries — it understands code natively.
    if (appConfig.semantic.generateSummaries && !isCodeModel) {
      try {
        summaryStats = await generateSummariesForRepo(repoId, appConfig);
        logger.info(
          `Summaries: ${summaryStats.generated} generated, ${summaryStats.skipped} cached, ${summaryStats.failed} failed ($${summaryStats.totalCostUsd.toFixed(4)})`,
        );
      } catch (error) {
        logger.warn(`Summary generation skipped: ${String(error)}`);
      }
    } else if (appConfig.semantic.generateSummaries && isCodeModel) {
      logger.info(
        `nomic-embed-code-v1 selected — skipping LLM summary generation (model understands code natively)`,
      );
    }

    // 2. Embeddings second — uses summaries when available (MiniLM high-tier),
    //    or raw symbol text (MiniLM low-tier and nomic medium-tier).
    try {
      const embResult = await refreshSymbolEmbeddings({
        repoId,
        provider: appConfig.semantic.provider ?? "local",
        model,
      });
      logger.info(
        `Embeddings: ${embResult.embedded} embedded, ${embResult.skipped} cached (model: ${model})`,
      );
    } catch (error) {
      logger.warn(`Semantic embedding refresh skipped: ${String(error)}`);
    }

    // 3. ANN index rebuild (enabled by default now).
    if (appConfig.semantic.ann?.enabled !== false) {
      try {
        const annManager = getAnnIndexManager(appConfig.semantic.ann);
        const annResult = await annManager.buildIndex({ repoId, model });
        logger.info(
          `ANN index: ${annResult.indexed} indexed, ${annResult.skipped} skipped`,
        );
      } catch (error) {
        logger.warn(`ANN index build skipped: ${String(error)}`);
      }
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

  return { summaryStats };
}
