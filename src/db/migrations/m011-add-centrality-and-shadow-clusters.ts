import type { Connection } from "kuzu";
import { exec } from "../ladybug-core.js";
import { logger } from "../../util/logger.js";

export const version = 11;
export const description =
  "Add pageRank/kCore columns to Metrics and create ShadowCluster tables";

export async function up(conn: Connection): Promise<void> {
  const alterStatements = [
    "ALTER TABLE Metrics ADD pageRank DOUBLE DEFAULT 0.0",
    "ALTER TABLE Metrics ADD kCore INT64 DEFAULT 0",
  ];

  for (const stmt of alterStatements) {
    try {
      await exec(conn, stmt, {});
      logger.info(`m011: executed: ${stmt}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (lower.includes("already") || lower.includes("duplicate")) {
        logger.debug(
          `m011: column already present, skipping: ${stmt}`,
        );
      } else {
        throw err;
      }
    }
  }

  // ShadowCluster node/rel tables are idempotent via CREATE IF NOT EXISTS.
  // createSchema() will create them on fresh DBs; for existing DBs, we
  // create them here as well so the migration is self-contained.
  const createStatements = [
    `CREATE NODE TABLE IF NOT EXISTS ShadowCluster (
      shadowClusterId STRING PRIMARY KEY,
      repoId STRING,
      algorithm STRING,
      label STRING,
      symbolCount INT64 DEFAULT 0,
      modularity DOUBLE DEFAULT 0.0,
      versionId STRING,
      createdAt STRING
    )`,
    `CREATE REL TABLE IF NOT EXISTS BELONGS_TO_SHADOW_CLUSTER (
      FROM Symbol TO ShadowCluster,
      membershipScore DOUBLE DEFAULT 1.0
    )`,
    `CREATE REL TABLE IF NOT EXISTS SHADOW_CLUSTER_IN_REPO (
      FROM ShadowCluster TO Repo
    )`,
  ];

  for (const stmt of createStatements) {
    try {
      await exec(conn, stmt, {});
      logger.info(`m011: executed shadow-cluster DDL`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (lower.includes("already") || lower.includes("duplicate")) {
        logger.debug(`m011: shadow-cluster DDL already present`);
      } else {
        throw err;
      }
    }
  }
}
