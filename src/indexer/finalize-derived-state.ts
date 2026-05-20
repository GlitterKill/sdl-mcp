import type { Connection } from "kuzu";

import { computeAndStoreClustersAndProcesses } from "./cluster-orchestrator.js";
import type { IndexProgress } from "./indexer-init.js";
import { logger } from "../util/logger.js";

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
  onProgress?: (progress: IndexProgress) => void;
  sharedGraph?: {
    callEdges: Array<{ callerId: string; calleeId: string }>;
    clusterEdges: Array<{ fromSymbolId: string; toSymbolId: string }>;
  };
  measurePhase: <T>(phaseName: string, fn: () => Promise<T> | T) => Promise<T>;
}

export interface FinalizeDerivedStateResult {
  clustersComputed: number;
  processesTraced: number;
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
    onProgress,
    sharedGraph,
    measurePhase,
  } = params;

  let clustersComputed = 0;
  let processesTraced = 0;

  try {
    const result = await measurePhase("clustersAndProcesses", () =>
      computeAndStoreClustersAndProcesses({
        conn,
        repoId,
        versionId,
        includeTimings: Boolean(phaseTimings),
        onProgress,
        sharedGraph,
      }),
    );
    clustersComputed = result.clustersComputed;
    processesTraced = result.processesTraced;
    if (phaseTimings && result.timings) {
      for (const [phaseName, durationMs] of Object.entries(result.timings)) {
        phaseTimings[`clustersAndProcesses.${phaseName}`] = durationMs;
      }
    }
    try {
      await markDerivedStateComputed(repoId, versionId);
    } catch (error) {
      logger.debug("markDerivedStateComputed skipped", {
        repoId,
        error: error instanceof Error ? error.message : String(error),
      });
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

  return { clustersComputed, processesTraced };
}
