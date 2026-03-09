/**
 * kuzu-core.ts — Shared KuzuDB helper functions
 *
 * This module contains the low-level query execution wrappers, type converters,
 * and transaction management utilities used by all domain-specific DB modules.
 * It is the foundation of the kuzu-queries.ts split.
 */
import type { Connection, PreparedStatement, QueryResult } from "kuzu";
import { logger } from "../util/logger.js";
import { DatabaseError } from "../domain/errors.js";

const MAX_PREPARED_STATEMENT_CACHE_SIZE = 200;

const preparedStatementCacheByConn = new WeakMap<
  Connection,
  Map<string, PreparedStatement>
>();
const transactionDepthByConn = new WeakMap<Connection, number>();

const joinHintSupported: boolean | null = null;

export function isJoinHintSyntaxUnsupported(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("extraneous input 'HINT'") ||
    message.includes('extraneous input "HINT"')
  );
}

export function assertSafeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new DatabaseError(
      `${name} must be a safe integer, got: ${String(value)}`,
    );
  }
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  if (value != null) {
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

function coerceQueryResult(result: QueryResult | QueryResult[]): QueryResult {
  if (!Array.isArray(result)) return result;
  if (result.length === 0) {
    throw new DatabaseError("Empty query result array from KuzuDB");
  }
  // Kuzu can return multiple results for multi-statement queries; we only use
  // single statements in this module. Close any earlier results defensively.
  for (let i = 0; i < result.length - 1; i++) {
    result[i]?.close();
  }
  return result[result.length - 1];
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
  // Kuzu accepts string | number | boolean | null | bigint — callers pass
  // Record<string, unknown> for convenience; the cast is safe.
  const result = await conn.execute(
    prepared,
    params as Parameters<Connection["execute"]>[1],
  );
  return coerceQueryResult(result);
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

export async function withTransaction<T>(
  conn: Connection,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  const depth = transactionDepthByConn.get(conn) ?? 0;
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
      } catch {
        // Ignore rollback failures
      }
    }
    throw err;
  } finally {
    const nextDepth = (transactionDepthByConn.get(conn) ?? 1) - 1;
    if (nextDepth > 0) {
      transactionDepthByConn.set(conn, nextDepth);
    } else {
      transactionDepthByConn.delete(conn);
    }
  }
}

// Re-export joinHintSupported for use by domain modules
export { joinHintSupported };
