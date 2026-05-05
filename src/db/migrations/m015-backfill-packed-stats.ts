import type { Connection } from "kuzu";
import { execDdl, execStoredProcRaw } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";

/**
 * m015 — Heal UsageSnapshot for fresh DBs created before the base-schema
 * fix landed (v0.10.10). Those DBs were stamped at schemaVersion 14 by
 * createBaseSchema, but the base CREATE for UsageSnapshot did not include
 * the four packed-wire-format columns added by m014. As a result m014's
 * ALTERs never ran (currentVersion === LADYBUG_SCHEMA_VERSION), and
 * sdl.usage.stats failed with "Cannot find property packedEncodings for u".
 *
 * This migration re-runs the same ALTERs with the same dup-tolerant guard
 * as m014. It is a no-op on:
 *   - Fresh DBs created after the base-schema fix (columns already present
 *     from createBaseSchema → ALTER raises duplicate column → ignored).
 *   - DBs that legitimately upgraded through m014 (same path).
 *   - Historical minimal fixtures/DBs without UsageSnapshot (no table to heal).
 *
 * It is only load-bearing for the narrow window of DBs that hit the drift.
 */

export const version = 15;
export const description =
  "Backfill packed-wire-format columns on UsageSnapshot for drifted v14 DBs";

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
      if (IDEMPOTENT_DDL_ERROR_RE.test(msg)) {
        continue;
      }
      throw err;
    }
  }
}

async function tableExists(conn: Connection, name: string): Promise<boolean> {
  let result: Awaited<ReturnType<typeof execStoredProcRaw>> | undefined;
  try {
    result = await execStoredProcRaw(conn, `CALL show_tables() RETURN name`);
    let exists = false;
    while (await result.hasNext()) {
      const row = (await result.getNext()) as { name?: unknown };
      if (row && String(row.name) === name) {
        exists = true;
        break;
      }
    }
    return exists;
  } catch {
    return false;
  } finally {
    result?.close();
  }
}
