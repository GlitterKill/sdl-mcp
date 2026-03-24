/**
 * m008 — Add searchText column to Cluster and Process node tables.
 *
 * Upgrades v7 databases to v8. Alters existing Cluster and Process tables
 * to add the searchText STRING property needed for Stage 3 entity FTS retrieval.
 *
 * FileSummary node table is NOT created here — fresh databases get it via
 * createSchema() in ladybug-schema.ts which already includes FileSummary.
 * This migration only handles the ALTER TABLE path for existing databases.
 */

import type { Connection } from "kuzu";
import { exec } from "../ladybug-core.js";
import { logger } from "../../util/logger.js";

export const version = 8;
export const description =
  "Add searchText to Cluster and Process node tables for Stage 3 entity FTS retrieval";

export async function up(conn: Connection): Promise<void> {
  const alterStatements = [
    "ALTER TABLE Cluster ADD searchText STRING",
    "ALTER TABLE Process ADD searchText STRING",
  ];

  for (const stmt of alterStatements) {
    try {
      await exec(conn, stmt, {});
      logger.info(`m008: executed: ${stmt}`);
    } catch (err) {
      // Column already exists — safe to ignore (idempotent).
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("duplicate")) {
        logger.debug(`m008: column already exists, skipping: ${stmt}`);
      } else {
        throw err;
      }
    }
  }
}
