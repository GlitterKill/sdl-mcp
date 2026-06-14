import type { AppConfig } from "../../config/types.js";
import { resolveSemanticEmbeddingModelPlan } from "../../config/semantic-embedding-model-plan.js";
import { buildDeferredIndexes } from "../../db/ladybug.js";
import {
  markDerivedStateComputed,
  markDerivedStateDirty,
  recordDerivedStateError,
} from "../../db/ladybug-derived-state.js";
import { refreshSymbolEmbeddings } from "../embeddings.js";
import {
  refreshFileSummaryEmbeddings,
  type FileSummaryEmbeddingRefreshResult,
} from "../file-summary-embeddings.js";
import {
  generateSummariesForRepo,
  type SummaryBatchResult,
} from "../summary-generator.js";
import type { IndexProgress } from "../indexer-init.js";
import { logger } from "../../util/logger.js";

export interface ProviderFirstSemanticReadinessDeferral {
  semanticDeferred: boolean;
  summariesDirty: boolean;
  embeddingsDirty: boolean;
}

export interface ProviderFirstSemanticReadinessRefreshResult {
  semanticDeferred: boolean;
  summaryStats?: SummaryBatchResult;
  fileSummaryEmbeddingStats?: Record<string, FileSummaryEmbeddingRefreshResult>;
}

export interface ProviderFirstSemanticReadinessRefreshDeps {
  generateSummariesForRepo?: typeof generateSummariesForRepo;
  refreshFileSummaryEmbeddings?: typeof refreshFileSummaryEmbeddings;
  refreshSymbolEmbeddings?: typeof refreshSymbolEmbeddings;
  buildDeferredIndexes?: typeof buildDeferredIndexes;
  markDerivedStateComputed?: typeof markDerivedStateComputed;
  recordDerivedStateError?: typeof recordDerivedStateError;
}

export function resolveProviderFirstSemanticReadinessDeferral(
  appConfig: Pick<AppConfig, "semantic">,
): ProviderFirstSemanticReadinessDeferral {
  const semanticDeferred = appConfig.semantic?.enabled === true;
  return {
    semanticDeferred,
    summariesDirty:
      semanticDeferred && appConfig.semantic?.generateSummaries === true,
    embeddingsDirty: semanticDeferred,
  };
}

export async function markProviderFirstSemanticReadinessDeferred(params: {
  repoId: string;
  versionId: string;
  appConfig: Pick<AppConfig, "semantic">;
}): Promise<boolean> {
  const deferral = resolveProviderFirstSemanticReadinessDeferral(
    params.appConfig,
  );
  if (!deferral.semanticDeferred) return false;

  try {
    await markDerivedStateDirty(params.repoId, params.versionId, {
      summaries: deferral.summariesDirty,
      embeddings: deferral.embeddingsDirty,
    });
    return true;
  } catch (error) {
    logger.debug("markDerivedStateDirty provider-first semantic deferred skipped", {
      repoId: params.repoId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function runProviderFirstSemanticReadinessRefresh(params: {
  repoId: string;
  versionId: string;
  appConfig: Pick<AppConfig, "semantic">;
  onProgress?: (progress: IndexProgress) => void;
  recordTiming?: (phaseName: string, durationMs: number) => void;
  deps?: ProviderFirstSemanticReadinessRefreshDeps;
}): Promise<ProviderFirstSemanticReadinessRefreshResult> {
  const semanticConfig = params.appConfig.semantic;
  if (semanticConfig?.enabled !== true) {
    return { semanticDeferred: false };
  }

  const deps = {
    generateSummariesForRepo,
    refreshFileSummaryEmbeddings,
    refreshSymbolEmbeddings,
    buildDeferredIndexes,
    markDerivedStateComputed,
    recordDerivedStateError,
    ...params.deps,
  };

  const measure = async <T>(
    phaseName: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      params.recordTiming?.(phaseName, Date.now() - startedAt);
    }
  };

  let summaryStats: SummaryBatchResult | undefined;
  let fileSummaryEmbeddingStats:
    | Record<string, FileSummaryEmbeddingRefreshResult>
    | undefined;

  try {
    const modelPlan = resolveSemanticEmbeddingModelPlan(semanticConfig);
    if (modelPlan.unsupportedModels.length > 0) {
      logger.warn(
        `Unsupported semantic embedding models skipped: ${modelPlan.unsupportedModels.join(", ")}`,
      );
    }

    if (semanticConfig.generateSummaries) {
      summaryStats = await measure("semanticReadiness.summaries", () =>
        deps.generateSummariesForRepo(
          params.repoId,
          params.appConfig as AppConfig,
          params.onProgress,
        ),
      );
    }

    const retrievalConfig = semanticConfig.retrieval;
    const shouldRunFileSummaryEmbeddings =
      (retrievalConfig?.mode ?? "hybrid") === "hybrid" &&
      retrievalConfig?.vector?.enabled !== false;
    if (shouldRunFileSummaryEmbeddings) {
      fileSummaryEmbeddingStats = {};
      for (const embModel of modelPlan.fileSummaryEmbeddingModels) {
        fileSummaryEmbeddingStats[embModel] = await measure(
          `semanticReadiness.fileSummaryEmbeddings:${embModel}`,
          () =>
            deps.refreshFileSummaryEmbeddings({
              repoId: params.repoId,
              provider: semanticConfig.provider ?? "local",
              model: embModel,
              onProgress: params.onProgress,
              concurrency: semanticConfig.embeddingConcurrency,
              batchSize: semanticConfig.fileSummaryEmbeddingBatchSize,
              maxChars: semanticConfig.fileSummaryEmbeddingMaxChars,
            }),
        );
      }
    }

    for (const embModel of modelPlan.symbolEmbeddingModels) {
      await measure(`semanticReadiness.symbolEmbeddings:${embModel}`, () =>
        deps.refreshSymbolEmbeddings({
          repoId: params.repoId,
          provider: semanticConfig.provider ?? "local",
          model: embModel,
          onProgress: params.onProgress,
          concurrency: semanticConfig.embeddingConcurrency,
          batchSize: semanticConfig.embeddingBatchSize,
        }),
      );
    }

    await measure("semanticReadiness.deferredIndexes", () =>
      deps.buildDeferredIndexes({
        deferSemanticVectorIndexes: false,
        deferSemanticTextIndexes: false,
        recordTiming: (phaseName, durationMs) =>
          params.recordTiming?.(
            `semanticReadiness.deferredIndexes.${phaseName}`,
            durationMs,
          ),
      }),
    );

    await deps.markDerivedStateComputed(params.repoId, params.versionId, {
      summaries: semanticConfig.generateSummaries === true,
      embeddings: true,
    });

    return {
      semanticDeferred: false,
      summaryStats,
      fileSummaryEmbeddingStats,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Provider-first semantic readiness refresh failed", {
      repoId: params.repoId,
      error: message,
    });
    await deps.recordDerivedStateError(
      params.repoId,
      `semantic readiness refresh failed: ${message}`,
    );
    await markProviderFirstSemanticReadinessDeferred({
      repoId: params.repoId,
      versionId: params.versionId,
      appConfig: params.appConfig,
    });
    return {
      semanticDeferred: true,
      summaryStats,
      fileSummaryEmbeddingStats,
    };
  }
}
