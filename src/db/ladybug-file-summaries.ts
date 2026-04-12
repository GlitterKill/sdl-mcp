/**
 * ladybug-file-summaries.ts - FileSummary Operations
 *
 * CRUD operations for FileSummary nodes, which store per-file summaries,
 * search text, and optional embedding vectors for hybrid retrieval.
 *
 * Relationships:
 *   (FileSummary)-[:FILE_SUMMARY_IN_REPO]->(Repo)
 *   (FileSummary)-[:SUMMARY_OF_FILE]->(File)
 */
import type { Connection } from "kuzu";
import { exec, queryAll, querySingle, withTransaction } from "./ladybug-core.js";
import { logger } from "../util/logger.js";
import { getEmbeddingPropertyName } from "../retrieval/model-mapping.js";

export interface FileSummaryRow {
  fileId: string;
  repoId: string;
  summary: string | null;
  searchText: string | null;
  updatedAt: string;
  embeddingJinaCode: string | null;
  embeddingJinaCodeCardHash: string | null;
  embeddingJinaCodeUpdatedAt: string | null;
  embeddingNomic: string | null;
  embeddingNomicCardHash: string | null;
  embeddingNomicUpdatedAt: string | null;
}

/**
 * Upsert a FileSummary node and wire its relationships to Repo and File.
 */
export async function upsertFileSummary(
  conn: Connection,
  params: {
    fileId: string;
    repoId: string;
    summary: string | null;
    searchText: string | null;
    updatedAt: string;
  },
): Promise<void> {
  await exec(
    conn,
    `// Note: Leading MATCH clauses mean this is a silent no-op if Repo or File
    // nodes are missing. This is acceptable because callers (materializeFileSummaries)
    // iterate files that just came from the DB, so missing nodes indicate a race
    // condition that will self-correct on the next index refresh.
    MATCH (r:Repo {repoId: $repoId})
     MATCH (f:File {fileId: $fileId})
     MERGE (fs:FileSummary {fileId: $fileId})
     SET fs.repoId = $repoId,
         fs.summary = $summary,
         fs.searchText = $searchText,
         fs.updatedAt = $updatedAt
     MERGE (fs)-[:FILE_SUMMARY_IN_REPO]->(r)
     MERGE (fs)-[:SUMMARY_OF_FILE]->(f)`,
    {
      fileId: params.fileId,
      repoId: params.repoId,
      summary: params.summary ?? null,
      searchText: params.searchText ?? null,
      updatedAt: params.updatedAt,
    },
  );
}

/**
 * Get a single FileSummary by fileId, or null if not found.
 */
export async function getFileSummary(
  conn: Connection,
  fileId: string,
): Promise<FileSummaryRow | null> {
  const row = await querySingle<FileSummaryRow>(
    conn,
    `MATCH (fs:FileSummary {fileId: $fileId})
     RETURN fs.fileId AS fileId,
            fs.repoId AS repoId,
            fs.summary AS summary,
            fs.searchText AS searchText,
            fs.updatedAt AS updatedAt,
            fs.embeddingJinaCode AS embeddingJinaCode,
            fs.embeddingJinaCodeCardHash AS embeddingJinaCodeCardHash,
            fs.embeddingJinaCodeUpdatedAt AS embeddingJinaCodeUpdatedAt,
            fs.embeddingNomic AS embeddingNomic,
            fs.embeddingNomicCardHash AS embeddingNomicCardHash,
            fs.embeddingNomicUpdatedAt AS embeddingNomicUpdatedAt`,
    { fileId },
  );
  return row ?? null;
}

/**
 * Get all FileSummary nodes for a repository.
 */
export async function getFileSummariesForRepo(
  conn: Connection,
  repoId: string,
): Promise<FileSummaryRow[]> {
  return queryAll<FileSummaryRow>(
    conn,
    `MATCH (fs:FileSummary {repoId: $repoId})
     RETURN fs.fileId AS fileId,
            fs.repoId AS repoId,
            fs.summary AS summary,
            fs.searchText AS searchText,
            fs.updatedAt AS updatedAt,
            fs.embeddingJinaCode AS embeddingJinaCode,
            fs.embeddingJinaCodeCardHash AS embeddingJinaCodeCardHash,
            fs.embeddingJinaCodeUpdatedAt AS embeddingJinaCodeUpdatedAt,
            fs.embeddingNomic AS embeddingNomic,
            fs.embeddingNomicCardHash AS embeddingNomicCardHash,
            fs.embeddingNomicUpdatedAt AS embeddingNomicUpdatedAt`,
    { repoId },
  );
}

/**
 * Update the embedding vector and card hash for a specific model on a FileSummary node.
 *
 * Uses getEmbeddingPropertyName to derive the column prefix (e.g. "embeddingJinaCode")
 * and then sets <prefix>, <prefix>CardHash, and <prefix>UpdatedAt.
 *
 * Returns false if the model is not recognised (no-op), true on success.
 */
export async function updateFileSummaryEmbedding(
  conn: Connection,
  fileId: string,
  model: string,
  embedding: string,
  cardHash: string,
): Promise<boolean> {
  const prefix = getEmbeddingPropertyName(model);
  if (!prefix) {
    logger.warn(`updateFileSummaryEmbedding: unrecognised model "${model}", skipping`);
    return false;
  }

  const now = new Date().toISOString();

  // Build the SET clause dynamically using known safe property names derived
  // from the model registry (no user-controlled string interpolation).
  await exec(
    conn,
    `MATCH (fs:FileSummary {fileId: $fileId})
     SET fs.${prefix} = $embedding,
         fs.${prefix}CardHash = $cardHash,
         fs.${prefix}UpdatedAt = $updatedAt`,
    { fileId, embedding, cardHash, updatedAt: now },
  );
  return true;
}

/**
 * Delete all FileSummary nodes (and their relationships) for a repository.
 * Rels are deleted before nodes as required by LadybugDB.
 */
export async function deleteFileSummariesByRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await withTransaction(conn, async (txConn) => {
    // 1. Delete SUMMARY_OF_FILE rels
    await exec(
      txConn,
      `MATCH (fs:FileSummary {repoId: $repoId})-[rel:SUMMARY_OF_FILE]->(:File)
       DELETE rel`,
      { repoId },
    );

    // 2. Delete FILE_SUMMARY_IN_REPO rels
    await exec(
      txConn,
      `MATCH (fs:FileSummary {repoId: $repoId})-[rel:FILE_SUMMARY_IN_REPO]->(:Repo {repoId: $repoId})
       DELETE rel`,
      { repoId },
    );

    // 3. Delete nodes
    await exec(
      txConn,
      `MATCH (fs:FileSummary {repoId: $repoId})
       DELETE fs`,
      { repoId },
    );
  });
}

/**
 * Build a search-friendly text string for a FileSummary.
 *
 * Format: "file: {relPath} exports: {name1} {name2} ... [summary: {summary}]"
 * At most 30 exported symbol names are included to keep the text compact.
 */
export function buildFileSummarySearchText(
  relPath: string,
  exportedSymbolNames: string[],
  summary?: string | null,
): string {
  const names = exportedSymbolNames.slice(0, 30).join(" ");
  let text = `file: ${relPath} exports: ${names}`;
  if (summary) text += ` summary: ${summary}`;
  return text.trim();
}
