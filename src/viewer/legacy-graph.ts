import type { Connection } from "kuzu";

import * as ladybugDb from "../db/ladybug-queries.js";
import { computeDelta } from "../delta/diff.js";
import { runGovernorLoop } from "../delta/blastRadius.js";

export type GraphNode = {
  id: string;
  label: string;
  kind: string;
  file?: string;
  fanIn?: number;
  fanOut?: number;
  size?: number;
  cluster?: string;
};

export type GraphLink = {
  source: string;
  target: string;
  type: string;
  weight: number;
};

// ---------------------------------------------------------------------------
// Graph visualization helpers
// ---------------------------------------------------------------------------

function toClusterPath(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (slash === -1) {
    return "root";
  }
  return filePath.slice(0, slash) || "root";
}

async function buildNodes(
  conn: Connection,
  symbolIds: string[],
): Promise<GraphNode[]> {
  const symbolMap = await ladybugDb.getSymbolsByIds(conn, symbolIds);
  const metricsMap = await ladybugDb.getMetricsBySymbolIds(conn, symbolIds);

  const fileIds = new Set<string>();
  for (const symbol of symbolMap.values()) {
    fileIds.add(symbol.fileId);
  }
  const fileMap = await ladybugDb.getFilesByIds(conn, Array.from(fileIds));

  const nodes: GraphNode[] = [];
  for (const symbolId of symbolIds) {
    const symbol = symbolMap.get(symbolId);
    if (!symbol) continue;
    const file = fileMap.get(symbol.fileId);
    const metrics = metricsMap.get(symbolId);

    nodes.push({
      id: symbolId,
      label: symbol.name,
      kind: symbol.kind,
      file: file?.relPath,
      fanIn: metrics?.fanIn,
      fanOut: metrics?.fanOut,
      size: Math.max(5, Math.min(40, (metrics?.fanIn ?? 0) + 6)),
      cluster: toClusterPath(file?.relPath ?? ""),
    });
  }

  return nodes;
}

async function buildLinksForNodes(
  conn: Connection,
  ids: Set<string>,
): Promise<GraphLink[]> {
  const idList = Array.from(ids);
  const edgeMap = await ladybugDb.getEdgesFromSymbolsForSlice(conn, idList);

  const links: GraphLink[] = [];
  for (const fromSymbolId of idList) {
    const edges = edgeMap.get(fromSymbolId) ?? [];
    for (const edge of edges) {
      if (!ids.has(edge.toSymbolId)) continue;
      links.push({
        source: fromSymbolId,
        target: edge.toSymbolId,
        type: edge.edgeType,
        weight: edge.weight,
      });
    }
  }
  return links;
}

function collapseClusters(
  nodes: GraphNode[],
  maxChildrenPerCluster = 10,
): GraphNode[] {
  const byCluster = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = node.cluster ?? "root";
    const list = byCluster.get(key) ?? [];
    list.push(node);
    byCluster.set(key, list);
  }

  const collapsed: GraphNode[] = [];
  for (const [cluster, list] of byCluster) {
    if (list.length <= maxChildrenPerCluster) {
      collapsed.push(...list);
      continue;
    }
    const sorted = [...list].sort((a, b) => (b.fanIn ?? 0) - (a.fanIn ?? 0));
    collapsed.push(...sorted.slice(0, maxChildrenPerCluster));
    collapsed.push({
      id: `cluster:${cluster}`,
      label: `${cluster} (+${list.length - maxChildrenPerCluster})`,
      kind: "module",
      cluster,
      size: 10,
    });
  }

  return collapsed;
}

export async function buildNeighborhood(
  conn: Connection,
  symbolId: string,
  maxNodes: number,
): Promise<{
  nodes: GraphNode[];
  links: GraphLink[];
}> {
  const ids = new Set<string>();
  ids.add(symbolId);

  for (const edge of await ladybugDb.getEdgesFrom(conn, symbolId)) {
    ids.add(edge.toSymbolId);
  }
  const edgesTo = await ladybugDb.getEdgesToSymbols(conn, [symbolId]);
  for (const edge of edgesTo.get(symbolId) ?? []) {
    ids.add(edge.fromSymbolId);
  }

  const limited = new Set(Array.from(ids).slice(0, maxNodes));
  const nodes = await buildNodes(conn, Array.from(limited));
  const links = await buildLinksForNodes(conn, limited);

  return {
    nodes: collapseClusters(nodes),
    links,
  };
}

async function buildRepoPreview(
  conn: Connection,
  repoId: string,
  maxNodes: number,
): Promise<{
  nodes: GraphNode[];
  links: GraphLink[];
}> {
  const top = await ladybugDb.getTopSymbolsByFanIn(conn, repoId, maxNodes);
  const symbolIds = top.map((row) => row.symbolId);
  const ids = new Set(symbolIds);
  const nodes = await buildNodes(conn, symbolIds);
  const links = await buildLinksForNodes(conn, ids);

  return {
    nodes: collapseClusters(nodes),
    links,
  };
}

export async function buildGraphForSliceHandle(
  conn: Connection,
  repoId: string,
  handle: string,
  maxNodes: number,
  deps: {
    getSliceHandle?: typeof ladybugDb.getSliceHandle;
    buildRepoPreview?: typeof buildRepoPreview;
    buildBlastRadiusGraph?: typeof buildBlastRadiusGraph;
  } = {},
): Promise<{
  nodes: GraphNode[];
  links: GraphLink[];
} | null> {
  const getSliceHandleFn = deps.getSliceHandle ?? ladybugDb.getSliceHandle;
  const buildRepoPreviewFn = deps.buildRepoPreview ?? buildRepoPreview;
  const buildBlastRadiusGraphFn =
    deps.buildBlastRadiusGraph ?? buildBlastRadiusGraph;

  const handleRow = await getSliceHandleFn(conn, handle);
  if (!handleRow || handleRow.repoId !== repoId) {
    return null;
  }

  if (handleRow.minVersion && handleRow.maxVersion) {
    return buildBlastRadiusGraphFn(
      conn,
      repoId,
      handleRow.minVersion,
      handleRow.maxVersion,
      maxNodes,
    );
  }

  return buildRepoPreviewFn(conn, repoId, maxNodes);
}

export async function buildBlastRadiusGraph(
  conn: Connection,
  repoId: string,
  fromVersion: string,
  toVersion: string,
  maxNodes: number,
): Promise<{ nodes: GraphNode[]; links: GraphLink[] }> {
  const delta = await computeDelta(repoId, fromVersion, toVersion);
  const changedSymbolIds = delta.changedSymbols.map(
    (change) => change.symbolId,
  );
  const governor = await runGovernorLoop(conn, changedSymbolIds, {
    repoId,
    budget: { maxCards: maxNodes, maxEstimatedTokens: 4000 },
    runDiagnostics: false,
  });

  const ids = new Set<string>();
  for (const changed of delta.changedSymbols) {
    ids.add(changed.symbolId);
  }
  for (const affected of governor.blastRadius) {
    ids.add(affected.symbolId);
  }

  const limited = new Set(Array.from(ids).slice(0, maxNodes));
  const nodes = await buildNodes(conn, Array.from(limited));
  const links = await buildLinksForNodes(conn, limited);

  return {
    nodes: collapseClusters(nodes),
    links,
  };
}
