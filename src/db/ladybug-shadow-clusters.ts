/**
 * ladybug-shadow-clusters.ts - Shadow Cluster Operations
 *
 * "Shadow" communities are persisted alongside canonical clusters but are
 * never read by canonical cluster queries. They exist so that alternative
 * community-detection algorithms (Louvain in v1) can run in parallel with
 * label-propagation for evaluation, divergence telemetry, and future
 * promotion without risking the canonical ranking paths.
 *
 * Storage:
 *   Node table: ShadowCluster
 *   Rel tables: BELONGS_TO_SHADOW_CLUSTER (Symbol -> ShadowCluster)
 *               SHADOW_CLUSTER_IN_REPO    (ShadowCluster -> Repo)
 */
import type { Connection } from "kuzu";
import {
  exec,
  queryAll,
  querySingle,
  toNumber,
  withTransaction,
} from "./ladybug-core.js";

export interface ShadowClusterRow {
  shadowClusterId: string;
  repoId: string;
  algorithm: string;
  label: string;
  symbolCount: number;
  modularity: number;
  versionId: string | null;
  createdAt: string;
}

export interface ShadowClusterMemberRow {
  symbolId: string;
  membershipScore: number;
}

export interface ShadowClusterMemberForRepoRow {
  shadowClusterId: string;
  symbolId: string;
  membershipScore: number;
}

export interface ShadowClusterForSymbolRow {
  shadowClusterId: string;
  algorithm: string;
  label: string;
  symbolCount: number;
  membershipScore: number;
}

export async function upsertShadowCluster(
  conn: Connection,
  row: ShadowClusterRow,
): Promise<void> {
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (c:ShadowCluster {shadowClusterId: $shadowClusterId})
     SET c.repoId = $repoId,
         c.algorithm = $algorithm,
         c.label = $label,
         c.symbolCount = $symbolCount,
         c.modularity = $modularity,
         c.versionId = $versionId,
         c.createdAt = $createdAt
     MERGE (c)-[:SHADOW_CLUSTER_IN_REPO]->(r)`,
    {
      shadowClusterId: row.shadowClusterId,
      repoId: row.repoId,
      algorithm: row.algorithm,
      label: row.label,
      symbolCount: row.symbolCount,
      modularity: row.modularity,
      versionId: row.versionId,
      createdAt: row.createdAt,
    },
  );
}

export async function upsertShadowClusterMember(
  conn: Connection,
  row: {
    symbolId: string;
    shadowClusterId: string;
    membershipScore: number;
  },
): Promise<void> {
  await exec(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     MATCH (c:ShadowCluster {shadowClusterId: $shadowClusterId})
     MERGE (s)-[m:BELONGS_TO_SHADOW_CLUSTER]->(c)
     SET m.membershipScore = $membershipScore`,
    {
      symbolId: row.symbolId,
      shadowClusterId: row.shadowClusterId,
      membershipScore: row.membershipScore,
    },
  );
}

export async function upsertShadowClusterMembersBatch(
  conn: Connection,
  members: Array<{
    symbolId: string;
    shadowClusterId: string;
    membershipScore: number;
  }>,
): Promise<void> {
  if (members.length === 0) return;
  await withTransaction(conn, async (txConn) => {
    for (const member of members) {
      await exec(
        txConn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         MATCH (c:ShadowCluster {shadowClusterId: $shadowClusterId})
         MERGE (s)-[m:BELONGS_TO_SHADOW_CLUSTER]->(c)
         SET m.membershipScore = $membershipScore`,
        {
          symbolId: member.symbolId,
          shadowClusterId: member.shadowClusterId,
          membershipScore: member.membershipScore,
        },
      );
    }
  });
}

export async function getShadowClusterForSymbol(
  conn: Connection,
  symbolId: string,
): Promise<ShadowClusterForSymbolRow | null> {
  const row = await querySingle<{
    shadowClusterId: string;
    algorithm: string;
    label: string;
    symbolCount: unknown;
    membershipScore: unknown;
  }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})-[m:BELONGS_TO_SHADOW_CLUSTER]->(c:ShadowCluster)
     RETURN c.shadowClusterId AS shadowClusterId,
            c.algorithm AS algorithm,
            c.label AS label,
            c.symbolCount AS symbolCount,
            coalesce(m.membershipScore, 1.0) AS membershipScore`,
    { symbolId },
  );
  if (!row) return null;
  return {
    shadowClusterId: row.shadowClusterId,
    algorithm: row.algorithm,
    label: row.label,
    symbolCount: toNumber(row.symbolCount),
    membershipScore: toNumber(row.membershipScore ?? 1),
  };
}

export async function getShadowClustersForSymbols(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, ShadowClusterForSymbolRow>> {
  const result = new Map<string, ShadowClusterForSymbolRow>();
  if (symbolIds.length === 0) return result;
  const rows = await queryAll<{
    symbolId: string;
    shadowClusterId: string;
    algorithm: string;
    label: string;
    symbolCount: unknown;
    membershipScore: unknown;
  }>(
    conn,
    `MATCH (s:Symbol)-[m:BELONGS_TO_SHADOW_CLUSTER]->(c:ShadowCluster)
     WHERE s.symbolId IN $symbolIds
     RETURN s.symbolId AS symbolId,
            c.shadowClusterId AS shadowClusterId,
            c.algorithm AS algorithm,
            c.label AS label,
            c.symbolCount AS symbolCount,
            coalesce(m.membershipScore, 1.0) AS membershipScore`,
    { symbolIds },
  );
  for (const row of rows) {
    if (result.has(row.symbolId)) continue;
    result.set(row.symbolId, {
      shadowClusterId: row.shadowClusterId,
      algorithm: row.algorithm,
      label: row.label,
      symbolCount: toNumber(row.symbolCount),
      membershipScore: toNumber(row.membershipScore ?? 1),
    });
  }
  return result;
}

export async function getShadowClustersForRepo(
  conn: Connection,
  repoId: string,
): Promise<ShadowClusterRow[]> {
  const rows = await queryAll<{
    shadowClusterId: string;
    algorithm: string;
    label: string;
    symbolCount: unknown;
    modularity: unknown;
    versionId: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (c:ShadowCluster {repoId: $repoId})
     RETURN c.shadowClusterId AS shadowClusterId,
            c.algorithm AS algorithm,
            c.label AS label,
            c.symbolCount AS symbolCount,
            coalesce(c.modularity, 0.0) AS modularity,
            c.versionId AS versionId,
            c.createdAt AS createdAt`,
    { repoId },
  );
  return rows.map((row) => ({
    shadowClusterId: row.shadowClusterId,
    repoId,
    algorithm: row.algorithm,
    label: row.label,
    symbolCount: toNumber(row.symbolCount),
    modularity: toNumber(row.modularity ?? 0),
    versionId: row.versionId,
    createdAt: row.createdAt,
  }));
}

export async function getShadowClusterMembersForRepo(
  conn: Connection,
  repoId: string,
): Promise<ShadowClusterMemberForRepoRow[]> {
  const rows = await queryAll<{
    shadowClusterId: string;
    symbolId: string;
    membershipScore: unknown;
  }>(
    conn,
    `MATCH (s:Symbol)-[m:BELONGS_TO_SHADOW_CLUSTER]->(c:ShadowCluster {repoId: $repoId})
     RETURN c.shadowClusterId AS shadowClusterId,
            s.symbolId AS symbolId,
            coalesce(m.membershipScore, 1.0) AS membershipScore`,
    { repoId },
  );
  return rows.map((row) => ({
    shadowClusterId: row.shadowClusterId,
    symbolId: row.symbolId,
    membershipScore: toNumber(row.membershipScore ?? 1),
  }));
}

/**
 * Delete shadow clusters for a repo. Scoped to shadow data only; canonical
 * Cluster tables are left untouched. Idempotent per repo/algorithm run.
 */
export async function deleteShadowClustersByRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await withTransaction(conn, async (txConn) => {
    await exec(
      txConn,
      `MATCH (c:ShadowCluster {repoId: $repoId})
       OPTIONAL MATCH (:Symbol)-[m:BELONGS_TO_SHADOW_CLUSTER]->(c)
       DELETE m`,
      { repoId },
    );
    await exec(
      txConn,
      `MATCH (c:ShadowCluster {repoId: $repoId})-[rel:SHADOW_CLUSTER_IN_REPO]->(:Repo {repoId: $repoId})
       DELETE rel`,
      { repoId },
    );
    await exec(
      txConn,
      `MATCH (c:ShadowCluster {repoId: $repoId})
       DELETE c`,
      { repoId },
    );
  });
}
