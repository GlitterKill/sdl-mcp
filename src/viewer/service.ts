import type { Connection } from "kuzu";

import * as ladybugDb from "../db/ladybug-queries.js";
import { queryAll, querySingle, toNumber } from "../db/ladybug-core.js";
import type { ClusterDto, ClusterEdgesResponseDto, SymbolEdgesResponseDto, UniverseResponseDto, ViewerSettingsDto } from "./types.js";
import { getViewerRuntimeConfig } from "./viewer-config.js";

const RING_BASE = 3000;
const RING_STEP = 1500;

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function viewerSettingsSnapshot(): ViewerSettingsDto {
  const parsed = getViewerRuntimeConfig();
  return {
    enabled: parsed.enabled,
    fps: parsed.fps,
    ambient: { enabled: parsed.ambient.enabled, idleSeconds: parsed.ambient.idleSeconds, fps: parsed.ambient.fps },
    layout: { engine: parsed.layout.engine, iterations: parsed.layout.iterations, maxSymbolsPerClusterExpand: parsed.layout.maxSymbolsPerClusterExpand },
    skins: { maxZipBytes: parsed.skins.maxZipBytes, maxEntries: parsed.skins.maxEntries, maxDecompressedBytes: parsed.skins.maxDecompressedBytes },
  };
}

export function computeGalaxy(repoId: string, repoIds: string[], symbolCount: number) {
  const angle = ((fnv1a32(repoId) % 3600) / 3600) * Math.PI * 2;
  const ringIx = repoIds.indexOf(repoId);
  const dist = repoIds.length <= 1 ? 0 : RING_BASE + ringIx * RING_STEP;
  return {
    position: [round6(dist * Math.cos(angle)), 0, round6(dist * Math.sin(angle))] as const,
    radius: round6(clamp(Math.sqrt(symbolCount) * 12, 200, 2000)),
  };
}

export async function getUniverse(conn: Connection): Promise<UniverseResponseDto> {
  const rows = await queryAll<{ repoId: string; symbolCount: unknown; clusterCount: unknown; edgeCount: unknown }>(
    conn,
    `MATCH (r:Repo)
     OPTIONAL MATCH (r)<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WITH r, COUNT(DISTINCT s) AS symbolCount
     OPTIONAL MATCH (r)<-[:CLUSTER_IN_REPO]-(c:Cluster)
     WITH r, symbolCount, COUNT(DISTINCT c) AS clusterCount
     OPTIONAL MATCH (r)<-[:SYMBOL_IN_REPO]-(:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     RETURN r.repoId AS repoId, symbolCount AS symbolCount, clusterCount AS clusterCount, COUNT(d) AS edgeCount
     ORDER BY repoId ASC`,
  );
  const repoIds = rows.map((row) => row.repoId).sort();
  return {
    settings: viewerSettingsSnapshot(),
    repos: rows.map((row) => {
      const symbolCount = toNumber(row.symbolCount);
      return { repoId: row.repoId, symbolCount, clusterCount: toNumber(row.clusterCount), edgeCount: toNumber(row.edgeCount), galaxy: computeGalaxy(row.repoId, repoIds, symbolCount) };
    }),
  };
}

export async function getClusters(conn: Connection, repoId: string): Promise<{ clusters: ClusterDto[] }> {
  const clusters = await ladybugDb.getClustersForRepo(conn, repoId);
  const clusterIds = clusters.map((cluster) => cluster.clusterId);
  const topRows = clusterIds.length === 0 ? [] : await queryAll<{ clusterId: string; symbolId: string; name: string | null; kind: string | null; fanIn: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:BELONGS_TO_CLUSTER]->(c:Cluster)
     WHERE c.clusterId IN $clusterIds
     OPTIONAL MATCH (:Symbol)-[:DEPENDS_ON]->(s)
     WITH c, s, COUNT(*) AS fanIn
     RETURN c.clusterId AS clusterId, s.symbolId AS symbolId, s.name AS name, s.kind AS kind, fanIn AS fanIn
     ORDER BY clusterId ASC, fanIn DESC, symbolId ASC`,
    { repoId, clusterIds },
  );
  const topByCluster = new Map<string, ClusterDto["topSymbols"]>();
  for (const row of topRows) {
    const list = topByCluster.get(row.clusterId) ?? [];
    if (list.length < 5) {
      list.push({ symbolId: row.symbolId, name: row.name ?? row.symbolId, kind: row.kind ?? "symbol" });
      topByCluster.set(row.clusterId, list);
    }
  }
  return { clusters: clusters.map((cluster) => ({ clusterId: cluster.clusterId, label: cluster.label, memberCount: cluster.symbolCount, topSymbols: topByCluster.get(cluster.clusterId) ?? [] })) };
}

export async function getClusterIdsForSymbols(conn: Connection, symbolIds: string[]): Promise<Map<string, string>> {
  if (symbolIds.length === 0) return new Map();
  const rows = await queryAll<{ symbolId: string; clusterId: string }>(
    conn,
    `MATCH (s:Symbol)-[:BELONGS_TO_CLUSTER]->(c:Cluster)
     WHERE s.symbolId IN $symbolIds
     RETURN s.symbolId AS symbolId, c.clusterId AS clusterId
     ORDER BY symbolId ASC, clusterId ASC`,
    { symbolIds },
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    if (!map.has(row.symbolId)) map.set(row.symbolId, row.clusterId);
  }
  return map;
}

export async function getClusterEdges(conn: Connection, repoId: string): Promise<ClusterEdgesResponseDto> {
  const rows = await queryAll<{ from: string; to: string; kind: string | null; weight: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     MATCH (a)-[:BELONGS_TO_CLUSTER]->(ca:Cluster)
     MATCH (b)-[:BELONGS_TO_CLUSTER]->(cb:Cluster)
     WHERE ca.clusterId <> cb.clusterId
     RETURN ca.clusterId AS from, cb.clusterId AS to, COALESCE(d.edgeType, 'depends') AS kind, COUNT(*) AS weight
     ORDER BY from ASC, to ASC, kind ASC`,
    { repoId },
  );
  const grouped = new Map<string, { from: string; to: string; weight: number; kinds: Record<string, number> }>();
  for (const row of rows) {
    const key = `${row.from}\0${row.to}`;
    const item = grouped.get(key) ?? { from: row.from, to: row.to, weight: 0, kinds: {} };
    const count = toNumber(row.weight);
    const kind = row.kind ?? "depends";
    item.weight += count;
    item.kinds[kind] = count;
    grouped.set(key, item);
  }
  return { edges: Array.from(grouped.values()).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)) };
}

export async function getSymbolEdges(conn: Connection, repoId: string, clusterId: string, kinds: string[], minConfidence: number, limit: number): Promise<SymbolEdgesResponseDto> {
  // LadybugDB 0.16.1 aborts on `kind IN $kinds` when the bound list is empty.
  const kindPredicate = kinds.length > 0 ? "\n       AND kind IN $kinds" : "";
  const rows = await queryAll<{ from: string; to: string; kind: string | null; confidence: unknown; resolution: string | null }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     MATCH (a)-[:BELONGS_TO_CLUSTER]->(:Cluster {clusterId: $clusterId})
     MATCH (b)-[:BELONGS_TO_CLUSTER]->(:Cluster {clusterId: $clusterId})
     WITH a, b, d, COALESCE(d.edgeType, 'depends') AS kind
     WHERE COALESCE(d.confidence, 1.0) >= $minConfidence${kindPredicate}
     RETURN a.symbolId AS from, b.symbolId AS to, kind AS kind, COALESCE(d.confidence, 1.0) AS confidence, COALESCE(d.resolution, 'unknown') AS resolution
     ORDER BY from ASC, to ASC, kind ASC
     LIMIT $limit`,
    { repoId, clusterId, minConfidence, limit, ...(kinds.length > 0 ? { kinds } : {}) },
  );
  return { edges: rows.map((row) => ({ from: row.from, to: row.to, kind: row.kind ?? "depends", confidence: toNumber(row.confidence), resolution: row.resolution ?? "unknown" })) };
}

export async function getSymbolCard(conn: Connection, repoId: string, symbolId: string) {
  const symbol = await ladybugDb.getSymbol(conn, symbolId);
  if (!symbol) return null;
  const cluster = await ladybugDb.getClusterForSymbol(conn, symbolId);
  const fileRow = await querySingle<{ relPath: string | null }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol {symbolId: $symbolId})-[:SYMBOL_IN_FILE]->(f:File)
     RETURN f.relPath AS relPath`,
    { repoId, symbolId },
  );
  const metrics = await ladybugDb.getMetrics(conn, symbolId);
  const depsOut = await queryAll<{ symbolId: string; name: string | null; kind: string | null; edgeKind: string | null }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})-[d:DEPENDS_ON]->(t:Symbol)
     RETURN t.symbolId AS symbolId, t.name AS name, t.kind AS kind, COALESCE(d.edgeType, 'depends') AS edgeKind
     ORDER BY symbolId ASC, edgeKind ASC
     LIMIT 10`,
    { symbolId },
  );
  const depsIn = await queryAll<{ symbolId: string; name: string | null; kind: string | null; edgeKind: string | null }>(
    conn,
    `MATCH (t:Symbol)-[d:DEPENDS_ON]->(s:Symbol {symbolId: $symbolId})
     RETURN t.symbolId AS symbolId, t.name AS name, t.kind AS kind, COALESCE(d.edgeType, 'depends') AS edgeKind
     ORDER BY symbolId ASC, edgeKind ASC
     LIMIT 10`,
    { symbolId },
  );
  const toDep = (row: { symbolId: string; name: string | null; kind: string | null; edgeKind: string | null }) => ({
    symbolId: row.symbolId,
    name: row.name ?? row.symbolId,
    kind: row.kind ?? "symbol",
    edgeKind: row.edgeKind ?? "depends",
  });
  return {
    symbolId: symbol.symbolId,
    name: symbol.name,
    kind: symbol.kind,
    signature: symbol.signatureJson,
    summary: symbol.summary,
    relPath: fileRow?.relPath ?? null,
    clusterId: cluster?.clusterId ?? null,
    metrics: {
      fanIn: toNumber(metrics?.fanIn ?? 0),
      fanOut: toNumber(metrics?.fanOut ?? 0),
      churn: toNumber(metrics?.churn30d ?? 0),
    },
    deps: { in: depsIn.map(toDep), out: depsOut.map(toDep) },
  };
}
