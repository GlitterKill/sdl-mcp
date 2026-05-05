import type { Connection } from "kuzu";
import { exec } from "../ladybug-core.js";
import { logger } from "../../util/logger.js";

export const version = 12;
export const description =
  "Add repoId column to Symbol for repo-scoped algo projections";

export async function up(conn: Connection): Promise<void> {
  try {
    await exec(conn, "ALTER TABLE Symbol ADD repoId STRING DEFAULT ''", {});
    logger.info("m012: added Symbol.repoId column");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (lower.includes("already") || lower.includes("duplicate")) {
      logger.debug("m012: Symbol.repoId column already present");
    } else {
      throw err;
    }
  }

  // Backfill from the canonical Symbol -> Repo edge so repo-scoped projected
  // graphs can filter on a single node property instead of building gigantic
  // per-repo IN-lists. This is the smallest schema change that makes the algo
  // stage both correct and scalable.
  try {
    await exec(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(r:Repo)
       SET s.repoId = r.repoId`,
      {},
    );
    logger.info("m012: backfilled Symbol.repoId from SYMBOL_IN_REPO edges");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug("m012: Symbol.repoId backfill skipped", { reason: msg });
  }

  // Index creation is best-effort, mirroring createSchema(): performance-only
  // and known to be unsupported on some Ladybug/Kuzu builds.
  try {
    await exec(conn, "CREATE INDEX idx_symbol_repoId ON Symbol(repoId)", {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug("m012: Symbol.repoId index creation skipped", {
      reason: msg,
    });
  }
}
