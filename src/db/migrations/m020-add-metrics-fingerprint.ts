import type { Connection } from "kuzu";
import { execDdl } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";

export const version = 20;
export const description = "Add repo metrics fingerprint table";

const TABLE_DDL = `CREATE NODE TABLE IF NOT EXISTS MetricsFingerprint (
  repoId STRING PRIMARY KEY,
  metricsHash STRING,
  rowCount INT64,
  updatedAt STRING
)`;

export async function up(conn: Connection): Promise<void> {
  try {
    await execDdl(conn, TABLE_DDL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (IDEMPOTENT_DDL_ERROR_RE.test(msg)) {
      return;
    }
    throw err;
  }
}
