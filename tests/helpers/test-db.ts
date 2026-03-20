/**
 * Shared test database helpers.
 *
 * Creates temp DB paths in os.tmpdir() to avoid littering the source tree.
 * Provides a standardized cleanup function for LadybugDB test databases.
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Generate a unique test DB path in the OS temp directory.
 * Uses process.pid to avoid collisions between concurrent test processes.
 */
export function makeTestDbPath(name: string): string {
  return join(tmpdir(), `.lbug-${name}-${process.pid}`);
}

/**
 * Clean up a LadybugDB test database (directory-based storage).
 * Closes the connection and database, then removes the directory.
 * All errors are silently caught (best-effort cleanup for Windows file locks).
 */
export async function cleanupTestDb(
  db: { close: () => Promise<void> } | null | undefined,
  conn: { close: () => Promise<void> } | null | undefined,
  dbPath: string,
): Promise<void> {
  try {
    await conn?.close();
  } catch {
    // best-effort
  }
  try {
    await db?.close();
  } catch {
    // best-effort
  }
  try {
    if (existsSync(dbPath)) {
      rmSync(dbPath, { recursive: true, force: true });
    }
  } catch {
    // best-effort (Windows file locks)
  }
}

/**
 * Synchronous cleanup variant for simpler test teardown.
 */
export function cleanupTestDbSync(dbPath: string): void {
  try {
    if (existsSync(dbPath)) {
      rmSync(dbPath, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }
}
