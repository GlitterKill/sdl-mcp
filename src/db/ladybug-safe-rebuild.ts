import type { Connection } from "kuzu";

import {
  assertSafeInt,
  queryAll,
  querySingle,
  toNumber,
} from "./ladybug-core.js";

export interface SafeRebuildRepoMembershipCounts {
  physicalTotal: number;
  distinctTotal: number;
}

export interface SafeRebuildSymbolPointLookupSample {
  symbolIds: string[];
  invalidSymbolIds: string[];
}

export async function readSafeRebuildRepoMembershipCounts(
  conn: Connection,
  repoId: string,
): Promise<SafeRebuildRepoMembershipCounts> {
  const row = await querySingle<{
    physicalTotal: unknown;
    distinctTotal: unknown;
  }>(
    conn,
    `MATCH (:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     RETURN count(s) AS physicalTotal,
            count(DISTINCT s.symbolId) AS distinctTotal`,
    { repoId },
  );
  return {
    physicalTotal: toNumber(row?.physicalTotal ?? 0),
    distinctTotal: toNumber(row?.distinctTotal ?? 0),
  };
}

export async function readSafeRebuildSymbolPointLookupSample(
  conn: Connection,
  limit = 20,
): Promise<SafeRebuildSymbolPointLookupSample> {
  assertSafeInt(limit, "safe rebuild Symbol sample limit");
  const boundedLimit = Math.max(1, Math.min(100, limit));
  const sampled = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (s:Symbol)
     RETURN s.symbolId AS symbolId
     ORDER BY s.symbolId
     LIMIT $limit`,
    { limit: boundedLimit },
  );
  const invalidSymbolIds: string[] = [];
  for (const { symbolId } of sampled) {
    const point = await querySingle<{ copies: unknown }>(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})
       RETURN count(s) AS copies`,
      { symbolId },
    );
    if (toNumber(point?.copies ?? 0) !== 1) {
      invalidSymbolIds.push(symbolId);
    }
  }
  return {
    symbolIds: sampled.map((row) => row.symbolId),
    invalidSymbolIds,
  };
}

/**
 * Force LadybugDB to evaluate LOWER() over every canonical Symbol string
 * column. A corrupt string dictionary/column fails the scan instead of being
 * discovered later by an agent-facing search.
 */
export async function validateSafeRebuildCanonicalStrings(
  conn: Connection,
): Promise<void> {
  await querySingle<Record<string, unknown>>(
    conn,
    `MATCH (s:Symbol)
     RETURN sum(size(LOWER(coalesce(s.symbolId, '')))) AS symbolIdBytes,
            sum(size(LOWER(coalesce(s.repoId, '')))) AS repoIdBytes,
            sum(size(LOWER(coalesce(s.kind, '')))) AS kindBytes,
            sum(size(LOWER(coalesce(s.name, '')))) AS nameBytes,
            sum(size(LOWER(coalesce(s.visibility, '')))) AS visibilityBytes,
            sum(size(LOWER(coalesce(s.language, '')))) AS languageBytes,
            sum(size(LOWER(coalesce(s.astFingerprint, '')))) AS fingerprintBytes,
            sum(size(LOWER(coalesce(s.signatureJson, '')))) AS signatureBytes,
            sum(size(LOWER(coalesce(s.summary, '')))) AS summaryBytes,
            sum(size(LOWER(coalesce(s.summarySource, '')))) AS summarySourceBytes,
            sum(size(LOWER(coalesce(s.invariantsJson, '')))) AS invariantsBytes,
            sum(size(LOWER(coalesce(s.sideEffectsJson, '')))) AS sideEffectsBytes,
            sum(size(LOWER(coalesce(s.roleTagsJson, '')))) AS roleTagsBytes,
            sum(size(LOWER(coalesce(s.searchText, '')))) AS searchTextBytes,
            sum(size(LOWER(coalesce(s.updatedAt, '')))) AS updatedAtBytes,
            sum(size(LOWER(coalesce(s.scipSymbol, '')))) AS scipSymbolBytes,
            sum(size(LOWER(coalesce(s.source, '')))) AS sourceBytes,
            sum(size(LOWER(coalesce(s.packageName, '')))) AS packageNameBytes,
            sum(size(LOWER(coalesce(s.packageVersion, '')))) AS packageVersionBytes,
            sum(size(LOWER(coalesce(s.symbolStatus, '')))) AS statusBytes,
            sum(size(LOWER(coalesce(s.placeholderKind, '')))) AS placeholderKindBytes,
            sum(size(LOWER(coalesce(s.placeholderTarget, '')))) AS placeholderTargetBytes`,
  );
}

export async function countInvalidSafeRebuildDependencyEndpoints(
  conn: Connection,
): Promise<number> {
  const row = await querySingle<{ invalidEndpoints: unknown }>(
    conn,
    `MATCH (a:Symbol)-[:DEPENDS_ON]->(b:Symbol)
     WHERE size(coalesce(a.symbolId, '')) = 0
        OR size(coalesce(b.symbolId, '')) = 0
     RETURN count(*) AS invalidEndpoints`,
  );
  return toNumber(row?.invalidEndpoints ?? 0);
}
