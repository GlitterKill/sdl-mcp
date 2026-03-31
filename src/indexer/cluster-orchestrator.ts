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

  // Use lite query — cluster computation only needs symbolId, name, fileId.
  const symbols = await ladybugDb.getSymbolsByRepoLite(conn, repoId);
  if (symbols.length === 0) {
    return { clustersComputed: 0, processesTraced: 0 };
  }

  const symbolIds = symbols.map((s) => s.symbolId).sort();

  let edgesByFrom = await ladybugDb.getEdgesFromSymbolsLite(conn, symbolIds);
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

  // Free the DB result map now that edges are extracted into flat arrays.
  edgesByFrom.clear();

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

      const memberNames = members
        .map((m) => symbolById.get(m.symbolId)?.name)
        .filter((n): n is string => Boolean(n));
      const clusterSearchText = buildClusterSearchText(label, memberNames);

      await ladybugDb.upsertCluster(wConn, {
        clusterId,
        repoId,
        label,
        symbolCount: members.length,
        cohesionScore: 0.0,
        versionId,
        createdAt: now,
        searchText: clusterSearchText,
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

  // Free cluster-related structures before process tracing.
  clusterEdges.length = 0;
  clustersById.clear();

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

      const entryName = symbolById.get(proc.entrySymbolId)?.name ?? "";
      const procLabel = entryName
        ? `Process: ${entryName}`
        : `Process ${clusterIndex + 1}`;
      const stepNames = proc.steps
        .map((step) => symbolById.get(step.symbolId)?.name)
        .filter((n): n is string => Boolean(n));
      const processSearchText = buildProcessSearchText(
        procLabel,
        entryName,
        stepNames,
      );

      await ladybugDb.upsertProcess(wConn, {
        processId: proc.processId,
        repoId,
        entrySymbolId: proc.entrySymbolId,
        label: procLabel,
        depth: proc.depth,
        versionId,
        createdAt: now,
        searchText: processSearchText,
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
    for (const n of exportedNames) nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
    const sorted = [...nameCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length === 1) {
      return sorted[0][0];
    }
    if (sorted.length === 2) {
      return `${sorted[0][0]} / ${sorted[1][0]}`;
    }
    if (sorted.length >= 3) {
      return `${sorted[0][0]} + ${sorted.length - 1} related`;
    }
  }

  return `Cluster ${fallbackIndex + 1}`;
}
