/**
 * ladybug-clusters.ts - Cluster Operations
 * Extracted from ladybug-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import {
  exec,
  queryAll,
  querySingle,
  toNumber,
  withTransaction,
} from "./ladybug-core.js";

export interface ClusterRow {
  clusterId: string;
  repoId: string;
  label: string;
  symbolCount: number;
  cohesionScore: number;
  versionId: string | null;
  createdAt: string;
  searchText?: string | null;
}

export interface ClusterMemberRow {
  symbolId: string;
  membershipScore: number;
}

export interface ClusterForSymbolRow {
  clusterId: string;
  label: string;
  symbolCount: number;
  membershipScore: number;
}

export async function upsertCluster(
  conn: Connection,
  row: ClusterRow,
): Promise<void> {
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (c:Cluster {clusterId: $clusterId})
     SET c.repoId = $repoId,
         c.label = $label,
         c.symbolCount = $symbolCount,
         c.cohesionScore = $cohesionScore,
         c.versionId = $versionId,
         c.createdAt = $createdAt,
         c.searchText = $searchText
     MERGE (c)-[:CLUSTER_IN_REPO]->(r)`,
    {
      clusterId: row.clusterId,
      repoId: row.repoId,
      label: row.label,
      symbolCount: row.symbolCount,
      cohesionScore: row.cohesionScore,
      versionId: row.versionId,
      createdAt: row.createdAt,
      searchText: row.searchText ?? null,
    },
  );
}

/**
 * Build a search-friendly text string for a cluster.
 * Concatenates the label with up to 20 representative member symbol names.
 */
export function buildClusterSearchText(
  label: string,
  memberSymbolNames: string[],
): string {
  const names = memberSymbolNames.slice(0, 20).join(" ");
  return `cluster: ${label} members: ${names}`.trim();
}

export async function upsertClusterMember(
  conn: Connection,
  row: { symbolId: string; clusterId: string; membershipScore: number },
): Promise<void> {
  await exec(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     MATCH (c:Cluster {clusterId: $clusterId})
     MERGE (s)-[m:BELONGS_TO_CLUSTER]->(c)
     SET m.membershipScore = $membershipScore`,
    {
      symbolId: row.symbolId,
      clusterId: row.clusterId,
      membershipScore: row.membershipScore,
    },
  );
}

/**
 * Upserts cluster members in a loop because Kuzu does not support UNWIND
 * for parameterized batch MERGE. Wrapped in a transaction to amortize
 * commit overhead.
 */
export async function upsertClusterMembersBatch(
  conn: Connection,
  members: Array<{
    symbolId: string;
    clusterId: string;
    membershipScore: number;
  }>,
): Promise<void> {
  if (members.length === 0) return;
  await withTransaction(conn, async (txConn) => {
    for (const member of members) {
      await exec(
        txConn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         MATCH (c:Cluster {clusterId: $clusterId})
         MERGE (s)-[m:BELONGS_TO_CLUSTER]->(c)
         SET m.membershipScore = $membershipScore`,
        {
          symbolId: member.symbolId,
          clusterId: member.clusterId,
          membershipScore: member.membershipScore,
        },
      );
    }
  });
}

export async function getClusterForSymbol(
  conn: Connection,
  symbolId: string,
): Promise<ClusterForSymbolRow | null> {
  const row = await querySingle<{
    clusterId: string;
    label: string;
    symbolCount: unknown;
    membershipScore: unknown;
  }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})-[m:BELONGS_TO_CLUSTER]->(c:Cluster)
     RETURN c.clusterId AS clusterId,
            c.label AS label,
            c.symbolCount AS symbolCount,
            m.membershipScore AS membershipScore`,
    { symbolId },
  );

  if (!row) return null;

  return {
    clusterId: row.clusterId,
    label: row.label,
    symbolCount: toNumber(row.symbolCount),
    membershipScore: toNumber(row.membershipScore ?? 0),
  };
}

export async function getClustersForSymbols(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, ClusterForSymbolRow>> {
  if (symbolIds.length === 0) return new Map();

  const rows = await queryAll<{
    symbolId: string;
    clusterId: string;
    label: string;
    symbolCount: unknown;
    membershipScore: unknown;
  }>(
    conn,
    `MATCH (s:Symbol)-[m:BELONGS_TO_CLUSTER]->(c:Cluster)
     WHERE s.symbolId IN $symbolIds
     RETURN s.symbolId AS symbolId,
            c.clusterId AS clusterId,
            c.label AS label,
            c.symbolCount AS symbolCount,
            m.membershipScore AS membershipScore
     ORDER BY symbolId ASC, clusterId ASC`,
    { symbolIds },
  );

  const map = new Map<string, ClusterForSymbolRow>();
  for (const row of rows) {
    if (map.has(row.symbolId)) continue;
    map.set(row.symbolId, {
      clusterId: row.clusterId,
      label: row.label,
      symbolCount: toNumber(row.symbolCount),
      membershipScore: toNumber(row.membershipScore ?? 0),
    });
  }

  return map;
}

export async function getClustersForRepo(
  conn: Connection,
  repoId: string,
): Promise<ClusterRow[]> {
  const rows = await queryAll<{
    clusterId: string;
    label: string;
    symbolCount: unknown;
    cohesionScore: unknown;
    versionId: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:CLUSTER_IN_REPO]-(c:Cluster)
     RETURN c.clusterId AS clusterId,
            c.label AS label,
            c.symbolCount AS symbolCount,
            c.cohesionScore AS cohesionScore,
            c.versionId AS versionId,
            c.createdAt AS createdAt
     ORDER BY c.clusterId`,
    { repoId },
  );

  return rows.map((row) => ({
    clusterId: row.clusterId,
    repoId,
    label: row.label,
    symbolCount: toNumber(row.symbolCount),
    cohesionScore: toNumber(row.cohesionScore ?? 0),
    versionId: row.versionId,
    createdAt: row.createdAt,
  }));
}

export async function getClusterMembersForRepo(
  conn: Connection,
  repoId: string,
): Promise<Array<{ symbolId: string; clusterId: string }>> {
  const rows = await queryAll<{ symbolId: string; clusterId: string }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:BELONGS_TO_CLUSTER]->(c:Cluster)
     RETURN s.symbolId AS symbolId, c.clusterId AS clusterId`,
    { repoId },
  );
  return rows;
}

export async function getClusterOverviewStats(
  conn: Connection,
  repoId: string,
): Promise<{
  totalClusters: number;
  averageClusterSize: number;
  largestClusters: Array<{ clusterId: string; label: string; size: number }>;
}> {
  const agg = await querySingle<{
    totalClusters: unknown;
    averageClusterSize: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:CLUSTER_IN_REPO]-(c:Cluster)
     RETURN COUNT(c) AS totalClusters,
            AVG(c.symbolCount) AS averageClusterSize`,
    { repoId },
  );

  const top = await queryAll<{
    clusterId: string;
    label: string;
    size: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:CLUSTER_IN_REPO]-(c:Cluster)
     RETURN c.clusterId AS clusterId,
            c.label AS label,
            c.symbolCount AS size
     ORDER BY size DESC, clusterId ASC
     LIMIT 5`,
    { repoId },
  );

  return {
    totalClusters: toNumber(agg?.totalClusters ?? 0),
    averageClusterSize: toNumber(agg?.averageClusterSize ?? 0),
    largestClusters: top.map((row) => ({
      clusterId: row.clusterId,
      label: row.label,
      size: toNumber(row.size),
    })),
  };
}

export async function getClusterMembers(
  conn: Connection,
  clusterId: string,
): Promise<ClusterMemberRow[]> {
  const rows = await queryAll<{
    symbolId: string;
    membershipScore: unknown;
  }>(
    conn,
    `MATCH (s:Symbol)-[m:BELONGS_TO_CLUSTER]->(c:Cluster {clusterId: $clusterId})
     RETURN s.symbolId AS symbolId,
            m.membershipScore AS membershipScore
     ORDER BY symbolId`,
    { clusterId },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    membershipScore: toNumber(row.membershipScore ?? 0),
  }));
}

export async function getRelatedClusters(
  conn: Connection,
  clusterId: string,
  limit: number = 20,
): Promise<Array<{ clusterId: string; edgeCount: number }>> {
  const rows = await queryAll<{ clusterId: string }>(
    conn,
    `MATCH (c1:Cluster {clusterId: $clusterId})<-[:BELONGS_TO_CLUSTER]-(s:Symbol)
     MATCH (s)-[d:DEPENDS_ON]->(t:Symbol)-[:BELONGS_TO_CLUSTER]->(c2:Cluster)
     WHERE c2.clusterId <> $clusterId
     RETURN c2.clusterId AS clusterId`,
    { clusterId },
  );

  const edgeCounts = new Map<string, number>();
  for (const row of rows) {
    edgeCounts.set(row.clusterId, (edgeCounts.get(row.clusterId) ?? 0) + 1);
  }

  const results = Array.from(edgeCounts.entries()).map(
    ([clusterId, edgeCount]) => ({
      clusterId,
      edgeCount,
    }),
  );

  results.sort(
    (a, b) =>
      b.edgeCount - a.edgeCount || a.clusterId.localeCompare(b.clusterId),
  );

  return results.slice(0, Math.max(1, limit));
}

/**
 * Backfill searchText for all clusters in a repo.
 * Fetches each cluster's members, resolves symbol names, and updates searchText.
 * Returns the count of clusters updated.
 */
export async function backfillClusterSearchText(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const clusters = await getClustersForRepo(conn, repoId);
  if (clusters.length === 0) return 0;

  let updated = 0;
  await withTransaction(conn, async (txConn) => {
    for (const cluster of clusters) {
      const members = await getClusterMembers(txConn, cluster.clusterId);
      const symbolIds = members.map((m) => m.symbolId);

      // Fetch names for the member symbols
      const nameRows = await queryAll<{ symbolId: string; name: string }>(
        txConn,
        `MATCH (s:Symbol)
         WHERE s.symbolId IN $symbolIds
         RETURN s.symbolId AS symbolId, s.name AS name`,
        { symbolIds },
      );
      const nameMap = new Map(nameRows.map((r) => [r.symbolId, r.name]));
      const memberNames = symbolIds
        .map((id) => nameMap.get(id))
        .filter((n): n is string => Boolean(n));

      const searchText = buildClusterSearchText(cluster.label, memberNames);
      await exec(
        txConn,
        `MATCH (c:Cluster {clusterId: $clusterId})
         SET c.searchText = $searchText`,
        { clusterId: cluster.clusterId, searchText },
      );
      updated++;
    }
  });

  return updated;
}

export async function deleteClustersByRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await withTransaction(conn, async (txConn) => {
    await exec(
      txConn,
      `MATCH (c:Cluster {repoId: $repoId})
       OPTIONAL MATCH (:Symbol)-[m:BELONGS_TO_CLUSTER]->(c)
       DELETE m`,
      { repoId },
    );

    await exec(
      txConn,
      `MATCH (c:Cluster {repoId: $repoId})-[rel:CLUSTER_IN_REPO]->(:Repo {repoId: $repoId})
       DELETE rel`,
      { repoId },
    );

    await exec(
      txConn,
      `MATCH (c:Cluster {repoId: $repoId})
       DELETE c`,
      { repoId },
    );
  });
}
