/**
 * ladybug-repos.ts � Repository and File Operations
 * Extracted from ladybug-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import {
  exec,
  queryAll,
  querySingle,
  toNumber,
  assertSafeInt,
  withTransaction,
} from "./ladybug-core.js";
import { normalizePath } from "../util/paths.js";
import { DEFAULT_QUERY_LIMIT } from "../config/constants.js";

export interface MetricsRow {
  symbolId: string;
  fanIn: number;
  fanOut: number;
  churn30d: number;
  testRefsJson: string | null;
  canonicalTestJson: string | null;
  updatedAt: string;
}

export interface TopSymbolByFanInRow {
  symbolId: string;
  fanIn: number;
  fanOut: number;
  churn30d: number;
}

export interface FanInOut {
  fanIn: number;
  fanOut: number;
}

export interface RepoRow {
  repoId: string;
  rootPath: string;
  configJson: string;
  createdAt: string;
}

export interface FileRow {
  fileId: string;
  repoId: string;
  relPath: string;
  contentHash: string;
  language: string;
  byteSize: number;
  lastIndexedAt: string | null;
  directory: string;
}

function computeDirectory(relPath: string): string {
  const normalized = normalizePath(relPath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
}

export async function upsertRepo(
  conn: Connection,
  repo: RepoRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (r:Repo {repoId: $repoId})
     ON CREATE SET r.createdAt = $createdAt
     SET r.rootPath = $rootPath,
         r.configJson = $configJson`,
    {
      repoId: repo.repoId,
      rootPath: normalizePath(repo.rootPath),
      configJson: repo.configJson,
      createdAt: repo.createdAt,
    },
  );
}

export async function getRepo(
  conn: Connection,
  repoId: string,
): Promise<RepoRow | null> {
  const row = await querySingle<RepoRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     RETURN r.repoId AS repoId,
            r.rootPath AS rootPath,
            r.configJson AS configJson,
            r.createdAt AS createdAt`,
    { repoId },
  );
  return row ?? null;
}

export async function listRepos(
  conn: Connection,
  limit = DEFAULT_QUERY_LIMIT,
): Promise<RepoRow[]> {
  assertSafeInt(limit, "limit");
  const maxFetch = Math.min(Math.max(0, limit), 10000);

  const rows = await queryAll<RepoRow>(
    conn,
    `MATCH (r:Repo)
     RETURN r.repoId AS repoId,
            r.rootPath AS rootPath,
            r.configJson AS configJson,
            r.createdAt AS createdAt
     ORDER BY r.repoId
     LIMIT $limit`,
    { limit: maxFetch },
  );
  return rows;
}

export async function deleteRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await withTransaction(conn, async (txConn) => {
    const fileRows = await queryAll<{ fileId: string }>(
      txConn,
      `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
       RETURN f.fileId AS fileId`,
      { repoId },
    );

    const fileIds = fileRows.map((r) => r.fileId);
    await deleteFilesByIds(txConn, fileIds);

    // Collect versionIds before deleting Version nodes so we can clean up SymbolVersions
    const versionRows = await queryAll<{ versionId: string }>(
      txConn,
      `MATCH (v:Version)-[:VERSION_OF_REPO]->(r:Repo {repoId: $repoId})
       RETURN v.versionId AS versionId`,
      { repoId },
    );
    // Clean up Version nodes and their edges
    await exec(txConn, `MATCH (v:Version)-[e:VERSION_OF_REPO]->(r:Repo {repoId: $repoId}) DELETE e, v`, { repoId });

    // Clean up orphaned SymbolVersion nodes for the deleted versions
    const versionIds = versionRows.map((r) => r.versionId);
    if (versionIds.length > 0) {
      await exec(txConn, `MATCH (sv:SymbolVersion) WHERE sv.versionId IN $versionIds DELETE sv`, { versionIds });
    }

    // Clean up Cluster nodes (delete all edge types before nodes)
    await exec(txConn, `MATCH (c:Cluster {repoId: $repoId})<-[e:BELONGS_TO_CLUSTER]-() DELETE e`, { repoId });
    await exec(txConn, `MATCH (c:Cluster {repoId: $repoId})-[e:CLUSTER_IN_REPO]->() DELETE e`, { repoId });
    await exec(txConn, `MATCH (c:Cluster {repoId: $repoId}) DELETE c`, { repoId });

    // Clean up Process nodes (delete all edge types before nodes)
    await exec(txConn, `MATCH (p:Process {repoId: $repoId})<-[e:PARTICIPATES_IN]-() DELETE e`, { repoId });
    await exec(txConn, `MATCH (p:Process {repoId: $repoId})-[e:PROCESS_IN_REPO]->() DELETE e`, { repoId });
    await exec(txConn, `MATCH (p:Process {repoId: $repoId}) DELETE p`, { repoId });

    // Clean up SliceHandle nodes
    await exec(txConn, `MATCH (h:SliceHandle {repoId: $repoId}) DELETE h`, { repoId });

    // Clean up Memory nodes and their edges
    await exec(txConn, `MATCH (r:Repo {repoId: $repoId})-[e:HAS_MEMORY]->(m:Memory) DELETE e`, { repoId });
    await exec(txConn, `MATCH (m:Memory)-[e:MEMORY_OF]->() WHERE m.repoId = $repoId DELETE e`, { repoId });
    await exec(txConn, `MATCH (m:Memory)-[e:MEMORY_OF_FILE]->() WHERE m.repoId = $repoId DELETE e`, { repoId });
    await exec(txConn, `MATCH (m:Memory {repoId: $repoId}) DELETE m`, { repoId });

    // Clean up AgentFeedback nodes
    await exec(txConn, `MATCH (a:AgentFeedback {repoId: $repoId}) DELETE a`, { repoId });

    // Clean up SyncArtifact nodes
    await exec(txConn, `MATCH (s:SyncArtifact {repoId: $repoId}) DELETE s`, { repoId });

    // Clean up FileSummary nodes and edges
    await exec(
      txConn,
      `MATCH (src)-[e]->(fs:FileSummary) WHERE fs.repoId = $repoId DELETE e`,
      { repoId },
    );
    await exec(
      txConn,
      `MATCH (fs:FileSummary)-[e]->(dst) WHERE fs.repoId = $repoId DELETE e`,
      { repoId },
    );
    await exec(txConn, `MATCH (fs:FileSummary) WHERE fs.repoId = $repoId DELETE fs`, { repoId });

    // Clean up UsageSnapshot nodes
    await exec(txConn, `MATCH (u:UsageSnapshot) WHERE u.repoId = $repoId DELETE u`, { repoId });

    await exec(
      txConn,
      `MATCH (r:Repo {repoId: $repoId})
       DELETE r`,
      { repoId },
    );
  });
}

export async function upsertFile(
  conn: Connection,
  file: Omit<FileRow, "directory">,
): Promise<void> {
  const relPath = normalizePath(file.relPath);
  const directory = computeDirectory(relPath);

  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (f:File {fileId: $fileId})
     SET f.relPath = $relPath,
         f.contentHash = $contentHash,
         f.language = $language,
         f.byteSize = $byteSize,
         f.lastIndexedAt = $lastIndexedAt,
         f.directory = $directory
     MERGE (f)-[:FILE_IN_REPO]->(r)`,
    {
      fileId: file.fileId,
      repoId: file.repoId,
      relPath,
      contentHash: file.contentHash,
      language: file.language,
      byteSize: file.byteSize,
      lastIndexedAt: file.lastIndexedAt,
      directory,
    },
  );
}

export async function getFilesByRepo(
  conn: Connection,
  repoId: string,
): Promise<FileRow[]> {
  const rows = await queryAll<Omit<FileRow, "repoId">>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     RETURN f.fileId AS fileId,
            f.relPath AS relPath,
            f.contentHash AS contentHash,
            f.language AS language,
            f.byteSize AS byteSize,
            f.lastIndexedAt AS lastIndexedAt,
            f.directory AS directory`,
    { repoId },
  );

  return rows.map((row) => ({
    ...row,
    repoId,
    byteSize: toNumber(row.byteSize),
    lastIndexedAt: row.lastIndexedAt ?? null,
  }));
}

export async function getFileByRepoPath(
  conn: Connection,
  repoId: string,
  relPath: string,
): Promise<FileRow | null> {
  const normalizedRelPath = normalizePath(relPath);
  const row = await querySingle<Omit<FileRow, "repoId">>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File {relPath: $relPath})
     RETURN f.fileId AS fileId,
            f.relPath AS relPath,
            f.contentHash AS contentHash,
            f.language AS language,
            f.byteSize AS byteSize,
            f.lastIndexedAt AS lastIndexedAt,
            f.directory AS directory`,
    { repoId, relPath: normalizedRelPath },
  );

  if (!row) return null;

  return {
    ...row,
    repoId,
    byteSize: toNumber(row.byteSize),
    lastIndexedAt: row.lastIndexedAt ?? null,
  };
}

export async function deleteFilesByIds(
  conn: Connection,
  fileIds: string[],
): Promise<void> {
  if (fileIds.length === 0) return;

  const uniqueFileIds = [...new Set(fileIds)];

  await withTransaction(conn, async (txConn) => {
    await _deleteFilesByIdsInner(txConn, uniqueFileIds);
  });
}

async function _deleteFilesByIdsInner(
  conn: Connection,
  uniqueFileIds: string[],
): Promise<void> {
  // Step 1: Collect all symbolIds for all fileIds in one query
  const symbolRows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)
     WHERE f.fileId IN $fileIds
     RETURN s.symbolId AS symbolId`,
    { fileIds: uniqueFileIds },
  );
  const symbolIds = symbolRows.map((r) => r.symbolId);

  if (symbolIds.length > 0) {
    // Step 2: Batch-delete DEPENDS_ON edges (both directions)
    await exec(
      conn,
      `MATCH (s:Symbol)-[d:DEPENDS_ON]->(:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );
    await exec(
      conn,
      `MATCH (:Symbol)-[d:DEPENDS_ON]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE d`,
      { symbolIds },
    );

    // Step 3: Batch-delete cluster/process relationships
    await exec(
      conn,
      `MATCH (s:Symbol)-[r:BELONGS_TO_CLUSTER]->(:Cluster)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );
    await exec(
      conn,
      `MATCH (s:Symbol)-[r:PARTICIPATES_IN]->(:Process)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // Step 4: Batch-delete SYMBOL_IN_REPO and SYMBOL_IN_FILE rels
    await exec(
      conn,
      `MATCH (s:Symbol)-[r:SYMBOL_IN_REPO]->(:Repo)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );
    await exec(
      conn,
      `MATCH (s:Symbol)-[r:SYMBOL_IN_FILE]->(:File)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // Step 5: Batch-delete Metrics nodes
    await exec(
      conn,
      `MATCH (m:Metrics)
       WHERE m.symbolId IN $symbolIds
       DELETE m`,
      { symbolIds },
    );

    // Step 5b: Batch-delete SymbolEmbedding nodes
    await exec(
      conn,
      `MATCH (e:SymbolEmbedding)
       WHERE e.symbolId IN $symbolIds
       DELETE e`,
      { symbolIds },
    );

    // Step 5c: Batch-delete SummaryCache nodes
    await exec(
      conn,
      `MATCH (sc:SummaryCache)
       WHERE sc.symbolId IN $symbolIds
       DELETE sc`,
      { symbolIds },
    );

    // Step 5d: Batch-delete MEMORY_OF edges (Memory -> deleted Symbol)
    await exec(
      conn,
      `MATCH (mem:Memory)-[r:MEMORY_OF]->(s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE r`,
      { symbolIds },
    );

    // Step 6: Batch-delete Symbol nodes
    await exec(
      conn,
      `MATCH (s:Symbol)
       WHERE s.symbolId IN $symbolIds
       DELETE s`,
      { symbolIds },
    );
  }

  // Step 6b: Batch-delete SymbolReference nodes for these files
  await exec(
    conn,
    `MATCH (sr:SymbolReference)
     WHERE sr.fileId IN $fileIds
     DELETE sr`,
    { fileIds: uniqueFileIds },
  );

  // Step 6c: Batch-delete MEMORY_OF_FILE edges (Memory -> deleted File)
  await exec(
    conn,
    `MATCH (mem:Memory)-[r:MEMORY_OF_FILE]->(f:File)
     WHERE f.fileId IN $fileIds
     DELETE r`,
    { fileIds: uniqueFileIds },
  );

  // Step 7a: Clean up FileSummary relationships and nodes for deleted files
  await exec(
    conn,
    `MATCH (fs:FileSummary)-[r:SUMMARY_OF_FILE]->(f:File)
     WHERE f.fileId IN $fileIds
     DELETE r`,
    { fileIds: uniqueFileIds },
  );
  await exec(
    conn,
    `MATCH (fs:FileSummary)-[r:FILE_SUMMARY_IN_REPO]->(:Repo)
     WHERE fs.fileId IN $fileIds
     DELETE r`,
    { fileIds: uniqueFileIds },
  );
  await exec(
    conn,
    `MATCH (fs:FileSummary)
     WHERE fs.fileId IN $fileIds
     DELETE fs`,
    { fileIds: uniqueFileIds },
  );

  // Step 7b: Batch-delete FILE_IN_REPO rels and File nodes
  await exec(
    conn,
    `MATCH (f:File)-[r:FILE_IN_REPO]->(:Repo)
     WHERE f.fileId IN $fileIds
     DELETE r`,
    { fileIds: uniqueFileIds },
  );
  await exec(
    conn,
    `MATCH (f:File)
     WHERE f.fileId IN $fileIds
     DELETE f`,
    { fileIds: uniqueFileIds },
  );
}

export async function getFilesByDirectory(
  conn: Connection,
  repoId: string,
  directory: string,
): Promise<FileRow[]> {
  const normalizedDirectory = normalizePath(directory);

  const rows = await queryAll<Omit<FileRow, "repoId">>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     WHERE f.directory = $directory
     RETURN f.fileId AS fileId,
            f.relPath AS relPath,
            f.contentHash AS contentHash,
            f.language AS language,
            f.byteSize AS byteSize,
            f.lastIndexedAt AS lastIndexedAt,
            f.directory AS directory`,
    { repoId, directory: normalizedDirectory },
  );

  return rows.map((row) => ({
    ...row,
    repoId,
    byteSize: toNumber(row.byteSize),
    lastIndexedAt: row.lastIndexedAt ?? null,
  }));
}

export async function getFileCount(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     RETURN count(f) AS count`,
    { repoId },
  );
  return row ? toNumber(row.count) : 0;
}

export async function getLastIndexedAt(
  conn: Connection,
  repoId: string,
): Promise<string | null> {
  const row = await querySingle<{ lastIndexedAt: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     WHERE f.lastIndexedAt IS NOT NULL
     RETURN f.lastIndexedAt AS lastIndexedAt
     ORDER BY f.lastIndexedAt DESC LIMIT 1`,
    { repoId },
  );
  return row ? (row.lastIndexedAt as string) ?? null : null;
}

export async function getFilesByIds(
  conn: Connection,
  fileIds: string[],
): Promise<Map<string, FileRow>> {
  const result = new Map<string, FileRow>();
  if (fileIds.length === 0) return result;

  const rows = await queryAll<{
    fileId: string;
    repoId: string;
    relPath: string;
    contentHash: string;
    language: string;
    byteSize: unknown;
    lastIndexedAt: string | null;
    directory: string;
  }>(
    conn,
    `MATCH (f:File)
     WHERE f.fileId IN $fileIds
     MATCH (f)-[:FILE_IN_REPO]->(r:Repo)
     RETURN f.fileId AS fileId,
            r.repoId AS repoId,
            f.relPath AS relPath,
            f.contentHash AS contentHash,
            f.language AS language,
            f.byteSize AS byteSize,
            f.lastIndexedAt AS lastIndexedAt,
            f.directory AS directory`,
    { fileIds },
  );

  for (const row of rows) {
    result.set(row.fileId, {
      fileId: row.fileId,
      repoId: row.repoId,
      relPath: row.relPath,
      contentHash: row.contentHash,
      language: row.language,
      byteSize: toNumber(row.byteSize),
      lastIndexedAt: row.lastIndexedAt ?? null,
      directory: row.directory,
    });
  }

  return result;
}

export interface FileLiteRow {
  fileId: string;
  relPath: string;
}

export async function getFilesByRepoLite(
  conn: Connection,
  repoId: string,
): Promise<FileLiteRow[]> {
  const rows = await queryAll<FileLiteRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     RETURN f.fileId AS fileId,
            f.relPath AS relPath`,
    { repoId },
  );

  return rows;
}
