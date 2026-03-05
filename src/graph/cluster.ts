import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";
import { hashContent } from "../util/hashing.js";

import type { ClusterAssignment } from "./cluster-types.js";

interface LpaResult {
  communities: Map<number, number[]>;
}

function labelPropagation(
  edges: Array<[number, number]>,
  nodeCount: number,
  maxIterations: number,
): LpaResult {
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);

  for (const [a, b] of edges) {
    if (a < 0 || b < 0 || a >= nodeCount || b >= nodeCount || a === b) continue;
    adjacency[a].push(b);
    adjacency[b].push(a);
  }

  for (const neighbors of adjacency) {
    neighbors.sort((x, y) => x - y);
    for (let i = neighbors.length - 1; i > 0; i--) {
      if (neighbors[i] === neighbors[i - 1]) neighbors.splice(i, 1);
    }
  }

  const labels = Array.from({ length: nodeCount }, (_, i) => i);
  const counts = new Map<number, number>();

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    for (let node = 0; node < nodeCount; node++) {
      const neighbors = adjacency[node];
      if (neighbors.length === 0) continue;

      counts.clear();
      let maxCount = 0;

      for (const n of neighbors) {
        const lbl = labels[n]!;
        const next = (counts.get(lbl) ?? 0) + 1;
        counts.set(lbl, next);
        if (next > maxCount) maxCount = next;
      }

      let bestLabel = labels[node]!;
      for (const [lbl, c] of counts) {
        if (c === maxCount && lbl < bestLabel) bestLabel = lbl;
      }

      if (bestLabel !== labels[node]) {
        labels[node] = bestLabel;
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Canonicalize labels by mapping each label to the min node index in that group.
  const labelToMin = Array.from({ length: nodeCount }, (_, i) => i);
  for (let node = 0; node < nodeCount; node++) {
    const label = labels[node]!;
    if (node < labelToMin[label]!) {
      labelToMin[label] = node;
    }
  }

  const canonical = labels.map((lbl) => labelToMin[lbl]!);

  const communities = new Map<number, number[]>();
  for (let node = 0; node < nodeCount; node++) {
    if (adjacency[node]!.length === 0) continue;
    const key = canonical[node]!;
    const members = communities.get(key) ?? [];
    members.push(node);
    communities.set(key, members);
  }

  for (const members of communities.values()) {
    members.sort((a, b) => a - b);
  }

  return { communities };
}

export async function computeClustersTS(
  repoId: string,
  options: { minClusterSize?: number } = {},
): Promise<ClusterAssignment[]> {
  const minClusterSize = options.minClusterSize ?? 3;
  const conn = await getKuzuConn();

  const symbols = await kuzuDb.getSymbolsByRepo(conn, repoId);
  if (symbols.length === 0) return [];

  const symbolIds = symbols.map((s) => s.symbolId).sort();

  const indexById = new Map<string, number>();
  symbolIds.forEach((id, idx) => indexById.set(id, idx));

  const edgesByFrom = await kuzuDb.getEdgesFromSymbolsLite(conn, symbolIds);

  const edgePairs: Array<[number, number]> = [];
  for (const [from, edges] of edgesByFrom) {
    const fromIdx = indexById.get(from);
    if (fromIdx === undefined) continue;
    for (const e of edges) {
      const toIdx = indexById.get(e.toSymbolId);
      if (toIdx === undefined) continue;
      const a = Math.min(fromIdx, toIdx);
      const b = Math.max(fromIdx, toIdx);
      if (a !== b) edgePairs.push([a, b]);
    }
  }

  edgePairs.sort(([a1, b1], [a2, b2]) => a1 - a2 || b1 - b2);
  for (let i = edgePairs.length - 1; i > 0; i--) {
    const [a, b] = edgePairs[i]!;
    const [pa, pb] = edgePairs[i - 1]!;
    if (a === pa && b === pb) edgePairs.splice(i, 1);
  }

  const { communities } = labelPropagation(edgePairs, symbolIds.length, 100);

  const assignments: ClusterAssignment[] = [];
  for (const members of communities.values()) {
    if (members.length < minClusterSize) continue;

    const memberSymbolIds = members.map((idx) => symbolIds[idx]!).sort();
    const seed = memberSymbolIds.join("|");
    const clusterId = hashContent(`cluster:${seed}`);

    for (const symbolId of memberSymbolIds) {
      assignments.push({ symbolId, clusterId, membershipScore: 1.0 });
    }
  }

  assignments.sort((a, b) => a.symbolId.localeCompare(b.symbolId));
  return assignments;
}

