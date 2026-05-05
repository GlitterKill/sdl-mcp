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
import {
  exec,
  queryAll,
  querySingle,
  withTransaction,
} from "./ladybug-core.js";
import { logger } from "../util/logger.js";
import {
  getCardHashPropertyName,
  getEmbeddingPropertyName,
  getUpdatedAtPropertyName,
  getVecPropertyName,
} from "../retrieval/model-mapping.js";

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

export interface FileSummarySymbolFact {
  name: string;
  kind: string;
  exported: boolean;
  signatureJson: string | null;
  summary: string | null;
}

export interface FileSummaryEmbeddingBatchItem {
  fileId: string;
  vector: string;
  cardHash: string;
  vectorArray?: number[];
}

export interface SetFileSummaryEmbeddingBatchOpts {
  hnswIndexDropped?: boolean;
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
 * Batched upsert of FileSummary rows. Wraps each chunk of `chunkSize` rows in
 * a single transaction to cut per-row overhead. Safe for any connection.
 */
export async function upsertFileSummaryBatch(
  conn: Connection,
  rows: Array<{
    fileId: string;
    repoId: string;
    summary: string | null;
    searchText: string | null;
    updatedAt: string;
  }>,
  chunkSize = 256,
): Promise<void> {
  if (rows.length === 0) return;
  // Dedup by fileId — W3 OPTIONAL-MATCH+CREATE has no within-batch
  // idempotency for FILE_SUMMARY_IN_REPO and SUMMARY_OF_FILE rels.
  const seen = new Set<string>();
  rows = rows.filter((r) => {
    if (seen.has(r.fileId)) return false;
    seen.add(r.fileId);
    return true;
  });
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    try {
      // UNWIND-batched MERGE; side-effect mode (no RETURN) avoids LadybugDB#285.
      const unwindRows = chunk.map((p) => ({
        fileId: p.fileId,
        repoId: p.repoId,
        summary: p.summary ?? null,
        searchText: p.searchText ?? null,
        updatedAt: p.updatedAt,
      }));
      await withTransaction(conn, async (txConn) => {
        // W3 workaround for LadybugDB UNWIND+MERGE-rel runtime bug:
        // (1) MERGE node + SET, (2) idempotent FILE_SUMMARY_IN_REPO,
        // (3) idempotent SUMMARY_OF_FILE.
        await exec(
          txConn,
          `UNWIND $rows AS row
           MATCH (r:Repo {repoId: row.repoId})
           MATCH (f:File {fileId: row.fileId})
           MERGE (fs:FileSummary {fileId: row.fileId})
           SET fs.repoId = row.repoId,
               fs.summary = row.summary,
               fs.searchText = row.searchText,
               fs.updatedAt = row.updatedAt`,
          { rows: unwindRows },
        );
        await exec(
          txConn,
          `UNWIND $rows AS row
           MATCH (r:Repo {repoId: row.repoId})
           MATCH (fs:FileSummary {fileId: row.fileId})
           OPTIONAL MATCH (fs)-[existing:FILE_SUMMARY_IN_REPO]->(r)
           WITH fs, r, existing
           WHERE existing IS NULL
           CREATE (fs)-[:FILE_SUMMARY_IN_REPO]->(r)`,
          { rows: unwindRows },
        );
        await exec(
          txConn,
          `UNWIND $rows AS row
           MATCH (f:File {fileId: row.fileId})
           MATCH (fs:FileSummary {fileId: row.fileId})
           OPTIONAL MATCH (fs)-[existing:SUMMARY_OF_FILE]->(f)
           WITH fs, f, existing
           WHERE existing IS NULL
           CREATE (fs)-[:SUMMARY_OF_FILE]->(f)`,
          { rows: unwindRows },
        );
      });
    } catch (err) {
      // Do not abort the whole materialisation on a single failing batch —
      // log the failing file IDs and continue.
      logger.warn("upsertFileSummaryBatch: chunk failed, continuing", {
        chunkStart: i,
        chunkSize: chunk.length,
        fileIds: chunk.map((r) => r.fileId),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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

export async function getFileSummariesByFileIds(
  conn: Connection,
  fileIds: string[],
): Promise<Map<string, FileSummaryRow>> {
  const result = new Map<string, FileSummaryRow>();
  if (fileIds.length === 0) return result;

  const rows = await queryAll<FileSummaryRow>(
    conn,
    `MATCH (fs:FileSummary)
     WHERE fs.fileId IN $fileIds
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
    { fileIds },
  );

  for (const row of rows) {
    result.set(row.fileId, row);
  }
  return result;
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
    logger.warn(
      `updateFileSummaryEmbedding: unrecognised model "${model}", skipping`,
    );
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

export async function setFileSummaryEmbeddingBatch(
  conn: Connection,
  model: string,
  items: FileSummaryEmbeddingBatchItem[],
  opts: SetFileSummaryEmbeddingBatchOpts = {},
): Promise<void> {
  if (items.length === 0) return;

  const { vectorProp, vecProp, cardHashProp, updatedAtProp } =
    resolveFileSummaryEmbeddingProperties(model);
  const updatedAt = new Date().toISOString();
  const rows = items.map((item) => ({
    fileId: item.fileId,
    vector: item.vector,
    cardHash: item.cardHash,
    vectorArray: item.vectorArray ?? null,
  }));
  const vecRows = vecProp
    ? rows.filter((row) => Array.isArray(row.vectorArray))
    : [];

  await withTransaction(conn, async (txConn) => {
    if (vecProp && opts.hnswIndexDropped && vecRows.length > 0) {
      await exec(
        txConn,
        `UNWIND $rows AS row
         MATCH (fs:FileSummary {fileId: row.fileId})
         SET fs.${vectorProp} = row.vector,
             fs.${cardHashProp} = row.cardHash,
             fs.${updatedAtProp} = $updatedAt,
             fs.${vecProp} = row.vectorArray`,
        { rows, updatedAt },
      );
      return;
    }

    await exec(
      txConn,
      `UNWIND $rows AS row
       MATCH (fs:FileSummary {fileId: row.fileId})
       SET fs.${vectorProp} = row.vector,
           fs.${cardHashProp} = row.cardHash,
           fs.${updatedAtProp} = $updatedAt`,
      { rows, updatedAt },
    );

    if (vecProp && vecRows.length > 0) {
      await exec(
        txConn,
        `UNWIND $rows AS row
         MATCH (fs:FileSummary {fileId: row.fileId})
         SET fs.${vecProp} = null`,
        { rows: vecRows },
      );
      await exec(
        txConn,
        `UNWIND $rows AS row
         MATCH (fs:FileSummary {fileId: row.fileId})
         SET fs.${vecProp} = row.vectorArray`,
        { rows: vecRows },
      );
    }
  });
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

export function buildFileSummaryHybridPayload(params: {
  relPath: string;
  language: string | null;
  symbols: FileSummarySymbolFact[];
}): string {
  const exportedNames = params.symbols
    .filter((symbol) => symbol.exported)
    .map((symbol) => symbol.name)
    .slice(0, 30);
  const lines = [
    `File: ${params.relPath}`,
    `Language: ${params.language ?? "unknown"}`,
    `Exports: ${exportedNames.join(", ")}`,
  ];

  for (const symbol of params.symbols.slice(0, 20)) {
    const signature = parseSignatureText(symbol.signatureJson);
    const parts = [`- ${symbol.kind} ${symbol.name}`];
    if (symbol.exported) parts.push("(exported)");
    if (signature) parts.push(signature);
    if (symbol.summary) parts.push(symbol.summary);
    lines.push(parts.join(" | "));
  }

  return lines.join("\n").trim();
}

function parseSignatureText(signatureJson: string | null): string | null {
  if (!signatureJson) return null;
  try {
    const parsed = JSON.parse(signatureJson) as { text?: string } | string;
    return typeof parsed === "string" ? parsed : (parsed.text ?? signatureJson);
  } catch {
    return signatureJson;
  }
}

function resolveFileSummaryEmbeddingProperties(model: string): {
  vectorProp: string;
  vecProp: string | null;
  cardHashProp: string;
  updatedAtProp: string;
} {
  const vectorProp = getEmbeddingPropertyName(model);
  const vecProp = getVecPropertyName(model);
  const cardHashProp = getCardHashPropertyName(model);
  const updatedAtProp = getUpdatedAtPropertyName(model);
  if (!vectorProp || !cardHashProp || !updatedAtProp) {
    throw new Error(
      `Unknown embedding model "${model}": cannot resolve FileSummary embedding properties`,
    );
  }

  const safeProp = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
  for (const prop of [vectorProp, cardHashProp, updatedAtProp, vecProp].filter(
    (p): p is string => typeof p === "string",
  )) {
    if (!safeProp.test(prop)) {
      throw new Error(`Unsafe FileSummary embedding property: ${prop}`);
    }
  }

  return { vectorProp, vecProp, cardHashProp, updatedAtProp };
}
