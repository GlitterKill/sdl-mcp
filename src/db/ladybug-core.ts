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

// Per-connection execution mutex.
//
// LadybugDB's native connection state is NOT safe for concurrent execute() or
// query() calls. The read pool round-robins connections, but with more
// concurrent tool handlers than pool slots (dispatch limit 8 vs. read pool 4),
// two callers can land on the same conn and issue simultaneous queries — the
// native layer then aborts the process (no JS exception, just silent exit).
//
// This mutex serializes prepare → execute → getAll → close on a per-conn basis
// so that CPU-bound parallelism is preserved at the tool-dispatch level while
// native DB execution is always one-at-a-time per connection.
//
// Reentrancy: do NOT call runExclusive from inside another runExclusive on the
// same conn — maxConcurrency is 1, so nested acquire deadlocks. The public
// helpers (queryAll / exec) wrap once at the outermost layer; querySingle
// delegates to queryAll without adding another wrap.
const connExecMutex = new WeakMap<Connection, ConcurrencyLimiter>();

// Parallel iterable registry of per-conn mutexes. WeakMap is not iterable, so
// shutdown cannot walk it to drain in-flight query pipelines. This Set holds
// strong refs to every live mutex so closeLadybugDb() can await them before
// tearing down the connection pools. Pool size is small (read + write
// connections, fixed at init), so the set stays bounded.
const activeConnMutexes = new Set<ConcurrencyLimiter>();

// Hard fence for shutdown. When set, no new runExclusive() call may start —
// late arrivals that cross an `await` after drain returned would otherwise
// schedule against a conn we are about to close (LadybugDB 0.15.2 UAF). The
// flag is raised before drainConnectionMutexes() runs and lowered by
// resetConnectionGate() on re-init.
let connectionGateClosed = false;
let connectionGateError: Error = new DatabaseError("LadybugDB is closing");

function getConnExecMutex(conn: Connection): ConcurrencyLimiter {
  let mutex = connExecMutex.get(conn);
  if (!mutex) {
    mutex = new ConcurrencyLimiter({
      maxConcurrency: 1,
      queueTimeoutMs: 120_000,
    });
    connExecMutex.set(conn, mutex);
  }
  // Re-add on every access (Set.add is idempotent). If a previous
  // drainConnectionMutexes() cleared the Set but the WeakMap still hands back
  // this cached mutex, we must re-register so a subsequent close can drain it.
  activeConnMutexes.add(mutex);
  return mutex;
}

/**
 * Close the connection gate. All future runExclusive() calls will reject with
 * the configured error until resetConnectionGate() is called. Idempotent.
 */
export function closeConnectionGate(error: Error): void {
  connectionGateError = error;
  connectionGateClosed = true;
}

/**
 * Reopen the connection gate. Called on DB (re-)initialization so the next
 * session can accept queries.
 */
export function resetConnectionGate(): void {
  connectionGateClosed = false;
}

/**
 * Drain all per-connection execution mutexes. Used on shutdown to ensure no
 * prepare/execute/getAll pipeline is mid-flight when the DB closes — a race
 * that has triggered native use-after-free crashes in LadybugDB 0.15.2.
 *
 * Waits up to `timeoutMs` for active work to finish, then rejects any still-
 * queued tasks with `onTimeoutError` so callers receive a clean DatabaseError
 * rather than a silent hang.
 *
 * CALLER CONTRACT: closeConnectionGate() must be raised before calling this
 * so new runExclusive() invocations cannot repopulate activeConnMutexes while
 * the drain is in flight.
 */
export async function drainConnectionMutexes(
  timeoutMs: number,
  onTimeoutError: Error,
): Promise<void> {
  const mutexes = [...activeConnMutexes];
  if (mutexes.length === 0) return;

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(mutexes.map((m) => m.drain())),
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, timeoutMs);
        timeoutHandle.unref();
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // Clear queued tasks on every mutex so nothing schedules against a conn we
  // are about to close. Safe to call even after drain completed.
  for (const m of mutexes) {
    m.clearQueue(onTimeoutError);
  }
  activeConnMutexes.clear();
}

/**
 * Run a function with exclusive access to a LadybugDB connection.
 *
 * Serializes concurrent callers on the same connection so native prepare /
 * execute / query calls are never interleaved. Exported so low-level callers
 * that use `conn.query()` directly (schema init, extension load, migrations)
 * can participate in the same lock regime.
 *
 * WARNING: non-reentrant. Nested calls on the same connection deadlock.
 *
 * Rejects immediately if the connection gate is closed (shutdown in progress).
 */
export function runExclusive<T>(
  conn: Connection,
  fn: () => Promise<T>,
): Promise<T> {
  if (connectionGateClosed) return Promise.reject(connectionGateError);
  return getConnExecMutex(conn).run(fn);
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

// Inner execute: caller must hold the per-conn mutex. Used by queryAll/exec
// to do the prepare → native execute without re-acquiring the lock.
async function executeLocked(
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
  return runExclusive(conn, async () => {
    const result = await executeLocked(conn, statement, params);
    try {
      return (await result.getAll()) as T[];
    } finally {
      result.close();
    }
  });
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
  return runExclusive(conn, async () => {
    const result = await executeLocked(conn, statement, params);
    result.close();
  });
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
          const originalMessage =
            err instanceof Error ? err.message : String(err);
          const rollbackMessage =
            rollbackErr instanceof Error
              ? rollbackErr.message
              : String(rollbackErr);
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
