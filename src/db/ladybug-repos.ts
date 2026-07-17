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
import {
  resolveLadybugWriteChunkSize,
  type LadybugWriteChunkOptions,
} from "./ladybug-batching.js";

export interface MetricsRow {
  symbolId: string;
  fanIn: number;
  fanOut: number;
  churn30d: number;
  testRefsJson: string | null;
  canonicalTestJson: string | null;
  /** PageRank centrality score, 0.0 when unavailable. */
  pageRank?: number;
  /** K-core decomposition value, 0 when unavailable. */
  kCore?: number;
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

export interface UpsertFileBatchOptions extends LadybugWriteChunkOptions {}

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
    // Capture owned identifiers before deleting files so file-backed and
    // fileless (for example external SCIP placeholder) symbols share one
    // deterministic cleanup path.
    const fileRows = await queryAll<{ fileId: string }>(
      txConn,
      `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
       RETURN f.fileId AS fileId`,
      { repoId },
    );
    const propertySymbolRows = await queryAll<{ symbolId: string }>(
      txConn,
      `MATCH (s:Symbol {repoId: $repoId}) RETURN s.symbolId AS symbolId`,
      { repoId },
    );
    const relatedSymbolRows = await queryAll<{ symbolId: string }>(
      txConn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(r:Repo {repoId: $repoId})
       RETURN s.symbolId AS symbolId`,
      { repoId },
    );
    const symbolIds = [
      ...new Set(
        [...propertySymbolRows, ...relatedSymbolRows].map((row) => row.symbolId),
      ),
    ];
    const sharedSymbolRows =
      symbolIds.length === 0
        ? []
        : await queryAll<{ symbolId: string; repoId: string }>(
            txConn,
            `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(other:Repo)
             WHERE s.symbolId IN $symbolIds AND other.repoId <> $repoId
             RETURN s.symbolId AS symbolId, other.repoId AS repoId
             ORDER BY s.symbolId, other.repoId`,
            { symbolIds, repoId },
          );
    const replacementOwnerBySymbol = new Map<string, string>();
    for (const row of sharedSymbolRows) {
      if (!replacementOwnerBySymbol.has(row.symbolId)) {
        replacementOwnerBySymbol.set(row.symbolId, row.repoId);
      }
    }
    const sharedSymbolIds = new Set(replacementOwnerBySymbol.keys());
    const deletedSymbolIds = symbolIds.filter(
      (symbolId) => !sharedSymbolIds.has(symbolId),
    );

    const fileIds = fileRows.map((r) => r.fileId);
    await deleteFilesByIds(txConn, fileIds);

    // Collect versionIds before deleting Version nodes so SymbolVersion rows
    // can be removed by either owned version or owned symbol.
    const versionRows = await queryAll<{ versionId: string }>(
      txConn,
      `MATCH (v:Version)-[:VERSION_OF_REPO]->(r:Repo {repoId: $repoId})
       RETURN v.versionId AS versionId`,
      { repoId },
    );
    const versionIds = versionRows.map((r) => r.versionId);
    if (versionIds.length > 0) {
      await exec(
        txConn,
        `MATCH (sv:SymbolVersion) WHERE sv.versionId IN $versionIds DELETE sv`,
        { versionIds },
      );
    }
    if (deletedSymbolIds.length > 0) {
      await exec(
        txConn,
        `MATCH (sv:SymbolVersion) WHERE sv.symbolId IN $deletedSymbolIds DELETE sv`,
        { deletedSymbolIds },
      );
      await exec(
        txConn,
        `MATCH (m:Metrics) WHERE m.symbolId IN $deletedSymbolIds DELETE m`,
        { deletedSymbolIds },
      );
      await exec(
        txConn,
        `MATCH (e:SymbolEmbedding) WHERE e.symbolId IN $deletedSymbolIds DELETE e`,
        { deletedSymbolIds },
      );
      await exec(
        txConn,
        `MATCH (s:SummaryCache) WHERE s.symbolId IN $deletedSymbolIds DELETE s`,
        { deletedSymbolIds },
      );
      for (const statement of [
        `MATCH (s:Symbol)-[e:DEPENDS_ON]->(:Symbol)
         WHERE s.symbolId IN $deletedSymbolIds DELETE e`,
        `MATCH (:Symbol)-[e:DEPENDS_ON]->(s:Symbol)
         WHERE s.symbolId IN $deletedSymbolIds DELETE e`,
        `MATCH (s:Symbol)-[e:SYMBOL_IN_FILE]->(:File)
         WHERE s.symbolId IN $deletedSymbolIds DELETE e`,
        `MATCH (s:Symbol)-[e:SYMBOL_IN_REPO]->(:Repo)
         WHERE s.symbolId IN $deletedSymbolIds DELETE e`,
        `MATCH (s:Symbol)-[e:BELONGS_TO_CLUSTER]->(:Cluster)
         WHERE s.symbolId IN $deletedSymbolIds DELETE e`,
        `MATCH (s:Symbol)-[e:BELONGS_TO_SHADOW_CLUSTER]->(:ShadowCluster)
         WHERE s.symbolId IN $deletedSymbolIds DELETE e`,
        `MATCH (s:Symbol)-[e:PARTICIPATES_IN]->(:Process)
         WHERE s.symbolId IN $deletedSymbolIds DELETE e`,
        `MATCH (:Memory)-[e:MEMORY_OF]->(s:Symbol)
         WHERE s.symbolId IN $deletedSymbolIds DELETE e`,
      ]) {
        await exec(txConn, statement, { deletedSymbolIds });
      }
      await exec(
        txConn,
        `MATCH (s:Symbol) WHERE s.symbolId IN $deletedSymbolIds DELETE s`,
        { deletedSymbolIds },
      );
    }
    if (replacementOwnerBySymbol.size > 0) {
      const replacements = Array.from(replacementOwnerBySymbol, ([symbolId, ownerRepoId]) => ({
        symbolId,
        ownerRepoId,
      }));
      await exec(
        txConn,
        `UNWIND $replacements AS replacement
         MATCH (s:Symbol {symbolId: replacement.symbolId})-[e:SYMBOL_IN_REPO]->(r:Repo {repoId: $repoId})
         DELETE e
         SET s.repoId = replacement.ownerRepoId`,
        { replacements, repoId },
      );
    }

    await exec(
      txConn,
      `MATCH (v:Version)-[e:VERSION_OF_REPO]->(r:Repo {repoId: $repoId})
       DELETE e, v`,
      { repoId },
    );

    await exec(
      txConn,
      `MATCH (c:Cluster {repoId: $repoId})<-[e:BELONGS_TO_CLUSTER]-() DELETE e`,
      { repoId },
    );
    await exec(
      txConn,
      `MATCH (c:Cluster {repoId: $repoId})-[e:CLUSTER_IN_REPO]->() DELETE e`,
      { repoId },
    );
    await exec(txConn, `MATCH (c:Cluster {repoId: $repoId}) DELETE c`, {
      repoId,
    });

    await exec(
      txConn,
      `MATCH (c:ShadowCluster {repoId: $repoId})<-[e:BELONGS_TO_SHADOW_CLUSTER]-()
       DELETE e`,
      { repoId },
    );
    await exec(
      txConn,
      `MATCH (c:ShadowCluster {repoId: $repoId})-[e:SHADOW_CLUSTER_IN_REPO]->()
       DELETE e`,
      { repoId },
    );
    await exec(
      txConn,
      `MATCH (c:ShadowCluster {repoId: $repoId}) DELETE c`,
      { repoId },
    );

    await exec(
      txConn,
      `MATCH (p:Process {repoId: $repoId})<-[e:PARTICIPATES_IN]-() DELETE e`,
      { repoId },
    );
    await exec(
      txConn,
      `MATCH (p:Process {repoId: $repoId})-[e:PROCESS_IN_REPO]->() DELETE e`,
      { repoId },
    );
    await exec(txConn, `MATCH (p:Process {repoId: $repoId}) DELETE p`, {
      repoId,
    });

    await exec(
      txConn,
      `MATCH (r:Repo {repoId: $repoId})-[e:HAS_MEMORY]->(m:Memory) DELETE e`,
      { repoId },
    );
    await exec(
      txConn,
      `MATCH (m:Memory)-[e:MEMORY_OF]->() WHERE m.repoId = $repoId DELETE e`,
      { repoId },
    );
    await exec(
      txConn,
      `MATCH (m:Memory)-[e:MEMORY_OF_FILE]->() WHERE m.repoId = $repoId DELETE e`,
      { repoId },
    );
    await exec(txConn, `MATCH (m:Memory {repoId: $repoId}) DELETE m`, {
      repoId,
    });

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
    await exec(
      txConn,
      `MATCH (fs:FileSummary) WHERE fs.repoId = $repoId DELETE fs`,
      { repoId },
    );

    // Every remaining current-schema repository-owned node has a repoId
    // property and no relationships. Global content-addressed nodes
    // (CardHash, ToolPolicyHash, TsconfigHash) and SchemaVersion are omitted.
    for (const table of [
      "MetricsFingerprint",
      "SliceHandle",
      "Audit",
      "AgentFeedback",
      "SyncArtifact",
      "SymbolReference",
      "UsageSnapshot",
      "PrefetchOutcome",
      "PrefetchPolicyAggregate",
      "ScipIngestion",
      "SemanticProviderRun",
      "SemanticDiagnostic",
      "SemanticPrecisionMetric",
      "DerivedState",
    ]) {
      await exec(
        txConn,
        `MATCH (n:${table}) WHERE n.repoId = $repoId DELETE n`,
        { repoId },
      );
    }

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

/**
 * UNWIND-batched upsert for File nodes + FILE_IN_REPO edge.
 *
 * Pass-1 batched-write site (`src/indexer/parser/batch-persist.ts`) was the
 * sole missed callsite from the 2026-05-02 UNWIND sweep — its name didn't
 * match the `*Batch` audit pattern. Per-row `upsertFile` inside the flush
 * transaction made the pass-1 tail drain dominate when ~200 files queued
 * at once, surfacing as a 60s+ silent pause at "Pass 1: 99% (N/M)" that
 * looked indistinguishable from a hang.
 *
 * Three-pass W3 workaround (matches upsertSymbolBatch):
 *   (1) UNWIND + MERGE node + SET props
 *   (2) UNWIND + OPTIONAL MATCH + CREATE FILE_IN_REPO
 *
 * `lastIndexedAt` is asserted non-null by all production callers (see
 * src/indexer/parser/{rust-process-file,process-file,helpers}.ts — every
 * `addFile` / direct upsert site sets `new Date().toISOString()`). The
 * coercion below is a defence-in-depth against future callers that
 * introduce uniformly-null fields and trip the LadybugDB UNWIND binder
 * type-inference bug (kuzu#5685).
 */
export async function upsertFileBatch(
  conn: Connection,
  files: Array<Omit<FileRow, "directory">>,
  options?: UpsertFileBatchOptions,
): Promise<void> {
  if (files.length === 0) return;

  const seen = new Set<string>();
  const dedup = files.filter((f) => {
    if (seen.has(f.fileId)) return false;
    seen.add(f.fileId);
    return true;
  });

  const chunkSize = resolveLadybugWriteChunkSize("files", options?.chunkSize);
  await withTransaction(conn, async (txConn) => {
    for (let i = 0; i < dedup.length; i += chunkSize) {
      const chunk = dedup.slice(i, i + chunkSize);
      const rows = chunk.map((file) => {
        const relPath = normalizePath(file.relPath);
        return {
          fileId: file.fileId,
          repoId: file.repoId,
          relPath,
          contentHash: file.contentHash,
          language: file.language,
          byteSize: file.byteSize,
          lastIndexedAt: file.lastIndexedAt ?? "",
          directory: computeDirectory(relPath),
        };
      });

      await exec(
        txConn,
        `UNWIND $rows AS row
         MATCH (r:Repo {repoId: row.repoId})
         MERGE (f:File {fileId: row.fileId})
         SET f.relPath = row.relPath,
             f.contentHash = row.contentHash,
             f.language = row.language,
             f.byteSize = row.byteSize,
             f.lastIndexedAt = row.lastIndexedAt,
             f.directory = row.directory`,
        { rows },
      );
      await exec(
        txConn,
        `UNWIND $rows AS row
         MATCH (f:File {fileId: row.fileId})
         MATCH (r:Repo {repoId: row.repoId})
         OPTIONAL MATCH (f)-[existing:FILE_IN_REPO]->(r)
         WITH f, r, existing
         WHERE existing IS NULL
         CREATE (f)-[:FILE_IN_REPO]->(r)`,
        { rows },
      );
    }
  });
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

/**
 * Find files under a directory prefix (e.g. "src/code/").
 * Returns up to `limit` files ordered by relPath, then fileId.
 */
export async function getFilesByPrefix(
  conn: Connection,
  repoId: string,
  prefix: string,
  limit: number = 50,
): Promise<FileRow[]> {
  const normalizedPrefix = prefix === "" ? "" : normalizePath(prefix);
  const safeLimitVal = Math.max(1, Math.min(limit, 200));
  const rows = await queryAll<Omit<FileRow, "repoId">>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     WHERE f.relPath STARTS WITH $prefix
     RETURN f.fileId AS fileId,
            f.relPath AS relPath,
            f.contentHash AS contentHash,
            f.language AS language,
            f.byteSize AS byteSize,
            f.lastIndexedAt AS lastIndexedAt,
            f.directory AS directory
     ORDER BY f.relPath ASC, f.fileId ASC
     LIMIT $lim`,
    { repoId, prefix: normalizedPrefix, lim: safeLimitVal },
  );

  return rows.map((row) => ({
    ...row,
    repoId,
    byteSize: toNumber(row.byteSize),
    lastIndexedAt: row.lastIndexedAt ?? null,
  }));
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
      `MATCH (s:Symbol)-[r:BELONGS_TO_SHADOW_CLUSTER]->(:ShadowCluster)
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
  return row ? ((row.lastIndexedAt as string) ?? null) : null;
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
  contentHash: string;
}

export async function getFileIdsByRepoPaths(
  conn: Connection,
  repoId: string,
  relPaths: readonly string[],
): Promise<Map<string, string>> {
  if (relPaths.length === 0) return new Map();
  const normalizedPaths = [...new Set(relPaths.map(normalizePath))];
  const rows = await queryAll<{ relPath: string; fileId: string }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     WHERE f.relPath IN $relPaths
     RETURN f.relPath AS relPath, f.fileId AS fileId`,
    { repoId, relPaths: normalizedPaths },
  );
  return new Map(rows.map((row) => [normalizePath(row.relPath), row.fileId]));
}

export async function getFilesByRepoLite(
  conn: Connection,
  repoId: string,
): Promise<FileLiteRow[]> {
  const rows = await queryAll<FileLiteRow>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
     RETURN f.fileId AS fileId,
            f.relPath AS relPath,
            f.contentHash AS contentHash`,
    { repoId },
  );

  return rows;
}
