import type { Connection } from "kuzu";
import { exec } from "../ladybug-core.js";
import { logger } from "../../util/logger.js";

export const version = 9;
export const description =
  "Add summaryQuality and summarySource to Symbol node tables";

export async function up(conn: Connection): Promise<void> {
  const alterStatements = [
    "ALTER TABLE Symbol ADD summaryQuality DOUBLE DEFAULT 0.0",
    "ALTER TABLE Symbol ADD summarySource STRING DEFAULT 'unknown'",
  ];

  for (const stmt of alterStatements) {
    try {
      await exec(conn, stmt, {});
      logger.info(`m009: executed: ${stmt}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (
        lower.includes("already") ||
        lower.includes("duplicate") ||
        lower.includes("does not exist")
      ) {
        logger.debug(`m009: skipping statement during migration bootstrap: ${stmt}`);
      } else {
        throw err;
      }
    }
  }
}
