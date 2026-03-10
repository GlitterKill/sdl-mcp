import type { Connection } from "kuzu";

import * as ladybugDb from "../db/ladybug-queries.js";
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
}

export async function computeAndStoreClustersAndProcesses(params: {
  conn: Connection;
  repoId: string;
  versionId: string;
  entryPatterns?: string[];
  minClusterSize?: number;
  maxProcessDepth?: number;
}): Promise<ClusterOrchestratorResult> {
  const {
    conn,
    repoId,
    versionId,
    entryPatterns = DEFAULT_ENTRY_PATTERNS,
    minClusterSize = DEFAULT_MIN_CLUSTER_SIZE,
    maxProcessDepth = DEFAULT_MAX_PROCESS_DEPTH,
  } = params;

  const startMs = Date.now();
  const now = new Date().toISOString();

  const symbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  if (symbols.length === 0) {
    return { clustersComputed: 0, processesTraced: 0 };
  }

  const symbolIds = symbols.map((s) => s.symbolId).sort();

  const edgesByFrom = await ladybugDb.getEdgesFromSymbolsLite(conn, symbolIds);
  const clusterEdges: Array<{ fromSymbolId: string; toSymbolId: string }> = [];
  const callEdges: Array<{ callerId: string; calleeId: string }> = [];

  for (const [fromSymbolId, edges] of edgesByFrom) {
    for (const e of edges) {
      clusterEdges.push({ fromSymbolId, toSymbolId: e.toSymbolId });
      if (e.edgeType === "call") {
        callEdges.push({ callerId: fromSymbolId, calleeId: e.toSymbolId });
      }
    }
  }

  const clustersStartMs = Date.now();
  const clusterAssignments =
    computeClustersRust(
      symbolIds.map((symbolId) => ({ symbolId })),
      clusterEdges,
      minClusterSize,
    ) ?? (await computeClustersTS(repoId, { minClusterSize }));

  await withWriteConn(async (wConn) => {
    await ladybugDb.deleteClustersByRepo(wConn, repoId);
  });

  // Build lookup maps for label generation
  const symbolById = new Map<string, { name: string; fileId: string }>();
  for (const s of symbols) {
    symbolById.set(s.symbolId, { name: s.name, fileId: s.fileId });
  }
  const allFileIds = [...new Set(symbols.map((s) => s.fileId))];
  const filesById = await ladybugDb.getFilesByIds(conn, allFileIds);

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
  let clusterIndex = 0;
  await withWriteConn(async (wConn) => {
    for (const clusterId of sortedClusterIds) {
      const members = clustersById.get(clusterId) ?? [];
      members.sort((a, b) => a.symbolId.localeCompare(b.symbolId));

      const label = generateClusterLabel(
        members,
        symbolById,
        filesById,
        clusterIndex,
      );

      await ladybugDb.upsertCluster(wConn, {
        clusterId,
        repoId,
        label,
        symbolCount: members.length,
        cohesionScore: 0.0,
        versionId,
        createdAt: now,
      });

      await ladybugDb.upsertClusterMembersBatch(
        wConn,
        members.map((member) => ({
          symbolId: member.symbolId,
          clusterId,
          membershipScore: member.membershipScore,
        })),
      );

      clusterIndex++;
    }
  });

  const processesStartMs = Date.now();
  const processes =
    traceProcessesRust(
      symbols.map((s) => ({ symbolId: s.symbolId, name: s.name })),
      callEdges,
      maxProcessDepth,
      entryPatterns,
    ) ??
    (await traceProcessesTS(repoId, entryPatterns, {
      maxDepth: maxProcessDepth,
    }));

  await withWriteConn(async (wConn) => {
    await ladybugDb.deleteProcessesByRepo(wConn, repoId);

    for (const proc of processes) {
      const lastOrder =
        proc.steps.length > 0 ? proc.steps[proc.steps.length - 1].stepOrder : 0;

      await ladybugDb.upsertProcess(wConn, {
        processId: proc.processId,
        repoId,
        entrySymbolId: proc.entrySymbolId,
        label: symbolById.get(proc.entrySymbolId)?.name
          ? `Process: ${symbolById.get(proc.entrySymbolId)!.name}`
          : `Process ${clusterIndex + 1}`,
        depth: proc.depth,
        versionId,
        createdAt: now,
      });

      await ladybugDb.upsertProcessStepsBatch(
        wConn,
        proc.steps.map((step) => ({
          processId: proc.processId,
          symbolId: step.symbolId,
          stepOrder: step.stepOrder,
          role:
            step.stepOrder === 0
              ? "entry"
              : step.stepOrder === lastOrder
                ? "exit"
                : "intermediate",
        })),
      );
    }
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
    // If majority of members share a directory, use it
    if (topCount >= members.length * 0.5) {
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

  return `Cluster ${fallbackIndex + 1}`;
}
