/**
 * ladybug-core.ts — Shared LadybugDB helper functions
 *
 * This module contains the low-level query execution wrappers, type converters,
 * and transaction management utilities used by all domain-specific DB modules.
 * It is the foundation of the ladybug-queries.ts split.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Connection, PreparedStatement, QueryResult } from "kuzu";
import { logger } from "../util/logger.js";
import { DatabaseError } from "../domain/errors.js";

const MAX_PREPARED_STATEMENT_CACHE_SIZE = 200;

const preparedStatementCacheByConn = new WeakMap<
  Connection,
  Map<string, PreparedStatement>
>();
const transactionDepthByConn = new WeakMap<Connection, number>();
const poisonedConnections = new WeakMap<Connection, true>();
const transactionOwnerByConn = new WeakMap<Connection, symbol>();
const transactionContext = new AsyncLocalStorage<Map<Connection, symbol>>();

/**
 * Clear the prepared statement cache for a specific connection.
 * Must be called after DDL schema changes (migrations) so that
 * cached prepared statements referencing the old catalog are evicted.
 */
export function clearPreparedStatementCache(conn: Connection): void {
  preparedStatementCacheByConn.delete(conn);
}


export function assertSafeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new DatabaseError(
      `${name} must be a safe integer, got: ${String(value)}`,
    );
  }
}

/**
 * Coerce a value to a number.
 *
 * Returns 0 for null/undefined — this is intentional for metric fields
 * (fanIn, churn30d, byteSize) where "not set" is semantically equivalent
 * to zero. Callers that need to distinguish missing from zero should
 * check for null/undefined before calling this function.
 */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    const n = Number(value);
    assertSafeInt(n, "numeric value");
    return n;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isNaN(n)) {
      logger.warn("toNumber: non-numeric string coerced to 0", {
        value: value.slice(0, 50),
      });
      return 0;
    }
    return n;
  }
  if (value == null) {
    logger.debug("toNumber: null/undefined coerced to 0");
  } else {
    logger.warn("toNumber: unexpected non-numeric value coerced to 0", {
      type: typeof value,
      value: String(value).slice(0, 50),
    });
  }
  return 0;
}

export function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") return value === "true" || value === "1";
  return false;
}

export async function getPreparedStatement(
  conn: Connection,
  statement: string,
): Promise<PreparedStatement> {
  let cache = preparedStatementCacheByConn.get(conn);
  if (!cache) {
    cache = new Map<string, PreparedStatement>();
    preparedStatementCacheByConn.set(conn, cache);
  }

  const cached = cache.get(statement);
  if (cached) {
    // refresh LRU position
    cache.delete(statement);
    cache.set(statement, cached);
    return cached;
  }

  const prepared = await conn.prepare(statement);
  cache.set(statement, prepared);

  // Evict oldest entry to stay within cache size limit.
  // kuzu PreparedStatement is a lightweight handle (no close() needed).
  if (cache.size > MAX_PREPARED_STATEMENT_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }

  return prepared;
}

async function execute(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<QueryResult> {
  const prepared = await getPreparedStatement(conn, statement);
  // Ladybug accepts string | number | boolean | null | bigint — callers pass
  // Record<string, unknown> for convenience; the cast is safe.
  const result = await conn.execute(
    prepared,
    params as Parameters<Connection["execute"]>[1],
  );
  return result;
}

export async function queryAll<T>(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const result = await execute(conn, statement, params);
  try {
    return (await result.getAll()) as T[];
  } finally {
    result.close();
  }
}

export async function querySingle<T>(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<T | null> {
  const rows = await queryAll<T>(conn, statement, params);
  return rows.length > 0 ? rows[0] : null;
}

export async function exec(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  const result = await execute(conn, statement, params);
  result.close();
}

export function isConnectionPoisoned(conn: Connection): boolean {
  return poisonedConnections.has(conn);
}

export function clearConnectionPoisoned(conn: Connection): void {
  poisonedConnections.delete(conn);
}

/**
 * Execute `fn` inside a transaction. Supports nesting via depth tracking.
 *
 * **Concurrency contract**: callers MUST serialize concurrent calls on the
 * same `conn` (e.g., by obtaining the connection through a write limiter).
 * Two concurrent `withTransaction` calls on the same connection will race
 * on depth tracking and produce corrupt transaction state.
 */
// Track in-flight transaction ownership to detect concurrent misuse (H1).
// NOTE: This guard is safe because the check-and-set sequence between
// `transactionLockByConn.get()` and `.set()` is synchronous (no await
// in between), so JavaScript's single-threaded event loop guarantees
// atomicity. It will NOT detect two callers that enter withTransaction()
// in the same microtask before either reaches the first await — but that
// scenario is impossible given the synchronous check-set path.
const transactionLockByConn = new WeakMap<Connection, boolean>();

export async function withTransaction<T>(
  conn: Connection,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  const store = transactionContext.getStore();
  const depth = transactionDepthByConn.get(conn) ?? 0;
  const activeOwner = transactionOwnerByConn.get(conn);
  const currentOwner = store?.get(conn);

  if (depth === 0 && isConnectionPoisoned(conn)) {
    throw new DatabaseError(
      "Connection is unusable after a rollback failure. Recreate it before starting a new transaction.",
    );
  }

  if (depth > 0 && currentOwner !== activeOwner) {
    throw new DatabaseError(
      "Concurrent withTransaction() detected on the same connection. " +
        "Callers must serialize access (e.g., via the write limiter).",
    );
  }

  if (depth === 0 && transactionLockByConn.get(conn)) {
    throw new DatabaseError(
      "Concurrent withTransaction() detected on the same connection. " +
        "Callers must serialize access (e.g., via the write limiter).",
    );
  }

  const owner = activeOwner ?? Symbol("transaction-owner");
  const nextStore = new Map(store ?? []);
  nextStore.set(conn, owner);

  return transactionContext.run(nextStore, async () => {
    if (depth === 0) {
      transactionLockByConn.set(conn, true);
      transactionOwnerByConn.set(conn, owner);
    }
    transactionDepthByConn.set(conn, depth + 1);

    if (depth === 0) {
      await exec(conn, "BEGIN TRANSACTION");
    }

    try {
      const result = await fn(conn);
      if (depth === 0) {
        await exec(conn, "COMMIT");
      }
      return result;
    } catch (err) {
      if (depth === 0) {
        try {
          await exec(conn, "ROLLBACK");
        } catch (rollbackErr) {
          poisonedConnections.set(conn, true);
          const originalMessage = err instanceof Error ? err.message : String(err);
          const rollbackMessage =
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          throw new DatabaseError(
            `Transaction rollback failed after ${originalMessage}: ${rollbackMessage}`,
          );
        }
      }
      throw err;
    } finally {
      const nextDepth = (transactionDepthByConn.get(conn) ?? 1) - 1;
      if (nextDepth > 0) {
        transactionDepthByConn.set(conn, nextDepth);
      } else {
        transactionDepthByConn.delete(conn);
        transactionLockByConn.delete(conn);
        transactionOwnerByConn.delete(conn);
      }
    }
  });
}
