import type { Connection } from "kuzu";

/**
 * m014 — Extend UsageSnapshot node table with packed-wire-format telemetry.
 *
 * Adds four new columns:
 *   - packedEncodings (INT64) — number of payloads emitted in packed format
 *   - packedFallbacks (INT64) — number of times the gate dropped back to JSON
 *   - packedBytesSaved (INT64) — cumulative bytes saved on packed emissions
 *   - packedByEncoderJson (STRING) — per-encoder breakdown as JSON blob
 *
 * Skipped silently when the UsageSnapshot table does not exist yet
 * (e.g. minimal v8 test fixtures): m006 will create the table when it
 * runs in the same migration window.
 */

export const version = 14;
export const description = "Add packed wire format telemetry to UsageSnapshot";

export async function up(conn: Connection): Promise<void> {
  if (!(await tableExists(conn, "UsageSnapshot"))) {
    return;
  }
  const ddls = [
    "ALTER TABLE UsageSnapshot ADD packedEncodings INT64 DEFAULT 0",
    "ALTER TABLE UsageSnapshot ADD packedFallbacks INT64 DEFAULT 0",
    "ALTER TABLE UsageSnapshot ADD packedBytesSaved INT64 DEFAULT 0",
    "ALTER TABLE UsageSnapshot ADD packedByEncoderJson STRING DEFAULT '{}'",
  ];
  for (const ddl of ddls) {
    try {
      await execDdl(conn, ddl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists|duplicate column/i.test(msg)) continue;
      throw err;
    }
  }
}

async function tableExists(conn: Connection, name: string): Promise<boolean> {
  try {
    const result = await conn.query(
      `CALL show_tables() RETURN name`,
    );
    let exists = false;
    while (await result.hasNext()) {
      const row = (await result.getNext()) as { name?: unknown };
      if (row && String(row.name) === name) {
        exists = true;
        break;
      }
    }
    result.close();
    return exists;
  } catch {
    return false;
  }
}

async function execDdl(conn: Connection, ddl: string): Promise<void> {
  const result = await conn.query(ddl);
  result.close();
}
