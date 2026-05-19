import type { Connection } from "kuzu";
import { execDdl } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";

export const version = 19;
export const description = "Add predictive prefetch outcome tables";

const TABLE_DDLS = [
  `CREATE NODE TABLE IF NOT EXISTS PrefetchOutcome (
    outcomeId STRING PRIMARY KEY,
    prefetchId STRING,
    aggregateKey STRING,
    repoId STRING,
    taskType STRING,
    clientKey STRING,
    strategy STRING,
    resourceKind STRING,
    resourceKey STRING,
    outcome STRING,
    latencySavedMs DOUBLE DEFAULT 0.0,
    tokensSavedEstimate INT64 DEFAULT 0,
    plannedCost INT64 DEFAULT 0,
    createdAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS PrefetchPolicyAggregate (
    aggregateKey STRING PRIMARY KEY,
    repoId STRING,
    taskType STRING,
    clientKey STRING,
    strategy STRING,
    resourceKind STRING,
    offered INT64 DEFAULT 0,
    used INT64 DEFAULT 0,
    accepted INT64 DEFAULT 0,
    wasted INT64 DEFAULT 0,
    suppressed INT64 DEFAULT 0,
    latencySavedMs DOUBLE DEFAULT 0.0,
    tokensSavedEstimate INT64 DEFAULT 0,
    score DOUBLE DEFAULT 0.0,
    scoreEwma DOUBLE DEFAULT 0.0,
    hitRateEwma DOUBLE DEFAULT 0.0,
    acceptedRateEwma DOUBLE DEFAULT 0.0,
    wasteRateEwma DOUBLE DEFAULT 0.0,
    ewmaSamples INT64 DEFAULT 0,
    lastOutcomeAt STRING,
    updatedAt STRING
  )`,
];

const INDEX_DDLS = [
  `CREATE INDEX idx_prefetch_outcome_repoId ON PrefetchOutcome(repoId)`,
  `CREATE INDEX idx_prefetch_outcome_createdAt ON PrefetchOutcome(createdAt)`,
  `CREATE INDEX idx_prefetch_aggregate_repoId ON PrefetchPolicyAggregate(repoId)`,
];

export async function up(conn: Connection): Promise<void> {
  for (const ddl of TABLE_DDLS) {
    try {
      await execDdl(conn, ddl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (IDEMPOTENT_DDL_ERROR_RE.test(msg)) {
        continue;
      }
      throw err;
    }
  }

  for (const ddl of INDEX_DDLS) {
    try {
      await execDdl(conn, ddl);
    } catch {
      // Secondary indexes are performance-only and may already exist on DBs
      // that were initialized from a prerelease fresh schema.
    }
  }
}
