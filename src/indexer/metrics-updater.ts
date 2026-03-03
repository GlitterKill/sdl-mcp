import type { AppConfig } from "../config/types.js";
import { logAuditEvent } from "../db/queries.js";
import { updateMetricsForRepo } from "../graph/metrics.js";
import { logger } from "../util/logger.js";
import { refreshSymbolEmbeddings } from "./embeddings.js";
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
  changedFileIds?: Set<number>;
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

  if (appConfig.semantic?.enabled) {
    try {
      await refreshSymbolEmbeddings({
        repoId,
        provider: appConfig.semantic.provider ?? "mock",
        model: appConfig.semantic.model ?? "all-MiniLM-L6-v2",
      });
    } catch (error) {
      logger.warn(`Semantic embedding refresh skipped: ${String(error)}`);
    }
  }

  let summaryStats: SummaryBatchResult | undefined;
  if (appConfig.semantic?.enabled && appConfig.semantic.generateSummaries) {
    try {
      summaryStats = await generateSummariesForRepo(repoId, appConfig);
      logger.info(
        `Summaries: ${summaryStats.generated} generated, ${summaryStats.skipped} cached, ${summaryStats.failed} failed ($${summaryStats.totalCostUsd.toFixed(4)})`,
      );
    } catch (error) {
      logger.warn(`Summary generation skipped: ${String(error)}`);
    }
  }

  if (callResolutionTelemetry.tsFileCount > 0) {
    try {
      logAuditEvent({
        timestamp: new Date().toISOString(),
        tool: "index.callResolution",
        decision: "stats",
        repoId,
        detailsJson: JSON.stringify({
          versionId,
          ...callResolutionTelemetry,
        }),
      });
    } catch (error) {
      logger.warn(`Failed to log call-resolution telemetry: ${String(error)}`);
    }
  }

  return { summaryStats };
}

