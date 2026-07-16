import type { Connection } from "kuzu";

import { execDdl } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";

export const version = 22;
export const description = "Add persisted graph integrity state";

const DERIVED_STATE_DDL = `CREATE NODE TABLE IF NOT EXISTS DerivedState (
  repoId STRING PRIMARY KEY,
  clustersDirty BOOL DEFAULT false,
  processesDirty BOOL DEFAULT false,
  algorithmsDirty BOOL DEFAULT false,
  summariesDirty BOOL DEFAULT false,
  embeddingsDirty BOOL DEFAULT false,
  targetVersionId STRING,
  computedVersionId STRING,
  updatedAt STRING,
  lastError STRING,
  graphIntegrityState STRING DEFAULT 'unknown',
  graphIntegrityVersionId STRING,
  graphIntegrityDigest STRING,
  graphIntegrityError STRING
)`;

const INTEGRITY_COLUMNS = [
  "ALTER TABLE DerivedState ADD graphIntegrityState STRING DEFAULT 'unknown'",
  "ALTER TABLE DerivedState ADD graphIntegrityVersionId STRING DEFAULT NULL",
  "ALTER TABLE DerivedState ADD graphIntegrityDigest STRING DEFAULT NULL",
  "ALTER TABLE DerivedState ADD graphIntegrityError STRING DEFAULT NULL",
];

export async function up(conn: Connection): Promise<void> {
  await execDdl(conn, DERIVED_STATE_DDL);
  for (const ddl of INTEGRITY_COLUMNS) {
    try {
      await execDdl(conn, ddl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!IDEMPOTENT_DDL_ERROR_RE.test(message)) throw error;
    }
  }
}
