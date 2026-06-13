import type { Connection } from "kuzu";

import type { FoldedCentralityResult } from "../graph/metrics.js";
import {
  computeAndStoreClustersAndProcesses,
  type AlgorithmRefreshDiagnostics,
} from "./cluster-orchestrator.js";
import type { IndexProgress } from "./indexer-init.js";
import { logger } from "../util/logger.js";
import type { AlgorithmRefreshConfig } from "../config/types.js";

import {
  markDerivedStateComputed,
  markDerivedStateDirty,
  recordDerivedStateError,
} from "../db/ladybug-derived-state.js";

export interface FinalizeDerivedStateParams {
  mode: "full" | "incremental";
  conn: Connection;
  repoId: string;
  versionId: string;
  filesTotal: number;
  phaseTimings: Record<string, number> | null;
  algorithmRefresh?: AlgorithmRefreshConfig;
  onProgress?: (progress: IndexProgress) => void;
  extraPhaseTimings?: Record<string, number>;
  sharedGraph?: {
    callEdges: Array<{ callerId: string; calleeId: string }>;
    clusterEdges: Array<{ fromSymbolId: string; toSymbolId: string }>;
  };
  foldedCentrality?: FoldedCentralityResult;
  measurePhase: <T>(phaseName: string, fn: () => Promise<T> | T) => Promise<T>;
}

export interface FinalizeDerivedStateResult {
  clustersComputed: number;
  processesTraced: number;
  algorithmRefresh: AlgorithmRefreshDiagnostics;
}

export async function finalizeDerivedState(
  params: FinalizeDerivedStateParams,
): Promise<FinalizeDerivedStateResult> {
  const {
    mode,
    conn,
    repoId,
    versionId,
    phaseTimings,
    algorithmRefresh,
    onProgress,
    extraPhaseTimings,
    sharedGraph,
    foldedCentrality,
    measurePhase,
  } = params;

  let clustersComputed = 0;
  let processesTraced = 0;
  let algorithmDiagnostics: AlgorithmRefreshDiagnostics = {
    enabled: Boolean(algorithmRefresh?.enabled ?? true),
    dirty: false,
    pageRank: { status: "skipped", count: 0, reason: "not-run" },
    kCore: { status: "skipped", count: 0, reason: "not-run" },
    louvain: { status: "skipped", count: 0, reason: "not-run" },
    failures: [],
  };

  try {
    try {
      await markDerivedStateDirty(repoId, versionId, {
        algorithms: Boolean(algorithmRefresh?.enabled ?? true),
      });
    } catch (dirtyError) {
      logger.debug("markDerivedStateDirty algorithms skipped", {
        repoId,
        error: dirtyError instanceof Error
          ? dirtyError.message
          : String(dirtyError),
      });
    }
    const result = await measurePhase("clustersAndProcesses", () =>
      computeAndStoreClustersAndProcesses({
        conn,
        repoId,
        versionId,
        algorithmRefresh,
        includeTimings: Boolean(phaseTimings || extraPhaseTimings),
        centralityMetricsMaterialized: true,
        foldedCentrality,
        onProgress,
        sharedGraph,
      }),
    );
    clustersComputed = result.clustersComputed;
    processesTraced = result.processesTraced;
    algorithmDiagnostics = result.algorithmRefresh;
    if (phaseTimings && result.timings) {
      for (const [phaseName, durationMs] of Object.entries(result.timings)) {
        phaseTimings[`clustersAndProcesses.${phaseName}`] = durationMs;
      }
    }
    if (extraPhaseTimings && result.timings) {
      for (const [phaseName, durationMs] of Object.entries(result.timings)) {
        extraPhaseTimings[`clustersAndProcesses.${phaseName}`] = durationMs;
      }
    }
    try {
      await markDerivedStateComputed(
        repoId,
        versionId,
        {
          clusters: true,
          processes: true,
          algorithms: !algorithmDiagnostics.dirty,
          summaries: true,
          embeddings: true,
        },
        { clearError: !algorithmDiagnostics.dirty },
      );
    } catch (error) {
      logger.debug("markDerivedStateComputed skipped", {
        repoId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (algorithmDiagnostics.dirty) {
      await recordDerivedStateError(
        repoId,
        algorithmDiagnostics.failures.join("; ") || "algorithm refresh failed",
      );
    }
  } catch (error) {
    logger.warn("Cluster/process computation failed; continuing without it", {
      repoId,
      mode,
      error,
    });
    const message = error instanceof Error ? error.message : String(error);
    try {
      await markDerivedStateDirty(repoId, versionId, {
        clusters: true,
        processes: true,
        algorithms: true,
        summaries: true,
        embeddings: true,
      });
    } catch (dirtyError) {
      logger.debug("markDerivedStateDirty skipped", {
        repoId,
        error: dirtyError instanceof Error
          ? dirtyError.message
          : String(dirtyError),
      });
    }
    await recordDerivedStateError(repoId, message);
  }

  return {
    clustersComputed,
    processesTraced,
    algorithmRefresh: algorithmDiagnostics,
  };
}
