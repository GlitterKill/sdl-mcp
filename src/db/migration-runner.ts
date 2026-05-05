/**
 * migration-runner.ts — Forward-only schema migration runner for LadybugDB.
 *
 * Applies pending migrations sequentially. DDL runs in autocommit mode
 * (Kuzu requirement). Idempotent IF NOT EXISTS clauses handle crash recovery.
 */
import type { Connection } from "kuzu";
import type { Migration } from "./migrations/types.js";
import { exec, clearPreparedStatementCache } from "./ladybug-core.js";
import { logger } from "../util/logger.js";
import { DatabaseError } from "../domain/errors.js";

/**
 * LadybugDB/Kuzu phrasings that mean an idempotent DDL statement has already
 * been applied. Migrations should use this shared guard so retry behavior does
 * not drift between files.
 */
export const IDEMPOTENT_DDL_ERROR_RE =
  /already exists|duplicate column|already has property/i;

/**
 * Validate that a migration list is sequential with no gaps or duplicates.
 * Exported for testing.
 */
export function validateMigrationList(
  migs: Migration[],
  baseVersion: number,
): void {
  for (let i = 0; i < migs.length; i++) {
    const expected = baseVersion + 1 + i;
    if (migs[i].version !== expected) {
      throw new DatabaseError(
        `Migration registry error: expected version ${expected} at index ${i}, ` +
          `got ${migs[i].version} ("${migs[i].description}"). ` +
          `Versions must be sequential starting at ${baseVersion + 1}.`,
      );
    }
  }
}

/**
 * Return the subset of migrations that need to be applied.
 * Exported for testing.
 */
export function computePendingMigrations(
  migs: Migration[],
  currentVersion: number,
): Migration[] {
  return migs
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);
}

/**
 * Apply all pending migrations to bring the DB schema up to date.
 *
 * @param writeConn - The dedicated write connection (from withWriteConn)
 * @param currentVersion - The current schema version in the DB
 * @param allMigrations - The full ordered migration list from the registry
 * @returns The new schema version after all migrations are applied
 */
export async function runPendingMigrations(
  writeConn: Connection,
  currentVersion: number,
  allMigrations: Migration[],
): Promise<number> {
  const pending = computePendingMigrations(allMigrations, currentVersion);

  if (pending.length === 0) {
    logger.info("Schema up to date", { version: currentVersion });
    return currentVersion;
  }

  logger.info("Applying schema migrations", {
    from: currentVersion,
    to: pending[pending.length - 1].version,
    count: pending.length,
  });

  let appliedVersion = currentVersion;

  for (const migration of pending) {
    const startMs = Date.now();
    const prevVersion = appliedVersion;

    try {
      // Run the migration (DDL in autocommit, DML may use internal transactions)
      await migration.up(writeConn);

      // Update SchemaVersion after successful migration
      const now = new Date().toISOString();
      await exec(
        writeConn,
        `MERGE (sv:SchemaVersion {id: 'current'})
         ON CREATE SET sv.schemaVersion = $version, sv.createdAt = $now, sv.updatedAt = $now
         ON MATCH SET sv.schemaVersion = $version, sv.updatedAt = $now`,
        { version: migration.version, now },
      );

      appliedVersion = migration.version;
      const elapsedMs = Date.now() - startMs;

      logger.info("Applied migration", {
        description: migration.description,
        from: prevVersion,
        to: migration.version,
        elapsedMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Migration failed", {
        description: migration.description,
        version: migration.version,
        error: msg,
      });
      throw new DatabaseError(
        `Migration "${migration.description}" (v${prevVersion} -> v${migration.version}) failed: ${msg}. ` +
          `The database is at schema version ${appliedVersion}. ` +
          `The migration uses IF NOT EXISTS clauses and will retry on next startup.`,
      );
    }
  }

  // Clear prepared statement cache after DDL changes
  clearPreparedStatementCache(writeConn);

  return appliedVersion;
}
