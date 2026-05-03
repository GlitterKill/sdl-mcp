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
import { ConcurrencyLimiter } from "../util/concurrency.js";

const MAX_PREPARED_STATEMENT_CACHE_SIZE = 200;

const preparedStatementCacheByConn = new WeakMap<
  Connection,
  Map<string, PreparedStatement>
>();
const transactionDepthByConn = new WeakMap<Connection, number>();
const poisonedConnections = new WeakMap<Connection, true>();
const transactionOwnerByConn = new WeakMap<Connection, symbol>();
const transactionContext = new AsyncLocalStorage<Map<Connection, symbol>>();

// Per-connection mutex. LadybugDB native connections are not safe for
// concurrent execute()/query() calls — the native layer aborts the process.
// The read pool round-robins connections, but with more concurrent tool
// handlers than pool slots two callers can land on the same conn. This mutex
// serializes prepare → execute → getAll per connection.
const connMutex = new WeakMap<Connection, ConcurrencyLimiter>();

function getConnMutex(conn: Connection): ConcurrencyLimiter {
  let mutex = connMutex.get(conn);
  if (!mutex) {
    mutex = new ConcurrencyLimiter({
      maxConcurrency: 1,
      queueTimeoutMs: 120_000,
    });
    connMutex.set(conn, mutex);
  }
  return mutex;
}

// Stuck-connection tracker. When a native task running inside the per-conn
// mutex exceeds STUCK_TASK_WARN_MS without settling, the conn is flagged
// stuck so the read-pool round-robin can route around it. This is a liveness
// fallback for the case where a LadybugDB native call hangs (e.g. after an
// INSTALL race or write-txn conflict left the conn in an internally locked
// state). The flag clears when the task finally settles.
const DEFAULT_STUCK_TASK_WARN_MS = 30_000;

// Test-only: override the watchdog threshold via env var so unit tests can
// exercise the stuck-conn flag without 30-second sleeps. Read fresh on each
// call so a test can change it mid-process.
function getStuckTaskWarnMs(): number {
  const raw = process.env.SDL_STUCK_TASK_WARN_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_STUCK_TASK_WARN_MS;
}
const stuckConns = new WeakSet<Connection>();

export function isConnStuck(conn: Connection): boolean {
  return stuckConns.has(conn);
}

function withConnWatchdog<T>(
  conn: Connection,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  let stuckMarked = false;
  const warnMs = getStuckTaskWarnMs();
  const timer = setTimeout(() => {
    stuckMarked = true;
    stuckConns.add(conn);
    logger.warn(
      `[ladybug-core] DB task running >${warnMs}ms; conn flagged stuck (label=${label})`,
    );
  }, warnMs);
  timer.unref();
  return fn().finally(() => {
    clearTimeout(timer);
    if (stuckMarked) stuckConns.delete(conn);
  });
}

/**
 * Run a function with exclusive access to a LadybugDB connection.
 * For callers that use `conn.query()` directly (stored procedures, DDL)
 * and need to participate in the per-connection serialization.
 *
 * WARNING: non-reentrant. Do not nest on the same connection.
 */
export function runExclusive<T>(
  conn: Connection,
  fn: () => Promise<T>,
): Promise<T> {
  return getConnMutex(conn).run(() =>
    withConnWatchdog(conn, "runExclusive", fn),
  );
}

/**
 * Wait for any in-flight query on `conn` to finish, then reject all queued
 * work with `onTimeoutError`. Used during shutdown to ensure no native
 * prepare/execute pipeline is mid-flight when the connection closes.
 */
export async function drainConnMutex(
  conn: Connection,
  timeoutMs: number,
  onTimeoutError: Error,
): Promise<void> {
  const mutex = connMutex.get(conn);
  if (!mutex) return;

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      mutex.drain(),
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, timeoutMs);
        timeoutHandle.unref();
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  mutex.clearQueue(onTimeoutError);
}

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
  try {
    const prepared = await getPreparedStatement(conn, statement);
    // Ladybug accepts string | number | boolean | null | bigint — callers pass
    // Record<string, unknown> for convenience; the cast is safe.
    const result = await conn.execute(
      prepared,
      params as Parameters<Connection["execute"]>[1],
    );
    return result;
  } catch (err) {
    throw new DatabaseError(
      `Query execution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function queryAll<T>(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  return getConnMutex(conn).run(() =>
    withConnWatchdog(conn, "queryAll", async () => {
      const result = await execute(conn, statement, params);
      try {
        return (await result.getAll()) as T[];
      } finally {
        result.close();
      }
    }),
  );
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
  return getConnMutex(conn).run(() =>
    withConnWatchdog(conn, "exec", async () => {
      const result = await execute(conn, statement, params);
      result.close();
    }),
  );
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

// LadybugDB allows only one write transaction at a time system-wide. When
// concurrent writers race — e.g. indexer post-phase writes overlap with audit-
// log writes or detectAlgoCapability lazy DDL — BEGIN TRANSACTION fails with
// "Cannot start a new write transaction in the system". This is transient:
// the active writer commits within milliseconds in the common case. Retry
// with capped exponential backoff before propagating, so transient races
// don't surface as user-visible failures.
const BEGIN_TXN_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;

async function beginTransactionWithRetry(conn: Connection): Promise<void> {
  let lastErr: unknown;
  for (
    let attempt = 0;
    attempt <= BEGIN_TXN_RETRY_DELAYS_MS.length;
    attempt++
  ) {
    try {
      await exec(conn, "BEGIN TRANSACTION");
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Cannot start a new write transaction")) throw err;
      lastErr = err;
      if (attempt >= BEGIN_TXN_RETRY_DELAYS_MS.length) break;
      const delay = BEGIN_TXN_RETRY_DELAYS_MS[attempt];
      logger.debug(
        `[ladybug-core] BEGIN TRANSACTION conflict (attempt ${attempt + 1}); retrying in ${delay}ms`,
      );
      await new Promise((r) => {
        const t = setTimeout(r, delay);
        t.unref();
      });
    }
  }
  throw lastErr ?? new DatabaseError("BEGIN TRANSACTION failed without error");
}

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
      await beginTransactionWithRetry(conn);
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
          const rollbackMessage =
            rollbackErr instanceof Error
              ? rollbackErr.message
              : String(rollbackErr);
          if (!/no active transaction/i.test(rollbackMessage)) {
            poisonedConnections.set(conn, true);
            const originalMessage =
              err instanceof Error ? err.message : String(err);
            throw new DatabaseError(
              `Transaction rollback failed after ${originalMessage}: ${rollbackMessage}`,
            );
          }
          logger.debug(
            "withTransaction: ROLLBACK swallowed (txn already auto-rolled by engine)",
            {
              rollbackMessage,
              originalError: err instanceof Error ? err.message : String(err),
            },
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
