/**
 * kuzu-embeddings.ts — Symbol Embeddings, Summary Cache, Sync Artifacts, and Symbol References
 * Extracted from kuzu-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import { exec, queryAll, querySingle, toNumber, withTransaction, assertSafeInt } from "./kuzu-core.js";

export interface SymbolEmbeddingRow {
  symbolId: string;
  model: string;
  embeddingVector: string;
  version: string;
  cardHash: string;
  createdAt: string;
  updatedAt: string;
}

export async function upsertSymbolEmbedding(
  conn: Connection,
  row: SymbolEmbeddingRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (e:SymbolEmbedding {symbolId: $symbolId})
     SET e.model = $model,
         e.embeddingVector = $embeddingVector,
         e.version = $version,
         e.cardHash = $cardHash,
         e.createdAt = $createdAt,
         e.updatedAt = $updatedAt`,
    {
      symbolId: row.symbolId,
      model: row.model,
      embeddingVector: row.embeddingVector,
      version: row.version,
      cardHash: row.cardHash,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  );
}

export async function getSymbolEmbedding(
  conn: Connection,
  symbolId: string,
): Promise<SymbolEmbeddingRow | null> {
  const row = await querySingle<SymbolEmbeddingRow>(
    conn,
    `MATCH (e:SymbolEmbedding {symbolId: $symbolId})
     RETURN e.symbolId AS symbolId,
            e.model AS model,
            e.embeddingVector AS embeddingVector,
            e.version AS version,
            e.cardHash AS cardHash,
            e.createdAt AS createdAt,
            e.updatedAt AS updatedAt`,
    { symbolId },
  );
  return row ?? null;
}

export async function getSymbolEmbeddings(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, SymbolEmbeddingRow>> {
  const result = new Map<string, SymbolEmbeddingRow>();
  if (symbolIds.length === 0) return result;

  const rows = await queryAll<SymbolEmbeddingRow>(
    conn,
    `MATCH (e:SymbolEmbedding)
     WHERE e.symbolId IN $symbolIds
     RETURN e.symbolId AS symbolId,
            e.model AS model,
            e.embeddingVector AS embeddingVector,
            e.version AS version,
            e.cardHash AS cardHash,
            e.createdAt AS createdAt,
            e.updatedAt AS updatedAt`,
    { symbolIds },
  );

  for (const row of rows) {
    result.set(row.symbolId, row);
  }

  return result;
}

export async function deleteSymbolEmbeddings(
  conn: Connection,
  symbolIds: string[],
): Promise<void> {
  if (symbolIds.length === 0) return;
  await exec(
    conn,
    `MATCH (e:SymbolEmbedding)
     WHERE e.symbolId IN $symbolIds
     DELETE e`,
    { symbolIds },
  );
}

export interface SummaryCacheRow {
  symbolId: string;
  summary: string;
  provider: string;
  model: string;
  cardHash: string;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

export async function getSummaryCache(
  conn: Connection,
  symbolId: string,
): Promise<SummaryCacheRow | null> {
  const row = await querySingle<{
    symbolId: string;
    summary: string;
    provider: string;
    model: string;
    cardHash: string;
    costUsd: unknown;
    createdAt: string;
    updatedAt: string;
  }>(
    conn,
    `MATCH (c:SummaryCache {symbolId: $symbolId})
     RETURN c.symbolId AS symbolId,
            c.summary AS summary,
            c.provider AS provider,
            c.model AS model,
            c.cardHash AS cardHash,
            c.costUsd AS costUsd,
            c.createdAt AS createdAt,
            c.updatedAt AS updatedAt`,
    { symbolId },
  );

  if (!row) return null;

  return {
    symbolId: row.symbolId,
    summary: row.summary,
    provider: row.provider,
    model: row.model,
    cardHash: row.cardHash,
    costUsd: toNumber(row.costUsd),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertSummaryCache(
  conn: Connection,
  row: SummaryCacheRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (c:SummaryCache {symbolId: $symbolId})
     SET c.summary = $summary,
         c.provider = $provider,
         c.model = $model,
         c.cardHash = $cardHash,
         c.costUsd = $costUsd,
         c.createdAt = $createdAt,
         c.updatedAt = $updatedAt`,
    {
      symbolId: row.symbolId,
      summary: row.summary,
      provider: row.provider,
      model: row.model,
      cardHash: row.cardHash,
      costUsd: row.costUsd,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  );
}

export async function deleteSummaryCacheByRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     MATCH (c:SummaryCache {symbolId: s.symbolId})
     DELETE c`,
    { repoId },
  );
}

export interface SyncArtifactRow {
  artifactId: string;
  repoId: string;
  versionId: string;
  commitSha: string | null;
  branch: string | null;
  artifactHash: string;
  compressedData: string;
  createdAt: string;
  sizeBytes: number;
}

export async function upsertSyncArtifact(
  conn: Connection,
  row: SyncArtifactRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (a:SyncArtifact {artifactId: $artifactId})
     SET a.repoId = $repoId,
         a.versionId = $versionId,
         a.commitSha = $commitSha,
         a.branch = $branch,
         a.artifactHash = $artifactHash,
         a.compressedData = $compressedData,
         a.createdAt = $createdAt,
         a.sizeBytes = $sizeBytes`,
    {
      artifactId: row.artifactId,
      repoId: row.repoId,
      versionId: row.versionId,
      commitSha: row.commitSha,
      branch: row.branch,
      artifactHash: row.artifactHash,
      compressedData: row.compressedData,
      createdAt: row.createdAt,
      sizeBytes: row.sizeBytes,
    },
  );
}

export async function getSyncArtifact(
  conn: Connection,
  artifactId: string,
): Promise<SyncArtifactRow | null> {
  const row = await querySingle<{
    artifactId: string;
    repoId: string;
    versionId: string;
    commitSha: string | null;
    branch: string | null;
    artifactHash: string;
    compressedData: string;
    createdAt: string;
    sizeBytes: unknown;
  }>(
    conn,
    `MATCH (a:SyncArtifact {artifactId: $artifactId})
     RETURN a.artifactId AS artifactId,
            a.repoId AS repoId,
            a.versionId AS versionId,
            a.commitSha AS commitSha,
            a.branch AS branch,
            a.artifactHash AS artifactHash,
            a.compressedData AS compressedData,
            a.createdAt AS createdAt,
            a.sizeBytes AS sizeBytes`,
    { artifactId },
  );

  if (!row) return null;

  return {
    artifactId: row.artifactId,
    repoId: row.repoId,
    versionId: row.versionId,
    commitSha: row.commitSha,
    branch: row.branch,
    artifactHash: row.artifactHash,
    compressedData: row.compressedData,
    createdAt: row.createdAt,
    sizeBytes: toNumber(row.sizeBytes),
  };
}

export async function getSyncArtifactsByRepo(
  conn: Connection,
  repoId: string,
  limit: number,
): Promise<SyncArtifactRow[]> {
  assertSafeInt(limit, "limit");
  const rows = await queryAll<{
    artifactId: string;
    repoId: string;
    versionId: string;
    commitSha: string | null;
    branch: string | null;
    artifactHash: string;
    compressedData: string;
    createdAt: string;
    sizeBytes: unknown;
  }>(
    conn,
    `MATCH (a:SyncArtifact {repoId: $repoId})
     RETURN a.artifactId AS artifactId,
            a.repoId AS repoId,
            a.versionId AS versionId,
            a.commitSha AS commitSha,
            a.branch AS branch,
            a.artifactHash AS artifactHash,
            a.compressedData AS compressedData,
            a.createdAt AS createdAt,
            a.sizeBytes AS sizeBytes
     ORDER BY a.createdAt DESC`,
    { repoId },
  );

  return rows.slice(0, limit).map((row) => ({
    artifactId: row.artifactId,
    repoId: row.repoId,
    versionId: row.versionId,
    commitSha: row.commitSha,
    branch: row.branch,
    artifactHash: row.artifactHash,
    compressedData: row.compressedData,
    createdAt: row.createdAt,
    sizeBytes: toNumber(row.sizeBytes),
  }));
}

export interface SymbolReferenceRow {
  refId: string;
  repoId: string;
  symbolName: string;
  fileId: string;
  lineNumber: number | null;
  createdAt: string;
}

export async function insertSymbolReference(
  conn: Connection,
  row: SymbolReferenceRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (sr:SymbolReference {refId: $refId})
     SET sr.repoId = $repoId,
         sr.symbolName = $symbolName,
         sr.fileId = $fileId,
         sr.lineNumber = $lineNumber,
         sr.createdAt = $createdAt`,
    {
      refId: row.refId,
      repoId: row.repoId,
      symbolName: row.symbolName,
      fileId: row.fileId,
      lineNumber: row.lineNumber,
      createdAt: row.createdAt,
    },
  );
}

export async function insertSymbolReferences(
  conn: Connection,
  rows: SymbolReferenceRow[],
): Promise<void> {
  if (rows.length === 0) return;

  await withTransaction(conn, async (txConn) => {
    for (const row of rows) {
      await insertSymbolReference(txConn, row);
    }
  });
}

export async function getTestRefsForSymbol(
  conn: Connection,
  repoId: string,
  symbolName: string,
): Promise<string[]> {
  const rows = await queryAll<{ relPath: string }>(
    conn,
    `MATCH (sr:SymbolReference {repoId: $repoId, symbolName: $symbolName})
     MATCH (f:File {fileId: sr.fileId})
     RETURN DISTINCT f.relPath AS relPath`,
    { repoId, symbolName },
  );
  return rows.map((row) => row.relPath);
}

export async function deleteSymbolReferencesByFileId(
  conn: Connection,
  fileId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (sr:SymbolReference {fileId: $fileId})
     DELETE sr`,
    { fileId },
  );
}

