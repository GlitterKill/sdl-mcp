/**
 * ladybug-versions.ts - Version and Snapshot Operations
 * Extracted from ladybug-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import {
  exec,
  queryAll,
  querySingle,
  toNumber,
  assertSafeInt,
} from "./ladybug-core.js";
import { DEFAULT_BATCH_QUERY_LIMIT } from "../config/constants.js";

export interface VersionRow {
  versionId: string;
  repoId: string;
  createdAt: string;
  reason: string | null;
  prevVersionHash: string | null;
  versionHash: string | null;
}

export interface SymbolVersionRow {
  id: string;
  versionId: string;
  symbolId: string;
  astFingerprint: string;
  signatureJson: string | null;
  summary: string | null;
  invariantsJson: string | null;
  sideEffectsJson: string | null;
}

export async function createVersion(
  conn: Connection,
  version: VersionRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (r:Repo {repoId: $repoId})
     MERGE (v:Version {versionId: $versionId})
     SET v.createdAt = $createdAt,
         v.reason = $reason,
         v.prevVersionHash = $prevVersionHash,
         v.versionHash = $versionHash
     MERGE (v)-[:VERSION_OF_REPO]->(r)`,
    {
      versionId: version.versionId,
      repoId: version.repoId,
      createdAt: version.createdAt,
      reason: version.reason,
      prevVersionHash: version.prevVersionHash,
      versionHash: version.versionHash,
    },
  );
}

export async function updateVersionHashes(
  conn: Connection,
  versionId: string,
  prevVersionHash: string | null,
  versionHash: string | null,
): Promise<void> {
  await exec(
    conn,
    `MATCH (v:Version {versionId: $versionId})
     SET v.prevVersionHash = $prevVersionHash,
         v.versionHash = $versionHash`,
    { versionId, prevVersionHash, versionHash },
  );
}

export async function getVersion(
  conn: Connection,
  versionId: string,
): Promise<VersionRow | null> {
  const row = await querySingle<{
    versionId: string;
    repoId: string;
    createdAt: string;
    reason: string | null;
    prevVersionHash: string | null;
    versionHash: string | null;
  }>(
    conn,
    `MATCH (v:Version {versionId: $versionId})-[:VERSION_OF_REPO]->(r:Repo)
     RETURN v.versionId AS versionId,
            r.repoId AS repoId,
            v.createdAt AS createdAt,
            v.reason AS reason,
            v.prevVersionHash AS prevVersionHash,
            v.versionHash AS versionHash`,
    { versionId },
  );

  return row ?? null;
}

export async function getLatestVersion(
  conn: Connection,
  repoId: string,
): Promise<VersionRow | null> {
  const row = await querySingle<{
    versionId: string;
    createdAt: string;
    reason: string | null;
    prevVersionHash: string | null;
    versionHash: string | null;
  }>(
    conn,
    `MATCH (v:Version)-[:VERSION_OF_REPO]->(r:Repo {repoId: $repoId})
     RETURN v.versionId AS versionId,
            v.createdAt AS createdAt,
            v.reason AS reason,
            v.prevVersionHash AS prevVersionHash,
            v.versionHash AS versionHash
     ORDER BY v.createdAt DESC
     LIMIT 1`,
    // Note: ISO-8601 string sort is correct because all createdAt values
    // use Date.toISOString() which produces consistent UTC format with ms precision.
    { repoId },
  );

  if (!row) return null;

  return { repoId, ...row };
}

export async function getVersionsByRepo(
  conn: Connection,
  repoId: string,
  limit = DEFAULT_BATCH_QUERY_LIMIT,
): Promise<VersionRow[]> {
  assertSafeInt(limit, "limit");
  const maxFetch = Math.max(0, Math.min(limit, 10000));

  const rows = await queryAll<{
    versionId: string;
    createdAt: string;
    reason: string | null;
    prevVersionHash: string | null;
    versionHash: string | null;
  }>(
    conn,
    `MATCH (v:Version)-[:VERSION_OF_REPO]->(r:Repo {repoId: $repoId})
     RETURN v.versionId AS versionId,
            v.createdAt AS createdAt,
            v.reason AS reason,
            v.prevVersionHash AS prevVersionHash,
            v.versionHash AS versionHash
     ORDER BY v.createdAt DESC
     LIMIT $limit`,
    { repoId, limit: maxFetch },
  );

  return rows.map((row) => ({ repoId, ...row }));
}

export async function snapshotSymbolVersion(
  conn: Connection,
  row: Omit<SymbolVersionRow, "id">,
): Promise<void> {
  const id = `${row.versionId}:${row.symbolId}`;

  await exec(
    conn,
    `MERGE (sv:SymbolVersion {id: $id})
     SET sv.versionId = $versionId,
         sv.symbolId = $symbolId,
         sv.astFingerprint = $astFingerprint,
         sv.signatureJson = $signatureJson,
         sv.summary = $summary,
         sv.invariantsJson = $invariantsJson,
         sv.sideEffectsJson = $sideEffectsJson`,
    {
      id,
      versionId: row.versionId,
      symbolId: row.symbolId,
      astFingerprint: row.astFingerprint,
      signatureJson: row.signatureJson,
      summary: row.summary,
      invariantsJson: row.invariantsJson,
      sideEffectsJson: row.sideEffectsJson,
    },
  );
}

export async function getSymbolVersionsByIds(
  conn: Connection,
  versionId: string,
  symbolIds: string[],
): Promise<SymbolVersionRow[]> {
  if (symbolIds.length === 0) return [];

  const rows = await queryAll<SymbolVersionRow>(
    conn,
    `MATCH (sv:SymbolVersion {versionId: $versionId})
     WHERE sv.symbolId IN $symbolIds
     RETURN sv.id AS id,
            sv.versionId AS versionId,
            sv.symbolId AS symbolId,
            sv.astFingerprint AS astFingerprint,
            sv.signatureJson AS signatureJson,
            sv.summary AS summary,
            sv.invariantsJson AS invariantsJson,
            sv.sideEffectsJson AS sideEffectsJson`,
    { versionId, symbolIds },
  );
  return rows;
}

export async function getSymbolVersionsAtVersion(
  conn: Connection,
  versionId: string,
): Promise<SymbolVersionRow[]> {
  const rows = await queryAll<SymbolVersionRow>(
    conn,
    `MATCH (sv:SymbolVersion {versionId: $versionId})
     RETURN sv.id AS id,
            sv.versionId AS versionId,
            sv.symbolId AS symbolId,
            sv.astFingerprint AS astFingerprint,
            sv.signatureJson AS signatureJson,
            sv.summary AS summary,
            sv.invariantsJson AS invariantsJson,
            sv.sideEffectsJson AS sideEffectsJson`,
    { versionId },
  );
  return rows;
}

export async function getFanInAtVersion(
  conn: Connection,
  repoId: string,
  symbolId: string,
  versionId: string,
): Promise<number> {
  const symbolAtVersion = await querySingle<{ symbolId: string }>(
    conn,
    `MATCH (sv:SymbolVersion {versionId: $versionId, symbolId: $symbolId})
     RETURN sv.symbolId AS symbolId`,
    { versionId, symbolId },
  );

  if (!symbolAtVersion) {
    const metricsRow = await querySingle<{ fanIn: unknown }>(
      conn,
      `MATCH (m:Metrics {symbolId: $symbolId})
       RETURN m.fanIn AS fanIn`,
      { symbolId },
    );
    return metricsRow ? toNumber(metricsRow.fanIn) : 0;
  }

  const row = await querySingle<{ cnt: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(from:Symbol)-[d:DEPENDS_ON]->(to:Symbol {symbolId: $symbolId})
     MATCH (sv:SymbolVersion {versionId: $versionId, symbolId: from.symbolId})
     RETURN count(d) AS cnt`,
    { repoId, symbolId, versionId },
  );

  return row ? toNumber(row.cnt) : 0;
}

export async function batchGetFanInAtVersion(
  conn: Connection,
  repoId: string,
  symbolIds: string[],
  versionId: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (symbolIds.length === 0) return result;

  // Check which symbols exist in this version
  const versionRows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (sv:SymbolVersion)
     WHERE sv.versionId = $versionId AND sv.symbolId IN $symbolIds
     RETURN sv.symbolId AS symbolId`,
    { versionId, symbolIds },
  );
  const inVersion = new Set(versionRows.map((r) => r.symbolId));

  // For symbols NOT in version, fall back to current metrics
  const fallbackIds = symbolIds.filter((id) => !inVersion.has(id));
  if (fallbackIds.length > 0) {
    const metricsRows = await queryAll<{ symbolId: string; fanIn: unknown }>(
      conn,
      `MATCH (m:Metrics)
       WHERE m.symbolId IN $symbolIds
       RETURN m.symbolId AS symbolId, m.fanIn AS fanIn`,
      { symbolIds: fallbackIds },
    );
    for (const row of metricsRows) {
      result.set(row.symbolId, toNumber(row.fanIn));
    }
  }

  // For symbols IN version, count version-scoped incoming edges
  const versionIds = Array.from(inVersion);
  if (versionIds.length > 0) {
    const rows = await queryAll<{ symbolId: string; cnt: unknown }>(
      conn,
      `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(from:Symbol)-[d:DEPENDS_ON]->(to:Symbol)
       WHERE to.symbolId IN $symbolIds
       MATCH (sv:SymbolVersion {versionId: $versionId})
       WHERE sv.symbolId = from.symbolId
       RETURN to.symbolId AS symbolId, count(d) AS cnt`,
      { repoId, symbolIds: versionIds, versionId },
    );
    for (const row of rows) {
      result.set(row.symbolId, toNumber(row.cnt));
    }
  }

  // Ensure all requested symbolIds have entries (default 0)
  for (const id of symbolIds) {
    if (!result.has(id)) result.set(id, 0);
  }

  return result;
}
