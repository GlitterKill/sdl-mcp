/**
 * m006 — Add UsageSnapshot node table for token savings tracking.
 *
 * Upgrades v5 databases to v6. No data backfill needed —
 * UsageSnapshot table starts empty since there is no prior usage data.
 */
import type { Connection } from "kuzu";
import { execDdl } from "../ladybug-core.js";

export const version = 6;
export const description =
  "Add UsageSnapshot node table for token savings tracking";

export async function up(conn: Connection): Promise<void> {
  // Node table
  await execDdl(
    conn,
    `CREATE NODE TABLE IF NOT EXISTS UsageSnapshot (
      snapshotId STRING PRIMARY KEY,
      sessionId STRING,
      repoId STRING,
      timestamp STRING,
      totalSdlTokens INT64,
      totalRawEquivalent INT64,
      totalSavedTokens INT64,
      savingsPercent DOUBLE,
      callCount INT64,
      toolBreakdownJson STRING
    )`,
  );

  // Indexes (may not be supported on all Kuzu versions)
  const indexes = [
    `CREATE INDEX idx_usagesnapshot_repoId ON UsageSnapshot(repoId)`,
    `CREATE INDEX idx_usagesnapshot_timestamp ON UsageSnapshot(timestamp)`,
  ];
  for (const idx of indexes) {
    try {
      await execDdl(conn, idx);
    } catch {
      // Index support varies across LadybugDB/Kuzu versions; these are performance-only.
    }
  }
}
