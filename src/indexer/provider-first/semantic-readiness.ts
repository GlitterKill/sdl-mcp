import type { AppConfig } from "../../config/types.js";
import { resolveSemanticEmbeddingModelPlan } from "../../config/semantic-embedding-model-plan.js";
import {
  buildDeferredIndexes,
  getLadybugConn,
  withWriteConn,
} from "../../db/ladybug.js";
import { withExclusiveLadybugOperation } from "../../db/ladybug-operation-gate.js";
import {
  getDerivedStateFromConnection,
  markDerivedStateComputed,
  markDerivedStateDirty,
  markEmbeddingLifecycleRefreshingIfCurrent,
  markEmbeddingLifecycleSteadyIfCurrent,
  recordDerivedStateError,
} from "../../db/ladybug-derived-state.js";
import { IndexError } from "../../domain/errors.js";
import {
  refreshSymbolEmbeddings,
  type EmbeddingMemorySnapshot,
} from "../embeddings.js";
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
import {
  assessRepositorySymbolVectorHealth,
  commitPreparedRepositorySymbolVectorHealthBatch,
  getRepositorySymbolVectorHealthGeneration,
  invalidateRepositorySymbolVectorHealth,
  prepareRepositorySymbolVectorHealthBatch,
  publishRepositorySymbolVectorHealthBatch,
  type SymbolVectorHealthSnapshot,
} from "../../retrieval/health.js";

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

export interface RepositorySemanticLifecycle {
  onFailureInsideGate(error: unknown): Promise<void>;
  onFailureOutsideGate(error: unknown): Promise<void>;
  commitSuccess(
    beforeAssessment?: () => Promise<void>,
  ): Promise<readonly SymbolVectorHealthSnapshot[]>;
  failureFinalizationStartedInsideGate(): boolean;
}

export interface RepositorySemanticLifecycleDeps {
  getConnection?: typeof getLadybugConn;
  withWriteConnection?: typeof withWriteConn;
  getDerivedState?: typeof getDerivedStateFromConnection;
  markRefreshingIfCurrent?: typeof markEmbeddingLifecycleRefreshingIfCurrent;
  markSteadyIfCurrent?: typeof markEmbeddingLifecycleSteadyIfCurrent;
  assess?: typeof assessRepositorySymbolVectorHealth;
  getGeneration?: typeof getRepositorySymbolVectorHealthGeneration;
  invalidate?: typeof invalidateRepositorySymbolVectorHealth;
  prepareSuccessBatch?: typeof prepareRepositorySymbolVectorHealthBatch;
  commitPreparedSuccessBatch?: typeof commitPreparedRepositorySymbolVectorHealthBatch;
  publish?: typeof publishRepositorySymbolVectorHealthBatch;
  recordError?: typeof recordDerivedStateError;
  withExclusiveOperation?: typeof withExclusiveLadybugOperation;
}

export function createRepositorySemanticLifecycle(params: {
  repoId: string;
  versionId: string;
  appConfig: Pick<AppConfig, "semantic">;
  postIndexSessionTimeoutMs?: number;
  /** @internal Fault seam immediately before the durable steady CAS. */
  beforeSteadyCommit?: () => Promise<void> | void;
  deps?: RepositorySemanticLifecycleDeps;
}): RepositorySemanticLifecycle {
  const deps = {
    getConnection: getLadybugConn,
    withWriteConnection: withWriteConn,
    getDerivedState: getDerivedStateFromConnection,
    markRefreshingIfCurrent: markEmbeddingLifecycleRefreshingIfCurrent,
    markSteadyIfCurrent: markEmbeddingLifecycleSteadyIfCurrent,
    assess: assessRepositorySymbolVectorHealth,
    getGeneration: getRepositorySymbolVectorHealthGeneration,
    invalidate: invalidateRepositorySymbolVectorHealth,
    prepareSuccessBatch: prepareRepositorySymbolVectorHealthBatch,
    commitPreparedSuccessBatch: commitPreparedRepositorySymbolVectorHealthBatch,

    publish: publishRepositorySymbolVectorHealthBatch,
    recordError: recordDerivedStateError,
    withExclusiveOperation: withExclusiveLadybugOperation,
    ...params.deps,
  };
  const enabledModels =
    params.appConfig.semantic?.enabled === false
      ? []
      : resolveSemanticEmbeddingModelPlan(params.appConfig.semantic)
          .symbolEmbeddingModels;
  const capturedGeneration = deps.getGeneration(params.repoId);
  let failureStartedInsideGate = false;
  let failureFinalizationPromise: Promise<void> | undefined;

  const hardInvalidate = (): void => {
    try {
      deps.invalidate(
        params.repoId,
        params.versionId,
        params.appConfig.semantic,
        "refreshing",
      );
    } catch {
      // The invalidator removes the repository entry before rethrowing.
    }
  };

  const onFailureInsideGate = (error: unknown): Promise<void> => {
    failureStartedInsideGate = true;
    failureFinalizationPromise ??= (async () => {
      try {
        const marked = await deps.withWriteConnection(
          (writeConn) =>
            deps.markRefreshingIfCurrent(
              writeConn,
              params.repoId,
              params.versionId,
            ),
          params.postIndexSessionTimeoutMs,
        );
        if (!marked) {
          throw new Error(
            `Semantic failure no longer owns ${params.repoId} at ${params.versionId}`,
          );
        }
        await deps.recordError(
          params.repoId,
          `semantic readiness refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );

        if (deps.getGeneration(params.repoId) !== capturedGeneration) {
          throw new Error(
            `Semantic generation changed before failure publication for ${params.repoId}`,
          );
        }
        const conn = await deps.getConnection();
        const snapshots = await deps.assess(conn, {
          repoId: params.repoId,
          versionId: params.versionId,
          generation: capturedGeneration,
          lifecycleState: "refreshing",
          semanticConfig: params.appConfig.semantic,
        });
        const degraded = snapshots.map((snapshot) => ({
          ...snapshot,
          mode: "degraded" as const,
          exactFallbackAllowed: false,
          reason:
            error instanceof Error
              ? error.message
              : "semantic readiness refresh failed",
        }));
        if (
          !deps.publish({
            repoId: params.repoId,
            versionId: params.versionId,
            capturedGeneration,
            enabledModels,
            snapshots: degraded,
          })
        ) {
          throw new Error(
            `Semantic failure publication lost generation ownership for ${params.repoId}`,
          );
        }
      } catch (finalizationError) {
        hardInvalidate();
        throw finalizationError;
      }
    })();
    return failureFinalizationPromise;
  };

  const onFailureOutsideGate = async (error: unknown): Promise<void> => {
    if (failureStartedInsideGate) {
      await failureFinalizationPromise;
      return;
    }
    await deps.withExclusiveOperation(
      () => onFailureInsideGate(error),
      params.postIndexSessionTimeoutMs,
    );
  };

  const commitSuccess = (
    beforeAssessment?: () => Promise<void>,
  ): Promise<readonly SymbolVectorHealthSnapshot[]> =>
    deps.withExclusiveOperation(async () => {
      try {
        await beforeAssessment?.();
        if (deps.getGeneration(params.repoId) !== capturedGeneration) {
          throw new Error(
            `Semantic generation changed before final assessment for ${params.repoId}`,
          );
        }
        const conn = await deps.getConnection();
        const state = await deps.getDerivedState(conn, params.repoId);
        if (
          !state ||
          state.targetVersionId !== params.versionId ||
          !state.embeddingsDirty ||
          state.embeddingLifecycleState !== "refreshing"
        ) {
          throw new Error(
            `Semantic lifecycle ownership changed before final assessment for ${params.repoId}`,
          );
        }

        const snapshots = await deps.assess(conn, {
          repoId: params.repoId,
          versionId: params.versionId,
          generation: capturedGeneration,
          lifecycleState: "steady",
          semanticConfig: params.appConfig.semantic,
        });
        if (snapshots.some((snapshot) => snapshot.mode === "degraded")) {
          throw new Error(
            `Semantic final assessment is incomplete for ${params.repoId}`,
          );
        }
        const preparedBatch = deps.prepareSuccessBatch({
          repoId: params.repoId,
          versionId: params.versionId,
          capturedGeneration,
          enabledModels,
          snapshots,
        });
        if (!preparedBatch) {
          throw new Error(
            `Semantic final assessment is incomplete for ${params.repoId}`,
          );
        }

        await params.beforeSteadyCommit?.();
        if (deps.getGeneration(params.repoId) !== capturedGeneration) {
          throw new Error(
            `Semantic generation changed before steady commit for ${params.repoId}`,
          );
        }
        const marked = await deps.withWriteConnection(
          (writeConn) =>
            deps.markSteadyIfCurrent(
              writeConn,
              params.repoId,
              params.versionId,
            ),
          params.postIndexSessionTimeoutMs,
        );
        if (!marked) {
          throw new Error(
            `Semantic steady commit lost version ownership for ${params.repoId}`,
          );
        }

        // Validation and Map allocation completed before the durable CAS. This
        // synchronous replacement is the only action after durable steady.
        deps.commitPreparedSuccessBatch(preparedBatch);
        return snapshots;
      } catch (error) {
        try {
          await onFailureInsideGate(error);
        } catch (finalizationError) {
          throw new AggregateError(
            [error, finalizationError],
            "Semantic reconciliation and failure finalization both failed",
          );
        }
        throw error;
      }
    }, params.postIndexSessionTimeoutMs);

  return {
    onFailureInsideGate,
    onFailureOutsideGate,
    commitSuccess,
    failureFinalizationStartedInsideGate: () => failureStartedInsideGate,
  };
}

export interface ProviderFirstSemanticReadinessRefreshDeps {
  generateSummariesForRepo?: typeof generateSummariesForRepo;
  refreshFileSummaryEmbeddings?: typeof refreshFileSummaryEmbeddings;
  refreshSymbolEmbeddings?: typeof refreshSymbolEmbeddings;
  buildDeferredIndexes?: typeof buildDeferredIndexes;
  markDerivedStateComputed?: typeof markDerivedStateComputed;
  recordDerivedStateError?: typeof recordDerivedStateError;
  semanticLifecycle?: RepositorySemanticLifecycle;
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
  /** @internal Exact no-op guard result from the structural indexer. */
  skipSymbolVectorLifecycle?: boolean;
  onProgress?: (progress: IndexProgress) => void;
  recordTiming?: (phaseName: string, durationMs: number) => void;
  recordMemorySnapshot?: (
    phaseName: string,
    snapshot: EmbeddingMemorySnapshot,
  ) => void;
  postIndexSessionTimeoutMs?: number;
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
  const semanticLifecycle = params.skipSymbolVectorLifecycle
    ? undefined
    : (params.deps?.semanticLifecycle ??
      createRepositorySemanticLifecycle({
        repoId: params.repoId,
        versionId: params.versionId,
        appConfig: params.appConfig,
        postIndexSessionTimeoutMs: params.postIndexSessionTimeoutMs,
        deps: { recordError: deps.recordDerivedStateError },
      }));

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
  let embeddingsDeferred = false;

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
      retrievalConfig?.vector?.enabled !== false;
    if (shouldRunFileSummaryEmbeddings) {
      fileSummaryEmbeddingStats = {};
      for (const embModel of modelPlan.fileSummaryEmbeddingModels) {
        const stats = await measure(
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
              postIndexSessionTimeoutMs: params.postIndexSessionTimeoutMs,
            }),
        );
        fileSummaryEmbeddingStats[embModel] = stats;
        if (stats.degraded) {
          throw new IndexError(
            `FileSummary embedding refresh incomplete for ${embModel}`,
          );
        }
        if ((stats.deferred ?? 0) > 0) embeddingsDeferred = true;
      }
    }

    for (const embModel of modelPlan.symbolEmbeddingModels) {
      const phaseName = `semanticReadiness.symbolEmbeddings:${embModel}`;
      const stats = await measure(phaseName, () =>
        deps.refreshSymbolEmbeddings({
          repoId: params.repoId,
          provider: semanticConfig.provider ?? "local",
          model: embModel,
          onProgress: params.onProgress,
          concurrency: semanticConfig.embeddingConcurrency,
          batchSize: semanticConfig.embeddingBatchSize,
          vectorEfc: semanticConfig.retrieval?.vector.efc,
          semanticConfig,
          onFailureInsideGate: semanticLifecycle?.onFailureInsideGate,
          postIndexSessionTimeoutMs: params.postIndexSessionTimeoutMs,
          recordTiming: (subphaseName, durationMs) =>
            params.recordTiming?.(`${phaseName}.${subphaseName}`, durationMs),
          recordMemorySnapshot: (subphaseName, snapshot) =>
            params.recordMemorySnapshot?.(
              `${phaseName}.${subphaseName}`,
              snapshot,
            ),
        }),
      );
      if (stats.degraded) {
        throw new IndexError(
          `Symbol embedding refresh incomplete for ${embModel}`,
        );
      }
      if ((stats.deferred ?? 0) > 0) embeddingsDeferred = true;
    }
    if (embeddingsDeferred) {
      throw new IndexError("Semantic embedding refresh remains deferred");
    }
    if (semanticConfig.generateSummaries === true) {
      await deps.markDerivedStateComputed(
        params.repoId,
        params.versionId,
        { summaries: true },
        { clearError: true },
      );
    }
    const buildRequiredDeferredIndexes = () =>
      measure("semanticReadiness.deferredIndexes", () =>
        deps.buildDeferredIndexes({
          deferSemanticTextIndexes: false,
          recordTiming: (phaseName, durationMs) =>
            params.recordTiming?.(
              `semanticReadiness.deferredIndexes.${phaseName}`,
              durationMs,
            ),
        }),
      );
    if (semanticLifecycle) {
      await semanticLifecycle.commitSuccess(buildRequiredDeferredIndexes);
    } else {
      await buildRequiredDeferredIndexes();
    }

    return {
      semanticDeferred: embeddingsDeferred,
      summaryStats,
      fileSummaryEmbeddingStats,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Provider-first semantic readiness refresh failed", {
      repoId: params.repoId,
      error: message,
    });
    try {
      await semanticLifecycle?.onFailureOutsideGate(error);
    } catch (finalizationError) {
      logger.warn("Provider-first semantic failure finalization degraded hard", {
        repoId: params.repoId,
        error:
          finalizationError instanceof Error
            ? finalizationError.message
            : String(finalizationError),
      });
    }
    return {
      semanticDeferred: true,
      summaryStats,
      fileSummaryEmbeddingStats,
    };
  }
}
