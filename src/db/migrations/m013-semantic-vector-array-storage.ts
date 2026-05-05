import type { Connection } from "kuzu";
import type { Migration } from "./types.js";
import { execDdl, queryAll } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";
import { logger } from "../../util/logger.js";

export const version = 13;
export const description = "Add fixed-size vector columns for semantic embeddings";

/**
 * Check whether a node table exists in the current graph database.
 */
async function tableExists(conn: Connection, tableName: string): Promise<boolean> {
  try {
    const rows = await queryAll<{ name: string }>(
      conn,
      "CALL SHOW_TABLES() RETURN *",
    );
    return rows.some((r) => String(r.name) === tableName);
  } catch {
    return false;
  }
}

/**
 * Migration 13: Add numeric array embedding columns for Kuzu vector index compatibility.
 *
 * The existing STRING columns (embeddingMiniLM, embeddingNomic, embeddingJinaCode) are
 * kept for backward compatibility but will no longer be used for retrieval.
 * New fixed-size DOUBLE[768] columns store embeddings in Kuzu-native format
 * for vector indexing.
 *
 * Tables that do not exist (e.g. FileSummary on very old DBs) are skipped gracefully.
 */
export const up = async (conn: Connection): Promise<void> => {
  const alterations: Array<{ table: string; column: string }> = [
    // Symbol embedding vectors (Symbol always exists)
    { table: "Symbol", column: "embeddingMiniLMVec" },
    { table: "Symbol", column: "embeddingNomicVec" },
    { table: "Symbol", column: "embeddingJinaCodeVec" },
    // FileSummary embedding vectors (may not exist on old DBs)
    { table: "FileSummary", column: "embeddingMiniLMVec" },
    { table: "FileSummary", column: "embeddingNomicVec" },
    // AgentFeedback embedding vectors (may not exist on old DBs)
    { table: "AgentFeedback", column: "embeddingMiniLMVec" },
    { table: "AgentFeedback", column: "embeddingNomicVec" },
  ];

  // Cache table existence checks
  const existsCache = new Map<string, boolean>();

  for (const { table, column } of alterations) {
    // Check table existence (cached)
    if (!existsCache.has(table)) {
      existsCache.set(table, await tableExists(conn, table));
    }
    if (!existsCache.get(table)) {
      logger.debug(`[m013] Table ${table} does not exist, skipping ${column}`);
      continue;
    }

    try {
      await execDdl(conn, `ALTER TABLE ${table} ADD ${column} DOUBLE[768]`);
      logger.info(`[m013] Added ${column} DOUBLE[768] to ${table}`);
    } catch (err) {
      // Column may already exist from a partial run
      const msg = err instanceof Error ? err.message : String(err);
      if (IDEMPOTENT_DDL_ERROR_RE.test(msg)) {
        logger.debug(`[m013] Column ${column} already exists on ${table}, skipping`);
      } else {
        logger.warn(`[m013] Failed to add ${column} to ${table}: ${msg}`);
        throw err;
      }
    }
  }
};

export default { version, description, up } satisfies Migration;
