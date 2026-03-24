/**
 * ladybug-memory.ts - Memory CRUD Operations
 * Agent memory system: store, query, surface, and manage cross-session memories.
 */
import type { Connection } from "kuzu";
import {
  exec,
  queryAll,
  querySingle,
  toBoolean,
  toNumber,
  assertSafeInt,
  withTransaction,
} from "./ladybug-core.js";

export interface MemoryRow {
  memoryId: string;
  repoId: string;
  type: string;
  title: string;
  content: string;
  contentHash: string;
  searchText: string;
  tagsJson: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  createdByVersion: string;
  stale: boolean;
  staleVersion: string | null;
  sourceFile: string | null;
  deleted: boolean;
}

function toMemoryRow(row: Record<string, unknown>): MemoryRow {
  return {
    memoryId: row.memoryId as string,
    repoId: row.repoId as string,
    type: row.type as string,
    title: row.title as string,
    content: row.content as string,
    contentHash: row.contentHash as string,
    searchText: row.searchText as string,
    tagsJson: (row.tagsJson as string) ?? "[]",
    confidence: toNumber(row.confidence ?? 0.8),
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
    createdByVersion: row.createdByVersion as string,
    stale: toBoolean(row.stale),
    staleVersion: (row.staleVersion as string) ?? null,
    sourceFile: (row.sourceFile as string) ?? null,
    deleted: toBoolean(row.deleted),
  };
}

const MEMORY_RETURN_FIELDS = `
  m.memoryId AS memoryId,
  m.repoId AS repoId,
  m.type AS type,
  m.title AS title,
  m.content AS content,
  m.contentHash AS contentHash,
  m.searchText AS searchText,
  m.tagsJson AS tagsJson,
  m.confidence AS confidence,
  m.createdAt AS createdAt,
  m.updatedAt AS updatedAt,
  m.createdByVersion AS createdByVersion,
  m.stale AS stale,
  m.staleVersion AS staleVersion,
  m.sourceFile AS sourceFile,
  m.deleted AS deleted`;

export async function upsertMemory(
  conn: Connection,
  row: MemoryRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (m:Memory {memoryId: $memoryId})
     SET m.repoId = $repoId,
         m.type = $type,
         m.title = $title,
         m.content = $content,
         m.contentHash = $contentHash,
         m.searchText = $searchText,
         m.tagsJson = $tagsJson,
         m.confidence = $confidence,
         m.createdAt = $createdAt,
         m.updatedAt = $updatedAt,
         m.createdByVersion = $createdByVersion,
         m.stale = $stale,
         m.staleVersion = $staleVersion,
         m.sourceFile = $sourceFile,
         m.deleted = $deleted`,
    {
      memoryId: row.memoryId,
      repoId: row.repoId,
      type: row.type,
      title: row.title,
      content: row.content,
      contentHash: row.contentHash,
      searchText: row.searchText,
      tagsJson: row.tagsJson,
      confidence: row.confidence,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdByVersion: row.createdByVersion,
      stale: row.stale,
      staleVersion: row.staleVersion,
      sourceFile: row.sourceFile,
      deleted: row.deleted,
    },
  );
}

export async function getMemory(
  conn: Connection,
  memoryId: string,
): Promise<MemoryRow | null> {
  const row = await querySingle<Record<string, unknown>>(
    conn,
    `MATCH (m:Memory {memoryId: $memoryId})
     RETURN ${MEMORY_RETURN_FIELDS}`,
    { memoryId },
  );
  return row ? toMemoryRow(row) : null;
}

export async function getMemoryByContentHash(
  conn: Connection,
  contentHash: string,
): Promise<MemoryRow | null> {
  const row = await querySingle<Record<string, unknown>>(
    conn,
    `MATCH (m:Memory {contentHash: $contentHash})
     WHERE m.deleted = false
     RETURN ${MEMORY_RETURN_FIELDS}`,
    { contentHash },
  );
  return row ? toMemoryRow(row) : null;
}

export async function queryMemories(
  conn: Connection,
  options: {
    repoId: string;
    query?: string;
    types?: string[];
    tags?: string[];
    symbolIds?: string[];
    staleOnly?: boolean;
    limit?: number;
    sortBy?: "recency" | "confidence";
  },
): Promise<MemoryRow[]> {
  const safeLimit = options.limit ?? 20;
  assertSafeInt(safeLimit, "limit");

  const useSymbolFilter = options.symbolIds && options.symbolIds.length > 0;

  // When filtering by symbolIds, traverse MEMORY_OF edges
  const matchClause = useSymbolFilter
    ? `MATCH (m:Memory)-[:MEMORY_OF]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds AND m.repoId = $repoId AND m.deleted = false`
    : `MATCH (m:Memory)
       WHERE m.repoId = $repoId AND m.deleted = false`;

  const conditions: string[] = [];
  const params: Record<string, unknown> = { repoId: options.repoId };

  if (useSymbolFilter) {
    params.symbolIds = options.symbolIds;
  }

  if (options.query) {
    conditions.push("m.searchText CONTAINS $query");
    params.query = options.query;
  }

  if (options.types && options.types.length > 0) {
    conditions.push("m.type IN $types");
    params.types = options.types;
  }

  // Tag filtering is handled by the application-level post-filter below
  // (lines ~217-226) for exact array-element matching. We skip Cypher-level
  // tag conditions to keep the query shape stable for prepared statement caching.

  if (options.staleOnly) {
    conditions.push("m.stale = true");
  }

  const whereClause =
    conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

  const orderBy =
    options.sortBy === "confidence"
      ? "ORDER BY confidence DESC"
      : "ORDER BY updatedAt DESC";

  // Over-fetch with a generous LIMIT to bound DB work before JS-side tag filtering
  const overFetchLimit = safeLimit * 5;
  const cypher = `${matchClause}
     ${whereClause}
     RETURN DISTINCT ${MEMORY_RETURN_FIELDS}
     ${orderBy}
     LIMIT ${overFetchLimit}`;

  let rows = await queryAll<Record<string, unknown>>(conn, cypher, params);

  // Post-filter tags at application level for exact array-element matching
  if (options.tags && options.tags.length > 0) {
    rows = rows.filter((row) => {
      try {
        const memTags: string[] = JSON.parse((row.tagsJson as string) || "[]");
        return options.tags!.some((t) => memTags.includes(t));
      } catch {
        return false;
      }
    });
  }

  return rows.slice(0, safeLimit).map(toMemoryRow);
}

export async function softDeleteMemory(
  conn: Connection,
  memoryId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (m:Memory {memoryId: $memoryId})
     SET m.deleted = true`,
    { memoryId },
  );
}

export async function createHasMemoryEdge(
  conn: Connection,
  repoId: string,
  memoryId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId}), (m:Memory {memoryId: $memoryId})
     MERGE (r)-[:HAS_MEMORY]->(m)`,
    { repoId, memoryId },
  );
}

export async function createMemoryOfEdge(
  conn: Connection,
  memoryId: string,
  symbolId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (m:Memory {memoryId: $memoryId}), (s:Symbol {symbolId: $symbolId})
     MERGE (m)-[:MEMORY_OF]->(s)`,
    { memoryId, symbolId },
  );
}

export async function createMemoryOfFileEdge(
  conn: Connection,
  memoryId: string,
  fileId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (m:Memory {memoryId: $memoryId}), (f:File {fileId: $fileId})
     MERGE (m)-[:MEMORY_OF_FILE]->(f)`,
    { memoryId, fileId },
  );
}

export async function deleteMemoryEdges(
  conn: Connection,
  memoryId: string,
): Promise<void> {
  await withTransaction(conn, async (txConn) => {
    // Delete HAS_MEMORY edges (Repo->Memory)
    await exec(
      txConn,
      `MATCH (r:Repo)-[e:HAS_MEMORY]->(m:Memory {memoryId: $memoryId})
       DELETE e`,
      { memoryId },
    );
    // Delete MEMORY_OF edges (Memory->Symbol)
    await exec(
      txConn,
      `MATCH (m:Memory {memoryId: $memoryId})-[e:MEMORY_OF]->(s:Symbol)
       DELETE e`,
      { memoryId },
    );
    // Delete MEMORY_OF_FILE edges (Memory->File)
    await exec(
      txConn,
      `MATCH (m:Memory {memoryId: $memoryId})-[e:MEMORY_OF_FILE]->(f:File)
       DELETE e`,
      { memoryId },
    );
  });
}

export async function getMemoriesForSymbols(
  conn: Connection,
  symbolIds: string[],
  limit: number,
): Promise<(MemoryRow & { linkedSymbolId: string })[]> {
  assertSafeInt(limit, "limit");

  const rows = await queryAll<Record<string, unknown>>(
    conn,
    `MATCH (m:Memory)-[:MEMORY_OF]->(s:Symbol)
     WHERE s.symbolId IN $symbolIds AND m.deleted = false
     RETURN ${MEMORY_RETURN_FIELDS},
            s.symbolId AS linkedSymbolId
     ORDER BY confidence DESC
     LIMIT $limit`,
    { symbolIds, limit },
  );

  return rows.slice(0, limit).map((row) => ({
    ...toMemoryRow(row),
    linkedSymbolId: row.linkedSymbolId as string,
  }));
}

export async function getRepoMemories(
  conn: Connection,
  repoId: string,
  limit: number,
): Promise<MemoryRow[]> {
  assertSafeInt(limit, "limit");

  const rows = await queryAll<Record<string, unknown>>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})-[:HAS_MEMORY]->(m:Memory)
     WHERE m.deleted = false
     RETURN ${MEMORY_RETURN_FIELDS}
     ORDER BY updatedAt DESC
     LIMIT $limit`,
    { repoId, limit },
  );

  return rows.slice(0, limit).map(toMemoryRow);
}

export async function flagMemoriesStale(
  conn: Connection,
  symbolIds: string[],
  staleVersion: string,
): Promise<number> {
  if (symbolIds.length === 0) return 0;

  const rows = await queryAll<{ memoryId: string }>(
    conn,
    `MATCH (m:Memory)-[:MEMORY_OF]->(s:Symbol)
     WHERE s.symbolId IN $symbolIds AND m.deleted = false AND m.stale = false
     SET m.stale = true, m.staleVersion = $staleVersion
     RETURN DISTINCT m.memoryId AS memoryId`,
    { symbolIds, staleVersion },
  );

  return rows.length;
}
