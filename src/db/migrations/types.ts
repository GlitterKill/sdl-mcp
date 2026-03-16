import type { Connection } from "kuzu";

/**
 * A single forward-only schema migration.
 *
 * Rules:
 * - `version` must be sequential (no gaps, no duplicates)
 * - DDL in `up()` must use IF NOT EXISTS / IF EXISTS for idempotency
 * - DML backfills should use MERGE for crash-recovery safety
 */
export interface Migration {
  /** Schema version this migration brings the DB to. */
  version: number;
  /** Human-readable description for logging. */
  description: string;
  /** Migration function. Receives the dedicated write connection. */
  up: (conn: Connection) => Promise<void>;
}
