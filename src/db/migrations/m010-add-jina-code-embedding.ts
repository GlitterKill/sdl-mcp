import type { Connection } from "kuzu";
import { exec } from "../ladybug-core.js";
import { logger } from "../../util/logger.js";

export const version = 10;
export const description =
  "Add jina-code embedding columns to Symbol node table";

export async function up(conn: Connection): Promise<void> {
  const alterStatements = [
    "ALTER TABLE Symbol ADD embeddingJinaCode STRING DEFAULT ''",
    "ALTER TABLE Symbol ADD embeddingJinaCodeCardHash STRING DEFAULT ''",
    "ALTER TABLE Symbol ADD embeddingJinaCodeUpdatedAt STRING DEFAULT ''",
  ];

  for (const stmt of alterStatements) {
    try {
      await exec(conn, stmt, {});
      logger.info(`m010: executed: ${stmt}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (
        lower.includes("already") ||
        lower.includes("duplicate") ||
        lower.includes("does not exist")
      ) {
        logger.debug(`m010: skipping statement during migration bootstrap: ${stmt}`);
      } else {
        throw err;
      }
    }
  }
}
