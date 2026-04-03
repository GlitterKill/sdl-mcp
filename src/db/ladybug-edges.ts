/**
 * ladybug-edges.ts � Edge (Dependency) Operations
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
import { logger } from "../util/logger.js";
import { normalizePath } from "../util/paths.js";

// Promise-based singleton for join hint support detection.
// Used by getEdgesToSymbols and getCallersOfSymbols to avoid
// re-probing on every call after the first success/failure.
// NOTE: This is a module-level singleton keyed to "any connection" rather than
// a specific database instance. resetJoinHintCache() is called in closeLadybugDb()
// to handle database switches. For single-DB usage (all known scenarios), this is safe.
let joinHintSupportedPromise: Promise<boolean> | null = null;

async function detectJoinHintSupport(conn: Connection): Promise<boolean> {
  try {
    await queryAll(
      conn,
      `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol) WITH a, d, b HINT (b JOIN (d JOIN a)) RETURN a.symbolId LIMIT 0`,
      {},
    );
    return true;
  } catch (err) {
    logger.warn("Join hint support detection failed", { error: String(err) });
    return false;
  }
}

function getJoinHintSupported(conn: Connection): Promise<boolean> {
  if (!joinHintSupportedPromise) {
    joinHintSupportedPromise = detectJoinHintSupport(conn);
  }
  return joinHintSupportedPromise;
}

/**
 * Reset the cached join-hint detection result.
 * Must be called when closing the database so that
 * a subsequent initLadybugDb() re-probes the new connection.
 */
export function resetJoinHintCache(): void {
  joinHintSupportedPromise = null;
}

export interface EdgeRow {
  repoId: string;
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string;
  weight: number;
  confidence: number;
  resolution: string;
  resolverId?: string;
  resolutionPhase?: string;
  provenance: string | null;
  createdAt: string;
}

export interface EdgeForSlice {
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string;
  weight: number;
  confidence: number;
  resolution?: string;
  resolverId?: string;
  resolutionPhase?: string;
}

export interface EdgeLite {
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string;
}

export interface EdgeQueryOptions {
  minCallConfidence?: number;
}

function buildMinCallConfidenceClause(
  alias: string,
  minCallConfidence: number | undefined,
): string {
  if (minCallConfidence === undefined) {
    return "";
  }

  return ` AND (${alias}.edgeType <> 'call' OR ${alias}.confidence >= $minCallConfidence)`;
}

export async function insertEdge(
  conn: Connection,
  edge: EdgeRow,
): Promise<void> {
  // Note: MERGE on target symbol (b) may create "stub" nodes with only symbolId
  // and SYMBOL_IN_REPO edge when the target hasn't been indexed yet. This is
  // intentional — stubs are populated when the target file is indexed, and
  // queries that need full symbol data filter via SYMBOL_IN_FILE joins.
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (a:Symbol {symbolId: $fromSymbolId})
     MERGE (b:Symbol {symbolId: $toSymbolId})
     MERGE (a)-[:SYMBOL_IN_REPO]->(r)
     MERGE (b)-[:SYMBOL_IN_REPO]->(r)
     MERGE (a)-[d:DEPENDS_ON {edgeType: $edgeType}]->(b)
     SET d.weight = $weight,
         d.confidence = $confidence,
         d.resolution = $resolution,
         d.resolverId = $resolverId,
         d.resolutionPhase = $resolutionPhase,
         d.provenance = $provenance,
         d.createdAt = CASE WHEN d.createdAt IS NOT NULL THEN d.createdAt ELSE $createdAt END`,
    {
      repoId: edge.repoId,
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: edge.edgeType,
      weight: edge.weight,
      confidence: edge.confidence,
      resolution: edge.resolution,
      resolverId: edge.resolverId ?? "pass1-generic",
      resolutionPhase: edge.resolutionPhase ?? "pass1",
      provenance: edge.provenance,
      createdAt: edge.createdAt,
    },
  );
}

/**
 * Upserts edges in a loop because Kuzu does not support UNWIND for
 * parameterized batch MERGE. Wrapped in a transaction to amortize
 * commit overhead.
 */
export async function insertEdges(
  conn: Connection,
  edges: EdgeRow[],
): Promise<void> {
  if (edges.length === 0) return;

  await withTransaction(conn, async (txConn) => {
    const edgesByRepo = new Map<string, EdgeRow[]>();
    for (const edge of edges) {
      const bucket = edgesByRepo.get(edge.repoId);
      if (bucket) bucket.push(edge);
      else edgesByRepo.set(edge.repoId, [edge]);
    }

    for (const [repoId, repoEdges] of edgesByRepo) {
      const fromSymbolIds = [...new Set(repoEdges.map((e) => e.fromSymbolId))];

      for (const symbolId of fromSymbolIds) {
        await exec(
          txConn,
          `MATCH (r:Repo {repoId: $repoId})
           MERGE (s:Symbol {symbolId: $symbolId})
           MERGE (s)-[:SYMBOL_IN_REPO]->(r)`,
          { repoId, symbolId },
        );
      }

      for (const edge of repoEdges) {
        await exec(
          txConn,
          `MERGE (a:Symbol {symbolId: $fromSymbolId})
           MERGE (b:Symbol {symbolId: $toSymbolId})
           MERGE (a)-[d:DEPENDS_ON {edgeType: $edgeType}]->(b)
           SET d.weight = $weight,
               d.confidence = $confidence,
               d.resolution = $resolution,
               d.resolverId = $resolverId,
               d.resolutionPhase = $resolutionPhase,
               d.provenance = $provenance,
               d.createdAt = CASE WHEN d.createdAt IS NOT NULL THEN d.createdAt ELSE $createdAt END`,
          {
            fromSymbolId: edge.fromSymbolId,
            toSymbolId: edge.toSymbolId,
            edgeType: edge.edgeType,
            weight: edge.weight,
            confidence: edge.confidence,
            resolution: edge.resolution,
            resolverId: edge.resolverId ?? "pass1-generic",
            resolutionPhase: edge.resolutionPhase ?? "pass1",
            provenance: edge.provenance,
            createdAt: edge.createdAt,
          },
        );
      }
    }
  });
}

export async function deleteEdge(
  conn: Connection,
  edge: { fromSymbolId: string; toSymbolId: string; edgeType: string },
): Promise<void> {
  await exec(
    conn,
    `MATCH (a:Symbol {symbolId: $fromSymbolId})-[d:DEPENDS_ON]->(b:Symbol {symbolId: $toSymbolId})
     WHERE d.edgeType = $edgeType
     DELETE d`,
    {
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: edge.edgeType,
    },
  );
}

export async function getEdgesFrom(
  conn: Connection,
  symbolId: string,
  options?: EdgeQueryOptions,
): Promise<EdgeRow[]> {
  const minCallConfidenceClause = buildMinCallConfidenceClause(
    "d",
    options?.minCallConfidence,
  );
  const rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    resolverId: string | null;
    resolutionPhase: string | null;
    provenance: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (a:Symbol {symbolId: $symbolId})-[d:DEPENDS_ON]->(b:Symbol)
     WHERE 1 = 1${minCallConfidenceClause}
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase,
            d.provenance AS provenance,
            d.createdAt AS createdAt`,
    {
      symbolId,
      ...(options?.minCallConfidence !== undefined
        ? { minCallConfidence: options.minCallConfidence }
        : {}),
    },
  );

  return rows.map((row) => ({
    repoId: row.repoId,
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
    edgeType: row.edgeType,
    weight: toNumber(row.weight),
    confidence: toNumber(row.confidence),
    resolution: row.resolution,
    resolverId: row.resolverId ?? undefined,
    resolutionPhase: row.resolutionPhase ?? undefined,
    provenance: row.provenance,
    createdAt: row.createdAt,
  }));
}

export async function getEdgesFromSymbols(
  conn: Connection,
  symbolIds: string[],
  options?: EdgeQueryOptions,
): Promise<Map<string, EdgeRow[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeRow[]>();
  for (const id of symbolIds) result.set(id, []);

  const minCallConfidenceClause = buildMinCallConfidenceClause(
    "d",
    options?.minCallConfidence,
  );

  const rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    resolverId: string | null;
    resolutionPhase: string | null;
    provenance: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE a.symbolId IN $symbolIds${minCallConfidenceClause}
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase,
            d.provenance AS provenance,
            d.createdAt AS createdAt`,
    {
      symbolIds,
      ...(options?.minCallConfidence !== undefined
        ? { minCallConfidence: options.minCallConfidence }
        : {}),
    },
  );

  for (const row of rows) {
    const bucket = result.get(row.fromSymbolId);
    if (!bucket) continue;
    bucket.push({
      repoId: row.repoId,
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
      weight: toNumber(row.weight),
      confidence: toNumber(row.confidence),
      resolution: row.resolution,
      resolverId: row.resolverId ?? undefined,
      resolutionPhase: row.resolutionPhase ?? undefined,
      provenance: row.provenance,
      createdAt: row.createdAt,
    });
  }

  return result;
}

export async function getEdgesFromSymbolsForSlice(
  conn: Connection,
  symbolIds: string[],
  options?: EdgeQueryOptions,
): Promise<Map<string, EdgeForSlice[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeForSlice[]>();
  for (const id of symbolIds) result.set(id, []);

  const minCallConfidenceClause = buildMinCallConfidenceClause(
    "d",
    options?.minCallConfidence,
  );

  const rows = await queryAll<{
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string | null;
    resolverId: string | null;
    resolutionPhase: string | null;
  }>(
    conn,
    `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE a.symbolId IN $symbolIds${minCallConfidenceClause}
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase`,
    {
      symbolIds,
      ...(options?.minCallConfidence !== undefined
        ? { minCallConfidence: options.minCallConfidence }
        : {}),
    },
  );

  for (const row of rows) {
    const bucket = result.get(row.fromSymbolId);
    if (!bucket) continue;
    bucket.push({
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
      weight: toNumber(row.weight),
      confidence: toNumber(row.confidence),
      resolution: row.resolution ?? undefined,
      resolverId: row.resolverId ?? undefined,
      resolutionPhase: row.resolutionPhase ?? undefined,
    });
  }

  return result;
}

export async function getEdgesFromSymbolsLite(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, EdgeLite[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeLite[]>();
  for (const id of symbolIds) result.set(id, []);

  const rows = await queryAll<{
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
  }>(
    conn,
    `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE a.symbolId IN $symbolIds
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType`,
    { symbolIds },
  );

  for (const row of rows) {
    const bucket = result.get(row.fromSymbolId);
    if (!bucket) continue;
    bucket.push({
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
    });
  }

  return result;
}

export async function getEdgesToSymbols(
  conn: Connection,
  symbolIds: string[],
  options?: EdgeQueryOptions,
): Promise<Map<string, EdgeRow[]>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, EdgeRow[]>();
  for (const id of symbolIds) result.set(id, []);

  const minCallConfidenceClause = buildMinCallConfidenceClause(
    "d",
    options?.minCallConfidence,
  );

  const queryWithHint = `MATCH (b:Symbol)
     WHERE b.symbolId IN $symbolIds
     MATCH (a:Symbol)-[d:DEPENDS_ON]->(b)
     WHERE 1 = 1${minCallConfidenceClause}
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     WITH b, d, a, r
     HINT (b JOIN (d JOIN a))
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase,
            d.provenance AS provenance,
            d.createdAt AS createdAt
     ORDER BY a.symbolId`;

  const queryWithoutHint = `MATCH (b:Symbol)
     WHERE b.symbolId IN $symbolIds
     MATCH (a:Symbol)-[d:DEPENDS_ON]->(b)
     WHERE 1 = 1${minCallConfidenceClause}
     MATCH (a)-[:SYMBOL_IN_REPO]->(r:Repo)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase,
            d.provenance AS provenance,
            d.createdAt AS createdAt
     ORDER BY a.symbolId`;

  const useJoinHint = await getJoinHintSupported(conn);
  const rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    resolverId: string | null;
    resolutionPhase: string | null;
    provenance: string | null;
    createdAt: string;
  }>(conn, useJoinHint ? queryWithHint : queryWithoutHint, {
    symbolIds,
    ...(options?.minCallConfidence !== undefined
      ? { minCallConfidence: options.minCallConfidence }
      : {}),
  });

  for (const row of rows) {
    const bucket = result.get(row.toSymbolId);
    if (!bucket) continue;
    bucket.push({
      repoId: row.repoId,
      fromSymbolId: row.fromSymbolId,
      toSymbolId: row.toSymbolId,
      edgeType: row.edgeType,
      weight: toNumber(row.weight),
      confidence: toNumber(row.confidence),
      resolution: row.resolution,
      resolverId: row.resolverId ?? undefined,
      resolutionPhase: row.resolutionPhase ?? undefined,
      provenance: row.provenance,
      createdAt: row.createdAt,
    });
  }

  return result;
}

export async function getEdgesByRepo(
  conn: Connection,
  repoId: string,
): Promise<EdgeRow[]> {
  const rows = await queryAll<{
    repoId: string;
    fromSymbolId: string;
    toSymbolId: string;
    edgeType: string;
    weight: unknown;
    confidence: unknown;
    resolution: string;
    resolverId: string | null;
    resolutionPhase: string | null;
    provenance: string | null;
    createdAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     RETURN r.repoId AS repoId,
            a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType,
            d.weight AS weight,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId,
            d.resolutionPhase AS resolutionPhase,
            d.provenance AS provenance,
            d.createdAt AS createdAt`,
    { repoId },
  );

  return rows.map((row) => ({
    repoId: row.repoId,
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
    edgeType: row.edgeType,
    weight: toNumber(row.weight),
    confidence: toNumber(row.confidence),
    resolution: row.resolution,
    resolverId: row.resolverId ?? undefined,
    resolutionPhase: row.resolutionPhase ?? undefined,
    provenance: row.provenance,
    createdAt: row.createdAt,
  }));
}

export async function getEdgesByRepoLite(
  conn: Connection,
  repoId: string,
): Promise<EdgeLite[]> {
  return await queryAll<EdgeLite>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.edgeType AS edgeType`,
    { repoId },
  );
}

export interface UnresolvedImportEdgeCandidate {
  fromSymbolId: string;
  toSymbolId: string;
  provenance: string | null;
}

export interface UnresolvedImportEdgeQueryOptions {
  affectedPaths?: string[];
}

export interface UnresolvedCallEdgeCandidate {
  fromSymbolId: string;
  toSymbolId: string;
}

export async function getUnresolvedImportEdgesByRepo(
  conn: Connection,
  repoId: string,
  options?: UnresolvedImportEdgeQueryOptions,
): Promise<UnresolvedImportEdgeCandidate[]> {
  const affectedPaths = Array.from(
    new Set((options?.affectedPaths ?? []).map((path) => normalizePath(path))),
  ).filter((path) => path.length > 0);
  const params: Record<string, unknown> = { repoId };
  const targetPrefixClauses: string[] = [];
  for (const [index, relPath] of affectedPaths.entries()) {
    const paramName = `targetPrefix${index}`;
    params[paramName] = `unresolved:${relPath}:`;
    targetPrefixClauses.push(`b.symbolId STARTS WITH $${paramName}`);
  }

  const affectedPathsMatchClause =
    affectedPaths.length > 0
      ? `
     MATCH (a)-[:SYMBOL_IN_FILE]->(f:File)`
      : "";
  const affectedPathsFilterClause =
    affectedPaths.length > 0
      ? `
       AND (f.relPath IN $affectedPaths OR ${targetPrefixClauses.join(" OR ")})`
      : "";
  if (affectedPaths.length > 0) {
    params.affectedPaths = affectedPaths;
  }

  const rows = await queryAll<{
    fromSymbolId: string;
    toSymbolId: string;
    provenance: string | null;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     ${affectedPathsMatchClause}
     WHERE d.edgeType = 'import' AND b.symbolId STARTS WITH 'unresolved:'${
       affectedPaths.length > 0
         ? `
       ${affectedPathsFilterClause}`
         : ""
     }
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId,
            d.provenance AS provenance`,
    params,
  );

  return rows.map((row) => ({
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
    provenance: row.provenance,
  }));
}

export async function getUnresolvedCallEdgesByRepo(
  conn: Connection,
  repoId: string,
): Promise<UnresolvedCallEdgeCandidate[]> {
  const rows = await queryAll<{
    fromSymbolId: string;
    toSymbolId: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE d.edgeType = 'call' AND b.symbolId STARTS WITH 'unresolved:call:'
     RETURN a.symbolId AS fromSymbolId,
            b.symbolId AS toSymbolId`,
    { repoId },
  );

  return rows.map((row) => ({
    fromSymbolId: row.fromSymbolId,
    toSymbolId: row.toSymbolId,
  }));
}

export async function getCallersOfSymbols(
  conn: Connection,
  repoId: string,
  symbolIds: string[],
): Promise<string[]> {
  if (symbolIds.length === 0) return [];

  const queryWithHint = `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(to:Symbol)
     WHERE to.symbolId IN $symbolIds
     MATCH (from:Symbol)-[d:DEPENDS_ON]->(to)
     MATCH (from)-[:SYMBOL_IN_REPO]->(r)
     WHERE d.edgeType IN ['call', 'import']
     WITH r, to, d, from
     HINT (to JOIN (d JOIN from))
     RETURN DISTINCT from.symbolId AS symbolId
     ORDER BY symbolId`;

  const queryWithoutHint = `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(to:Symbol)
     WHERE to.symbolId IN $symbolIds
     MATCH (from:Symbol)-[d:DEPENDS_ON]->(to)
     MATCH (from)-[:SYMBOL_IN_REPO]->(r)
     WHERE d.edgeType IN ['call', 'import']
     RETURN DISTINCT from.symbolId AS symbolId
     ORDER BY symbolId`;

  const useJoinHint = await getJoinHintSupported(conn);
  const rows = await queryAll<{ symbolId: string }>(
    conn,
    useJoinHint ? queryWithHint : queryWithoutHint,
    { repoId, symbolIds },
  );

  return rows.map((row) => row.symbolId);
}

export async function deleteEdgesByFileId(
  conn: Connection,
  fileId: string,
): Promise<void> {
  await withTransaction(conn, async (txConn) => {
    const symbolRows = await queryAll<{ symbolId: string }>(
      txConn,
      `MATCH (f:File {fileId: $fileId})<-[:SYMBOL_IN_FILE]-(s:Symbol)
       RETURN s.symbolId AS symbolId`,
      { fileId },
    );

    const symbolIds = symbolRows.map((r) => r.symbolId);
    if (symbolIds.length === 0) return;

    await exec(
      txConn,
      `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );

    await exec(
      txConn,
      `MATCH (:Symbol)-[d:DEPENDS_ON]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );
  });
}

/**
 * Deletes outgoing DEPENDS_ON edges of a specific type for given symbols.
 * NOTE: Callers should wrap this in a transaction if followed by edge insertions
 * to ensure atomic delete+insert behavior.
 */
export async function deleteOutgoingEdgesByTypeForSymbols(
  conn: Connection,
  symbolIds: string[],
  edgeType: string,
): Promise<void> {
  if (symbolIds.length === 0) return;

  await exec(
    conn,
    `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     WHERE s.symbolId IN $symbolIds AND d.edgeType = $edgeType
     DELETE d`,
    { symbolIds, edgeType },
  );
}

export async function getEdgeCountsByType(
  conn: Connection,
  repoId: string,
): Promise<Record<string, number>> {
  const rows = await queryAll<{ edgeType: string; count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     RETURN d.edgeType AS edgeType, count(d) AS count`,
    { repoId },
  );

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.edgeType] = toNumber(row.count);
  }
  return result;
}

export async function getEdgeCount(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     RETURN count(d) AS count`,
    { repoId },
  );
  return row ? toNumber(row.count) : 0;
}

export async function getCallEdgeResolutionCounts(
  conn: Connection,
  repoId: string,
): Promise<{
  totalCallEdges: number;
  resolvedCallEdges: number;
  exactCallEdges: number;
  resolvableCallEdges: number;
}> {
  const total = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     WHERE d.edgeType = 'call'
     RETURN count(d) AS count`,
    { repoId },
  );

  const resolved = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(t:Symbol)
     WHERE d.edgeType = 'call' AND NOT (t.symbolId STARTS WITH 'unresolved:')
     RETURN count(d) AS count`,
    { repoId },
  );

  const exact = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
     WHERE d.edgeType = 'call' AND (d.resolution = 'exact' OR d.confidence >= 0.9)
     RETURN count(d) AS count`,
    { repoId },
  );

  // Count of call edges that target repo-internal symbols (resolvable)
  // Excludes edges targeting 'unresolved:call:' stubs (external/builtin calls)
  const resolvable = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(t:Symbol)
     WHERE d.edgeType = 'call' AND NOT (t.symbolId STARTS WITH 'unresolved:call:')
     RETURN count(d) AS count`,
    { repoId },
  );

  return {
    totalCallEdges: total ? toNumber(total.count) : 0,
    resolvedCallEdges: resolved ? toNumber(resolved.count) : 0,
    exactCallEdges: exact ? toNumber(exact.count) : 0,
    resolvableCallEdges: resolvable ? toNumber(resolvable.count) : 0,
  };
}
