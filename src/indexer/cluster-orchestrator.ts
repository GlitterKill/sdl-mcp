import type { Connection } from "kuzu";

import * as ladybugDb from "../db/ladybug-queries.js";
import { buildClusterSearchText } from "../db/ladybug-clusters.js";
import { buildProcessSearchText } from "../db/ladybug-processes.js";
import { withWriteConn } from "../db/ladybug.js";
import { logger } from "../util/logger.js";
import { computeClustersTS } from "../graph/cluster.js";
import { traceProcessesTS } from "../graph/process.js";
import { computeClustersRust, traceProcessesRust } from "./rustIndexer.js";
import {
  detectAlgoCapability,
  resetRepoGraphProjection,
  runLouvain,
} from "../db/ladybug-algorithms.js";
import {
  upsertCentralityBatch,
  upsertShadowCluster,
  upsertShadowClusterMembersBatch,
  deleteShadowClustersByRepo,
} from "../db/ladybug-queries.js";
import {
  dropFtsIndex,
  ensureFtsIndexForNonEmptyTable,
  ENTITY_FTS_INDEX_NAMES,
} from "../retrieval/index-lifecycle.js";
import type { AlgorithmRefreshConfig } from "../config/types.js";
import { DEFAULT_LOUVAIN_MAX_CALL_EDGES } from "../config/constants.js";
import {
  CentralityWorkerTimeoutError,
  runCentralityWorker,
  type CentralityWorkerResult,
} from "./centrality-worker-runner.js";

const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_MAX_PROCESS_DEPTH = 20;

const DEFAULT_ENTRY_PATTERNS = [
  "^main$",
  "^index$",
  "handler",
  "^run$",
  "^start$",
];

const DEFAULT_ALGORITHM_REFRESH_CONFIG: AlgorithmRefreshConfig = {
  enabled: true,
  pageRank: { enabled: true },
  kCore: { enabled: true },
  louvain: { enabled: true, maxCallEdges: DEFAULT_LOUVAIN_MAX_CALL_EDGES },
  workerTimeoutMs: 120_000,
};

export type ClusterFtsDropStatus = "dropped" | "absent" | "skipped";

// Cluster FTS is table-wide, so rebuild decisions cannot use only the
// currently refreshed repo's cluster count.
export function shouldRebuildClusterFtsAfterReplacement(params: {
  replaceClusters: boolean;
  replacementError: unknown;
  dropStatus: ClusterFtsDropStatus;
  totalClusterCount: number;
}): boolean {
  if (!params.replaceClusters) return false;
  if (params.replacementError !== undefined && params.dropStatus !== "dropped") {
    return false;
  }
  return params.totalClusterCount > 0;
}

export function shouldFailOnClusterFtsRebuildFailure(params: {
  dropStatus: ClusterFtsDropStatus;
}): boolean {
  return params.dropStatus === "dropped";
}

export interface ClusterOrchestratorResult {
  clustersComputed: number;
  processesTraced: number;
  centralityComputed: number;
  shadowClustersComputed: number;
  algorithmRefresh: AlgorithmRefreshDiagnostics;
  timings?: Record<string, number>;
}

export type AlgorithmWorkStatus =
  | "disabled"
  | "skipped"
  | "succeeded"
  | "failed"
  | "timedOut";

export interface AlgorithmWorkDiagnostic {
  status: AlgorithmWorkStatus;
  count: number;
  reason?: string | undefined;
}

export interface AlgorithmRefreshDiagnostics {
  enabled: boolean;
  dirty: boolean;
  pageRank: AlgorithmWorkDiagnostic;
  kCore: AlgorithmWorkDiagnostic;
  louvain: AlgorithmWorkDiagnostic;
  failures: string[];
}

type CentralityRunner = (
  input: {
    symbolIds: readonly string[];
    callEdges: readonly { callerId: string; calleeId: string }[];
    pageRankEnabled: boolean;
    kCoreEnabled: boolean;
  },
  timeoutMs: number,
) => Promise<CentralityWorkerResult>;

function createAlgorithmDiagnostics(
  enabled: boolean,
): AlgorithmRefreshDiagnostics {
  const status: AlgorithmWorkStatus = enabled ? "skipped" : "disabled";
  const reason = enabled ? "not-run" : "disabled";
  return {
    enabled,
    dirty: false,
    pageRank: { status, count: 0, reason },
    kCore: { status, count: 0, reason },
    louvain: { status, count: 0, reason },
    failures: [],
  };
}

async function clearLouvainShadowClusters(
  repoId: string,
  reason: string,
): Promise<void> {
  await withWriteConn(async (wConn) => {
    await deleteShadowClustersByRepo(wConn, repoId);
  });
  logger.debug("ladybug-algorithms: cleared Louvain shadow clusters", {
    repoId,
    reason,
  });
}

interface NextClusterState {
  clusterId: string;
  label: string;
  symbolCount: number;
  searchText: string;
  members: Array<{ symbolId: string; membershipScore: number }>;
}

interface NextProcessState {
  processId: string;
  entrySymbolId: string;
  label: string;
  depth: number;
  searchText: string;
  steps: Array<{ symbolId: string; stepOrder: number; role: string }>;
}

function serializeClusterState(states: NextClusterState[]): string {
  return JSON.stringify(
    states.map((state) => ({
      clusterId: state.clusterId,
      label: state.label,
      symbolCount: state.symbolCount,
      searchText: state.searchText,
      members: state.members,
    })),
  );
}

function serializeProcessState(states: NextProcessState[]): string {
  return JSON.stringify(
    states.map((state) => ({
      processId: state.processId,
      entrySymbolId: state.entrySymbolId,
      label: state.label,
      depth: state.depth,
      searchText: state.searchText,
      steps: state.steps,
    })),
  );
}

export async function computeAndStoreClustersAndProcesses(params: {
  conn: Connection;
  repoId: string;
  versionId: string;
  entryPatterns?: string[];
  minClusterSize?: number;
  maxProcessDepth?: number;
  algorithmRefresh?: AlgorithmRefreshConfig;
  centralityRunner?: CentralityRunner;
  algorithmCapabilityDetector?: typeof detectAlgoCapability;
  louvainRunner?: typeof runLouvain;
  includeTimings?: boolean;
  onProgress?: (progress: import("./indexer-init.js").IndexProgress) => void;
  sharedGraph?: {
    callEdges: Array<{ callerId: string; calleeId: string }>;
    clusterEdges: Array<{ fromSymbolId: string; toSymbolId: string }>;
  };
}): Promise<ClusterOrchestratorResult> {
  const {
    conn,
    repoId,
    versionId,
    entryPatterns = DEFAULT_ENTRY_PATTERNS,
    minClusterSize = DEFAULT_MIN_CLUSTER_SIZE,
    maxProcessDepth = DEFAULT_MAX_PROCESS_DEPTH,
    algorithmRefresh = DEFAULT_ALGORITHM_REFRESH_CONFIG,
    centralityRunner = runCentralityWorker,
    algorithmCapabilityDetector = detectAlgoCapability,
    louvainRunner = runLouvain,
    includeTimings = false,
    onProgress,
    sharedGraph,
  } = params;
  const emitSubstage = (
    substage: import("./indexer-init.js").IndexProgressSubstage,
    message?: string,
  ): void => {
    if (!onProgress) return;
    onProgress({
      stage: "finalizing",
      current: 0,
      total: 0,
      substage,
      ...(message ? { message } : {}),
    });
  };

  const startMs = Date.now();
  const now = new Date().toISOString();
  const timings: Record<string, number> | undefined = includeTimings
    ? {}
    : undefined;
  const measureSubphase = async <T>(
    phaseName: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const phaseStart = Date.now();
    try {
      return await fn();
    } finally {
      if (timings) {
        timings[phaseName] = Date.now() - phaseStart;
      }
    }
  };

  // Cluster/process computation only needs symbol ids, names, file ids, and
  // lightweight edges, so keep the read path narrow.
  const symbols = await measureSubphase("loadSymbols", () =>
    ladybugDb.getSymbolsByRepoLite(conn, repoId),
  );
  if (symbols.length === 0) {
    return {
      clustersComputed: 0,
      processesTraced: 0,
      centralityComputed: 0,
      shadowClustersComputed: 0,
      algorithmRefresh: createAlgorithmDiagnostics(algorithmRefresh.enabled),
      ...(timings ? { timings } : {}),
    };
  }

  const symbolIds = symbols.map((s) => s.symbolId).sort();

  const { clusterEdges, callEdges } = sharedGraph
    ? await measureSubphase("loadEdges", async () => ({
        clusterEdges: sharedGraph.clusterEdges,
        callEdges: sharedGraph.callEdges,
      }))
    : await measureSubphase("loadEdges", async () => {
        const edgesByFrom = await ladybugDb.getEdgesFromSymbolsLite(
          conn,
          symbolIds,
        );
        const nextClusterEdges: Array<{
          fromSymbolId: string;
          toSymbolId: string;
        }> = [];
        const nextCallEdges: Array<{ callerId: string; calleeId: string }> = [];

        for (const [fromSymbolId, edges] of edgesByFrom) {
          for (const edge of edges) {
            // Restrict clustering to call edges only. Import edges create
            // artificial hubs (utility modules referenced by hundreds of
            // files) that collapse LPA into a single giant catch-all
            // community. Calls represent runtime dependencies, which is
            // what cluster cohesion should actually measure.
            if (edge.edgeType === "call") {
              nextClusterEdges.push({
                fromSymbolId,
                toSymbolId: edge.toSymbolId,
              });
              nextCallEdges.push({
                callerId: fromSymbolId,
                calleeId: edge.toSymbolId,
              });
            }
          }
        }

        edgesByFrom.clear();
        return {
          clusterEdges: nextClusterEdges,
          callEdges: nextCallEdges,
        };
      });

  // Short-circuit when the graph has no call edges. With 0 call edges, clusters
  // and processes are both empty by construction, and the algorithm stage
  // would attempt to PROJECT_GRAPH on an empty projection — a known hang in
  // LadybugDB 0.15.2. Also, the TS cluster fallback issues additional DB
  // reads that can deadlock against the connection used by the caller.
  if (callEdges.length === 0) {
    logger.debug("cluster-orchestrator: skipping (no call edges)", {
      repoId,
      symbolCount: symbols.length,
    });
    return {
      clustersComputed: 0,
      processesTraced: 0,
      centralityComputed: 0,
      shadowClustersComputed: 0,
      algorithmRefresh: {
        enabled: algorithmRefresh.enabled,
        dirty: false,
        pageRank: { status: "skipped", count: 0, reason: "no-call-edges" },
        kCore: { status: "skipped", count: 0, reason: "no-call-edges" },
        louvain: { status: "skipped", count: 0, reason: "no-call-edges" },
        failures: [],
      },
      ...(timings ? { timings } : {}),
    };
  }

  emitSubstage("clusterRefresh");
  const clustersStartMs = Date.now();
  const clusterAssignments = await measureSubphase(
    "clusterCompute",
    async () =>
      computeClustersRust(
        symbolIds.map((symbolId) => ({ symbolId })),
        clusterEdges,
        minClusterSize,
      ) ?? (await computeClustersTS(repoId, { minClusterSize })),
  );

  const symbolById = new Map<string, { name: string; fileId: string }>();
  for (const symbol of symbols) {
    symbolById.set(symbol.symbolId, {
      name: symbol.name,
      fileId: symbol.fileId,
    });
  }

  const allFileIds = [...new Set(symbols.map((symbol) => symbol.fileId))];
  const filesById = await measureSubphase("loadFiles", () =>
    ladybugDb.getFilesByIds(conn, allFileIds),
  );

  const clustersById = new Map<
    string,
    Array<{ symbolId: string; membershipScore: number }>
  >();
  for (const assignment of clusterAssignments) {
    const members = clustersById.get(assignment.clusterId) ?? [];
    members.push({
      symbolId: assignment.symbolId,
      membershipScore: assignment.membershipScore,
    });
    clustersById.set(assignment.clusterId, members);
  }

  const sortedClusterIds = Array.from(clustersById.keys()).sort();
  const nextClusterStates: NextClusterState[] = sortedClusterIds.map(
    (clusterId, clusterIndex) => {
      const members = (clustersById.get(clusterId) ?? [])
        .slice()
        .sort((a, b) => a.symbolId.localeCompare(b.symbolId));
      const label = generateClusterLabel(
        members,
        symbolById,
        filesById,
        clusterIndex,
      );

      const memberNames = members
        .map((member) => symbolById.get(member.symbolId)?.name)
        .filter((name): name is string => Boolean(name));

      return {
        clusterId,
        label,
        symbolCount: members.length,
        searchText: buildClusterSearchText(label, memberNames),
        members,
      };
    },
  );
  await measureSubphase("clusterWrite", async () => {
    const { existingClusters, existingMembers } = await measureSubphase(
      "clusterWrite.loadExisting",
      async () => ({
        existingClusters: await ladybugDb.getClustersForRepo(conn, repoId),
        existingMembers: await ladybugDb.getClusterMembersWithScoresForRepo(
          conn,
          repoId,
        ),
      }),
    );
    const existingMembersByClusterId = new Map<
      string,
      Array<{ symbolId: string; membershipScore: number }>
    >();
    for (const member of existingMembers) {
      const members = existingMembersByClusterId.get(member.clusterId) ?? [];
      members.push({
        symbolId: member.symbolId,
        membershipScore: member.membershipScore,
      });
      existingMembersByClusterId.set(member.clusterId, members);
    }
    const existingClusterState = serializeClusterState(
      existingClusters.map((cluster) => ({
        clusterId: cluster.clusterId,
        label: cluster.label,
        symbolCount: cluster.symbolCount,
        searchText: cluster.searchText ?? "",
        members: existingMembersByClusterId.get(cluster.clusterId) ?? [],
      })),
    );
    const nextClusterState = serializeClusterState(nextClusterStates);
    const replaceClusters = existingClusterState !== nextClusterState;
    const clusterRows = nextClusterStates.map((cluster) => ({
      clusterId: cluster.clusterId,
      repoId,
      label: cluster.label,
      symbolCount: cluster.symbolCount,
      cohesionScore: 0.0,
      versionId,
      createdAt: now,
      searchText: cluster.searchText,
    }));

    await withWriteConn(async (wConn) => {
      let clusterFtsDropStatus: ClusterFtsDropStatus = "skipped";
      if (replaceClusters) {
        const dropResult = await dropFtsIndex(
          wConn,
          "Cluster",
          ENTITY_FTS_INDEX_NAMES.cluster,
        );
        if (dropResult.status === "failed") {
          throw new Error(
            `Cluster FTS index could not be dropped before cluster replacement: ${dropResult.error}`,
          );
        }
        clusterFtsDropStatus = dropResult.status;
      }

      let replacementError: unknown;
      try {
        await measureSubphase("clusterWrite.writeRows", async () => {
          await ladybugDb.withTransaction(wConn, async (txConn) => {
            if (replaceClusters) {
              await measureSubphase(
                "clusterWrite.deleteRows",
                () => ladybugDb.deleteClustersByRepo(txConn, repoId),
              );
            }

            await measureSubphase(
              "clusterWrite.upsertClusters",
              () => ladybugDb.upsertClustersBatch(txConn, clusterRows),
            );

            if (replaceClusters) {
              // Flatten relationship rows lazily so stable no-op refreshes do
              // not allocate rows that will not be written.
              const clusterMemberRows = nextClusterStates.flatMap((cluster) =>
                cluster.members.map((member) => ({
                  symbolId: member.symbolId,
                  clusterId: cluster.clusterId,
                  membershipScore: member.membershipScore,
                })),
              );
              await measureSubphase(
                "clusterWrite.upsertMembers",
                () =>
                  ladybugDb.upsertClusterMembersBatch(
                    txConn,
                    clusterMemberRows,
                  ),
              );
            }
          });
        });
      } catch (error) {
        replacementError = error;
        throw error;
      } finally {
        if (clusterFtsDropStatus !== "skipped" || !replaceClusters) {
          const totalClusterCount = await ladybugDb.countClusters(wConn);
          const shouldRebuild = shouldRebuildClusterFtsAfterReplacement({
            replaceClusters,
            replacementError,
            dropStatus: clusterFtsDropStatus,
            totalClusterCount,
          });
          const shouldRepairMissing =
            !replaceClusters && totalClusterCount > 0;

          if (!shouldRebuild && !shouldRepairMissing) {
            logger.info(
              "Cluster FTS index rebuild skipped",
              {
                repoId,
                indexName: ENTITY_FTS_INDEX_NAMES.cluster,
                dropStatus: clusterFtsDropStatus,
                totalClusterCount,
              },
            );
          } else {
            const ensureResult = await ensureFtsIndexForNonEmptyTable(
              wConn,
              "Cluster",
              ENTITY_FTS_INDEX_NAMES.cluster,
            );

            if (ensureResult.status === "failed") {
              const failedAfter =
                replacementError === undefined
                  ? replaceClusters
                    ? "cluster replacement"
                    : "cluster FTS repair"
                  : `failed cluster replacement (${replacementError instanceof Error ? replacementError.message : String(replacementError)})`;
              const message = `Cluster FTS index could not be rebuilt after ${failedAfter}: ${ensureResult.error}`;
              if (
                shouldFailOnClusterFtsRebuildFailure({
                  dropStatus: clusterFtsDropStatus,
                })
              ) {
                throw new Error(message);
              }
              logger.warn(message, {
                repoId,
                indexName: ENTITY_FTS_INDEX_NAMES.cluster,
                dropStatus: clusterFtsDropStatus,
                totalClusterCount,
              });
            }
          }
        }
      }
    });
  });

  emitSubstage("processRefresh");
  const processesStartMs = Date.now();
  const processes = await measureSubphase(
    "processCompute",
    async () =>
      traceProcessesRust(
        symbols.map((symbol) => ({
          symbolId: symbol.symbolId,
          name: symbol.name,
        })),
        callEdges,
        maxProcessDepth,
        entryPatterns,
      ) ??
      (await traceProcessesTS(repoId, entryPatterns, {
        maxDepth: maxProcessDepth,
      })),
  );

  const nextProcessStates: NextProcessState[] = processes.map(
    (process, processIndex) => {
      const lastOrder =
        process.steps.length > 0
          ? process.steps[process.steps.length - 1].stepOrder
          : 0;

      const entrySymbol = symbolById.get(process.entrySymbolId);
      const entryName = entrySymbol?.name ?? "";
      const entryFile = entrySymbol?.fileId
        ? filesById.get(entrySymbol.fileId)?.relPath
        : undefined;
      const fileHint = entryFile
        ? entryFile.split("/").slice(-2).join("/")
        : "";
      const label = entryName
        ? fileHint
          ? `Process: ${entryName} (${fileHint})`
          : `Process: ${entryName}`
        : `Process ${processIndex + 1}`;
      const stepNames = process.steps
        .map((step) => symbolById.get(step.symbolId)?.name)
        .filter((name): name is string => Boolean(name));

      return {
        processId: process.processId,
        entrySymbolId: process.entrySymbolId,
        label,
        depth: process.depth,
        searchText: buildProcessSearchText(label, entryName, stepNames),
        steps: process.steps.map((step) => ({
          symbolId: step.symbolId,
          stepOrder: step.stepOrder,
          role:
            step.stepOrder === 0
              ? "entry"
              : step.stepOrder === lastOrder
                ? "exit"
                : "intermediate",
        })),
      };
    },
  );

  await measureSubphase("processWrite", async () => {
    const { existingProcesses, existingSteps } = await measureSubphase(
      "processWrite.loadExisting",
      async () => ({
        existingProcesses: await ladybugDb.getProcessesForRepo(conn, repoId),
        existingSteps: await ladybugDb.getProcessStepsForRepo(conn, repoId),
      }),
    );
    const existingStepsByProcessId = new Map<
      string,
      Array<{ symbolId: string; stepOrder: number; role: string }>
    >();
    for (const step of existingSteps) {
      const steps = existingStepsByProcessId.get(step.processId) ?? [];
      steps.push({
        symbolId: step.symbolId,
        stepOrder: step.stepOrder,
        role: step.role ?? "",
      });
      existingStepsByProcessId.set(step.processId, steps);
    }
    const existingProcessState = serializeProcessState(
      existingProcesses.map((process) => ({
        processId: process.processId,
        entrySymbolId: process.entrySymbolId,
        label: process.label,
        depth: process.depth,
        searchText: process.searchText ?? "",
        steps: existingStepsByProcessId.get(process.processId) ?? [],
      })),
    );
    const nextProcessState = serializeProcessState(nextProcessStates);
    const replaceProcesses = existingProcessState !== nextProcessState;
    const processRows = nextProcessStates.map((process) => ({
      processId: process.processId,
      repoId,
      entrySymbolId: process.entrySymbolId,
      label: process.label,
      depth: process.depth,
      versionId,
      createdAt: now,
      searchText: process.searchText,
    }));

    await withWriteConn(async (wConn) => {
      await measureSubphase("processWrite.writeRows", async () => {
        await ladybugDb.withTransaction(wConn, async (txConn) => {
          if (replaceProcesses) {
            await measureSubphase(
              "processWrite.deleteRows",
              () => ladybugDb.deleteProcessesByRepo(txConn, repoId),
            );
          }

          await measureSubphase(
            "processWrite.upsertProcesses",
            () => ladybugDb.upsertProcessesBatch(txConn, processRows),
          );

          if (replaceProcesses) {
            // Process steps follow the same lazy single-batch write path as
            // cluster members to avoid per-process single-writer round trips.
            const processStepRows = nextProcessStates.flatMap((process) =>
              process.steps.map((step) => ({
                processId: process.processId,
                symbolId: step.symbolId,
                stepOrder: step.stepOrder,
                role: step.role,
              })),
            );
            await measureSubphase(
              "processWrite.upsertSteps",
              () => ladybugDb.upsertProcessStepsBatch(txConn, processStepRows),
            );
          }
        });
      });
    });
  });

  // ======================================================================
  // Optional algorithm stage (shadow + additive): PageRank/K-core metrics and
  // Louvain shadow communities. Canonical cluster/process rows are already
  // written above; failures here are reported through DerivedState and never
  // roll back canonical work.
  // ======================================================================
  let centralityComputed = 0;
  let shadowClustersComputed = 0;
  const algorithmDiagnostics = createAlgorithmDiagnostics(
    algorithmRefresh.enabled,
  );
  if (algorithmRefresh.enabled) {
    emitSubstage("algorithmRefresh");
    await measureSubphase("algorithmStage", async () => {
      if (callEdges.length === 0) {
        algorithmDiagnostics.pageRank = {
          status: "skipped",
          count: 0,
          reason: "no-call-edges",
        };
        algorithmDiagnostics.kCore = {
          status: "skipped",
          count: 0,
          reason: "no-call-edges",
        };
        algorithmDiagnostics.louvain = {
          status: "skipped",
          count: 0,
          reason: "no-call-edges",
        };
        return;
      }

      if (algorithmRefresh.pageRank.enabled || algorithmRefresh.kCore.enabled) {
        try {
          const centralityResult = await centralityRunner(
            {
              symbolIds,
              callEdges,
              pageRankEnabled: algorithmRefresh.pageRank.enabled,
              kCoreEnabled: algorithmRefresh.kCore.enabled,
            },
            algorithmRefresh.workerTimeoutMs,
          );
          const pageRankMap = new Map<string, number>();
          for (const row of centralityResult.pageRank) {
            pageRankMap.set(row.symbolId, row.score);
          }
          const kCoreMap = new Map<string, number>();
          for (const row of centralityResult.kCore) {
            kCoreMap.set(row.symbolId, row.coreness);
          }
          const mergedSymbolIds = new Set<string>([
            ...pageRankMap.keys(),
            ...kCoreMap.keys(),
          ]);
          const centralityRows = [...mergedSymbolIds].map((symbolId) => ({
            symbolId,
            pageRank: pageRankMap.get(symbolId) ?? 0,
            kCore: kCoreMap.get(symbolId) ?? 0,
            updatedAt: now,
          }));
          if (centralityRows.length > 0) {
            await withWriteConn(async (wConn) => {
              await upsertCentralityBatch(wConn, centralityRows);
            });
          }
          centralityComputed = centralityRows.length;
          algorithmDiagnostics.pageRank = {
            status: algorithmRefresh.pageRank.enabled
              ? "succeeded"
              : "disabled",
            count: centralityResult.pageRank.length,
            reason: algorithmRefresh.pageRank.enabled ? undefined : "disabled",
          };
          algorithmDiagnostics.kCore = {
            status: algorithmRefresh.kCore.enabled ? "succeeded" : "disabled",
            count: centralityResult.kCore.length,
            reason: algorithmRefresh.kCore.enabled ? undefined : "disabled",
          };
        } catch (err) {
          const timedOut = err instanceof CentralityWorkerTimeoutError;
          const message = err instanceof Error ? err.message : String(err);
          algorithmDiagnostics.dirty = true;
          algorithmDiagnostics.failures.push(message);
          algorithmDiagnostics.pageRank = {
            status: algorithmRefresh.pageRank.enabled
              ? timedOut
                ? "timedOut"
                : "failed"
              : "disabled",
            count: 0,
            reason: message,
          };
          algorithmDiagnostics.kCore = {
            status: algorithmRefresh.kCore.enabled
              ? timedOut
                ? "timedOut"
                : "failed"
              : "disabled",
            count: 0,
            reason: message,
          };
        }
      } else {
        algorithmDiagnostics.pageRank = {
          status: "disabled",
          count: 0,
          reason: "disabled",
        };
        algorithmDiagnostics.kCore = {
          status: "disabled",
          count: 0,
          reason: "disabled",
        };
      }

      if (!algorithmRefresh.louvain.enabled) {
        await clearLouvainShadowClusters(repoId, "disabled");
        algorithmDiagnostics.louvain = {
          status: "disabled",
          count: 0,
          reason: "disabled",
        };
        return;
      }
      if (callEdges.length > algorithmRefresh.louvain.maxCallEdges) {
        await clearLouvainShadowClusters(repoId, "max-call-edges");
        algorithmDiagnostics.louvain = {
          status: "skipped",
          count: 0,
          reason: `call-edge-count ${callEdges.length} exceeds maxCallEdges ${algorithmRefresh.louvain.maxCallEdges}`,
        };
        logger.info("ladybug-algorithms: skipping Louvain by policy", {
          repoId,
          callEdges: callEdges.length,
          maxCallEdges: algorithmRefresh.louvain.maxCallEdges,
        });
        return;
      }

      try {
        const capability = await algorithmCapabilityDetector(conn);
        if (!capability.supported) {
          await clearLouvainShadowClusters(repoId, "unsupported");
          algorithmDiagnostics.louvain = {
            status: "skipped",
            count: 0,
            reason: capability.reason ?? "unsupported",
          };
          return;
        }
        await resetRepoGraphProjection(conn, repoId);
        const louvainResults = await louvainRunner(conn, repoId);

        const communityMembers = new Map<number, string[]>();
        for (const row of louvainResults) {
          const members = communityMembers.get(row.communityId) ?? [];
          members.push(row.symbolId);
          communityMembers.set(row.communityId, members);
        }
        const sortedCommunityIds = [...communityMembers.keys()]
          .filter(
            (cid) =>
              (communityMembers.get(cid)?.length ?? 0) >= minClusterSize,
          )
          .sort((a, b) => a - b);

        await withWriteConn(async (wConn) => {
          await deleteShadowClustersByRepo(wConn, repoId);
          for (const communityId of sortedCommunityIds) {
            const memberIds = (communityMembers.get(communityId) ?? [])
              .slice()
              .sort();
            const shadowClusterId = `${repoId}:louvain:${communityId}`;
            await upsertShadowCluster(wConn, {
              shadowClusterId,
              repoId,
              algorithm: "louvain",
              label: `Louvain community ${communityId}`,
              symbolCount: memberIds.length,
              modularity: 0.0,
              versionId,
              createdAt: now,
            });
            await upsertShadowClusterMembersBatch(
              wConn,
              memberIds.map((symbolId) => ({
                symbolId,
                shadowClusterId,
                membershipScore: 1.0,
              })),
            );
          }
        });
        shadowClustersComputed = sortedCommunityIds.length;
        algorithmDiagnostics.louvain = {
          status: "succeeded",
          count: sortedCommunityIds.length,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        algorithmDiagnostics.dirty = true;
        algorithmDiagnostics.failures.push(message);
        algorithmDiagnostics.louvain = {
          status: "failed",
          count: 0,
          reason: message,
        };
        logger.warn(
          "ladybug-algorithms: Louvain failed; centrality and canonical indexing preserved",
          { repoId, error: message },
        );
      }
    });
  }

  logger.info("Cluster/process computation completed", {
    repoId,
    clustersComputed: sortedClusterIds.length,
    processesTraced: processes.length,
    centralityComputed,
    shadowClustersComputed,
    clustersDurationMs: Date.now() - clustersStartMs,
    processesDurationMs: Date.now() - processesStartMs,
    totalDurationMs: Date.now() - startMs,
  });

  return {
    clustersComputed: sortedClusterIds.length,
    processesTraced: processes.length,
    centralityComputed,
    shadowClustersComputed,
    algorithmRefresh: algorithmDiagnostics,
    ...(timings ? { timings } : {}),
  };
}

function generateClusterLabel(
  members: Array<{ symbolId: string }>,
  symbolById: Map<string, { name: string; fileId: string }>,
  filesById: Map<string, { relPath: string }>,
  fallbackIndex: number,
): string {
  // Strategy 1: Find the most common directory among member symbols
  const dirCounts = new Map<string, number>();
  for (const member of members) {
    const sym = symbolById.get(member.symbolId);
    if (!sym) continue;
    const file = filesById.get(sym.fileId);
    if (!file) continue;
    const dir = file.relPath.replace(/\\/g, "/").replace(/\/[^/]+$/, "") || ".";
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }

  if (dirCounts.size > 0) {
    const sorted = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]);
    const topDir = sorted[0][0];
    const topCount = sorted[0][1];
    // If a significant portion of members share a directory, use it
    if (topCount >= members.length * 0.35) {
      return topDir;
    }
  }

  // Strategy 2: Find longest common prefix of member symbol names
  const names = members
    .map((m) => symbolById.get(m.symbolId)?.name)
    .filter((n): n is string => Boolean(n))
    .sort();

  if (names.length >= 2) {
    const first = names[0];
    const last = names[names.length - 1];
    let prefixLen = 0;
    const maxLen = Math.min(first.length, last.length);
    while (prefixLen < maxLen && first[prefixLen] === last[prefixLen]) {
      prefixLen++;
    }
    if (prefixLen >= 3) {
      return first.slice(0, prefixLen).replace(/[_.]$/, "");
    }
  }

  // Strategy 3: Use the most common exported symbol name as the label
  const exportedNames = members
    .map((m) => symbolById.get(m.symbolId))
    .filter((s): s is { name: string; fileId: string } => Boolean(s))
    .filter((s) => {
      const file = filesById.get(s.fileId);
      return file && !file.relPath.startsWith("tests/");
    })
    .map((s) => s.name);
  if (exportedNames.length > 0) {
    // Pick the most common name, or the first alphabetically as a representative
    const nameCounts = new Map<string, number>();
    for (const n of exportedNames)
      nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
    const sorted = [...nameCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length === 1) {
      return sorted[0][0];
    }
    if (sorted.length === 2) {
      return `${sorted[0][0]} / ${sorted[1][0]}`;
    }
    if (sorted.length >= 3) {
      // Prefer directory-based label if members share a common directory prefix
      const memberFiles = members
        .map((m) => symbolById.get(m.symbolId))
        .filter((s): s is { name: string; fileId: string } => Boolean(s))
        .map((s) => filesById.get(s.fileId)?.relPath ?? "")
        .filter(Boolean);
      if (memberFiles.length > 0) {
        const dirs = memberFiles.map((f) =>
          f.split("/").slice(0, -1).join("/"),
        );
        const dirCounts = new Map<string, number>();
        for (const d of dirs) {
          if (d) dirCounts.set(d, (dirCounts.get(d) ?? 0) + 1);
        }
        const sortedDirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]);
        const topDir = sortedDirs[0];
        // For large clusters (>50 members), lower the threshold for directory labels
        const dirThreshold = members.length > 50 ? 0.3 : 0.5;
        if (topDir && topDir[1] >= memberFiles.length * dirThreshold) {
          // Show top 2 directories if the second is also significant
          if (
            sortedDirs.length >= 2 &&
            sortedDirs[1][1] >= memberFiles.length * 0.2
          ) {
            return `${topDir[0]} + ${sortedDirs[1][0]}`;
          }
          return topDir[0];
        }
      }
      // DF-2: For large clusters, try harder to produce a directory-based label
      // "supports + 1798 related" is uninformative - use the dominant directory instead
      const memberFilesFallback = members
        .map((m) => symbolById.get(m.symbolId))
        .filter((s): s is { name: string; fileId: string } => Boolean(s))
        .map((s) => filesById.get(s.fileId)?.relPath ?? "")
        .filter(Boolean);
      if (memberFilesFallback.length > 0) {
        // Count directory occurrences at depth 2 (e.g., src/graph, src/mcp)
        const depth2Counts = new Map<string, number>();
        for (const f of memberFilesFallback) {
          const parts = f.split("/");
          const d2 =
            parts.length >= 3
              ? parts.slice(0, 3).join("/")
              : parts.slice(0, -1).join("/");
          if (d2) depth2Counts.set(d2, (depth2Counts.get(d2) ?? 0) + 1);
        }
        const sortedDirs2 = [...depth2Counts.entries()].sort(
          (a, b) => b[1] - a[1],
        );
        if (
          sortedDirs2.length > 0 &&
          sortedDirs2[0][1] >= memberFilesFallback.length * 0.2
        ) {
          const topDirs = sortedDirs2
            .filter(([, count]) => count >= memberFilesFallback.length * 0.1)
            .slice(0, 3)
            .map(([dir]) => dir);
          if (topDirs.length <= 2) {
            return topDirs.join(" + ");
          }
          return `${topDirs[0]} + ${topDirs.length - 1} more`;
        }
      }
      return `${sorted[0][0]} + ${sorted.length - 1} related`;
    }
  }

  return `Cluster ${fallbackIndex + 1}`;
}
