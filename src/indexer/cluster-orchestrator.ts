import type { Connection } from "kuzu";

import * as ladybugDb from "../db/ladybug-queries.js";
import { buildClusterSearchText } from "../db/ladybug-clusters.js";
import { buildProcessSearchText } from "../db/ladybug-processes.js";
import { withWriteConn } from "../db/ladybug.js";
import { logger } from "../util/logger.js";
import { computeClustersTS } from "../graph/cluster.js";
import { traceProcessesTS } from "../graph/process.js";
import { computeClustersRust, traceProcessesRust } from "./rustIndexer.js";

const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_MAX_PROCESS_DEPTH = 20;

const DEFAULT_ENTRY_PATTERNS = [
  "^main$",
  "^index$",
  "handler",
  "^run$",
  "^start$",
];

export interface ClusterOrchestratorResult {
  clustersComputed: number;
  processesTraced: number;
  timings?: Record<string, number>;
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
  includeTimings?: boolean;
}): Promise<ClusterOrchestratorResult> {
  const {
    conn,
    repoId,
    versionId,
    entryPatterns = DEFAULT_ENTRY_PATTERNS,
    minClusterSize = DEFAULT_MIN_CLUSTER_SIZE,
    maxProcessDepth = DEFAULT_MAX_PROCESS_DEPTH,
    includeTimings = false,
  } = params;

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
      ...(timings ? { timings } : {}),
    };
  }

  const symbolIds = symbols.map((s) => s.symbolId).sort();

  const { clusterEdges, callEdges } = await measureSubphase(
    "loadEdges",
    async () => {
      let edgesByFrom = await ladybugDb.getEdgesFromSymbolsLite(
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
            nextClusterEdges.push({ fromSymbolId, toSymbolId: edge.toSymbolId });
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
    },
  );

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
    const existingClusters = await ladybugDb.getClustersForRepo(conn, repoId);
    const existingMembers = await ladybugDb.getClusterMembersWithScoresForRepo(
      conn,
      repoId,
    );
    const existingClusterState = serializeClusterState(
      existingClusters.map((cluster) => ({
        clusterId: cluster.clusterId,
        label: cluster.label,
        symbolCount: cluster.symbolCount,
        searchText: cluster.searchText ?? "",
        members: existingMembers
          .filter((member) => member.clusterId === cluster.clusterId)
          .map((member) => ({
            symbolId: member.symbolId,
            membershipScore: member.membershipScore,
          })),
      })),
    );
    const nextClusterState = serializeClusterState(nextClusterStates);

    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        if (existingClusterState !== nextClusterState) {
          await ladybugDb.deleteClustersByRepo(txConn, repoId);
        }

        for (const cluster of nextClusterStates) {
          await ladybugDb.upsertCluster(txConn, {
            clusterId: cluster.clusterId,
            repoId,
            label: cluster.label,
            symbolCount: cluster.symbolCount,
            cohesionScore: 0.0,
            versionId,
            createdAt: now,
            searchText: cluster.searchText,
          });

          if (existingClusterState !== nextClusterState) {
            await ladybugDb.upsertClusterMembersBatch(
              txConn,
              cluster.members.map((member) => ({
                symbolId: member.symbolId,
                clusterId: cluster.clusterId,
                membershipScore: member.membershipScore,
              })),
            );
          }
        }
      });
    });
  });

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
    const existingProcesses = await ladybugDb.getProcessesForRepo(conn, repoId);
    const existingSteps = await ladybugDb.getProcessStepsForRepo(conn, repoId);
    const existingProcessState = serializeProcessState(
      existingProcesses.map((process) => ({
        processId: process.processId,
        entrySymbolId: process.entrySymbolId,
        label: process.label,
        depth: process.depth,
        searchText: process.searchText ?? "",
        steps: existingSteps
          .filter((step) => step.processId === process.processId)
          .map((step) => ({
            symbolId: step.symbolId,
            stepOrder: step.stepOrder,
            role: step.role ?? "",
          })),
      })),
    );
    const nextProcessState = serializeProcessState(nextProcessStates);

    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        if (existingProcessState !== nextProcessState) {
          await ladybugDb.deleteProcessesByRepo(txConn, repoId);
        }

        for (const process of nextProcessStates) {
          await ladybugDb.upsertProcess(txConn, {
            processId: process.processId,
            repoId,
            entrySymbolId: process.entrySymbolId,
            label: process.label,
            depth: process.depth,
            versionId,
            createdAt: now,
            searchText: process.searchText,
          });

          if (existingProcessState !== nextProcessState) {
            await ladybugDb.upsertProcessStepsBatch(
              txConn,
              process.steps.map((step) => ({
                processId: process.processId,
                symbolId: step.symbolId,
                stepOrder: step.stepOrder,
                role: step.role,
              })),
            );
          }
        }
      });
    });
  });

  logger.info("Cluster/process computation completed", {
    repoId,
    clustersComputed: sortedClusterIds.length,
    processesTraced: processes.length,
    clustersDurationMs: Date.now() - clustersStartMs,
    processesDurationMs: Date.now() - processesStartMs,
    totalDurationMs: Date.now() - startMs,
  });

  return {
    clustersComputed: sortedClusterIds.length,
    processesTraced: processes.length,
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
