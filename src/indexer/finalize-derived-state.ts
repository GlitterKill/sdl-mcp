import type { Connection } from "kuzu";

import { computeAndStoreClustersAndProcesses } from "./cluster-orchestrator.js";
import type { IndexProgress } from "./indexer-init.js";
import { logger } from "../util/logger.js";

import {
  markDerivedStateComputed,
  markDerivedStateDirty,
} from "../db/ladybug-derived-state.js";
import { enqueueDerivedRefresh } from "./derived-refresh-queue.js";
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
    filesTotal,
    phaseTimings,
    onProgress,
    sharedGraph,
    measurePhase,
  } = params;

  let clustersComputed = 0;
  let processesTraced = 0;

  if (mode === "full") {
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
        error,
      });
    }
    return { clustersComputed, processesTraced };
  }

  try {
    await markDerivedStateDirty(repoId, versionId, {
      clusters: true,
      processes: true,
      algorithms: true,
      summaries: true,
      embeddings: true,
    });
  } catch (error) {
    logger.debug("markDerivedStateDirty skipped", {
      repoId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  onProgress?.({
    stage: "finalizing",
    current: 0,
    total: filesTotal,
    substage: "clusterRefresh",
    message: "deferred",
  });
  onProgress?.({
    stage: "finalizing",
    current: 0,
    total: filesTotal,
    substage: "processRefresh",
    message: "deferred",
  });
  onProgress?.({
    stage: "finalizing",
    current: 0,
    total: filesTotal,
    substage: "algorithmRefresh",
    message: "deferred",
  });

  try {
    enqueueDerivedRefresh(repoId, versionId);
  } catch (error) {
    logger.debug("enqueueDerivedRefresh skipped", {
      repoId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { clustersComputed, processesTraced };
}
