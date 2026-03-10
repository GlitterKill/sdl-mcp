import { existsSync, mkdirSync } from "fs";
import { createRequire } from "node:module";
import { totalmem } from "node:os";
import { dirname } from "path";
import { normalizePath } from "../util/paths.js";
import { logger } from "../util/logger.js";
import { DatabaseError } from "../domain/errors.js";
import { ConcurrencyLimiter } from "../util/concurrency.js";
import { normalizeGraphDbPath } from "./graph-db-path.js";
import {
  createSchema,
  getSchemaVersion,
  LADYBUG_SCHEMA_VERSION,
} from "./ladybug-schema.js";

// Local interface for optional thread-count method on LadybugDB connections
interface LadybugConnectionWithThreads {
  setMaxNumThreadForExec(n: number): Promise<void>;
}

type LadybugModule = typeof import("kuzu");
type LadybugDatabase = import("kuzu").Database;
type LadybugConnection = import("kuzu").Connection;

const require = createRequire(import.meta.url);

let ladybugModule: LadybugModule | null = null;
let dbInstance: LadybugDatabase | null = null;
let currentDbPath: string | null = null;

const ONE_GB = 1024 * 1024 * 1024;
const EIGHT_GB = 8 * ONE_GB;
const DEFAULT_BUFFER_MANAGER_RATIO = 0.5;
const DEFAULT_CHECKPOINT_THRESHOLD_BYTES = 128 * 1024 * 1024;

function formatReindexGuidanceError(dbPath: string, msg: string): string {
  return (
    `Database at '${dbPath}' is not compatible with the current graph engine (Ladybug). ` +
    `Delete the existing database directory and re-run indexing: rm -rf '${dbPath}' && sdl-mcp index. ` +
    "Migrating older graph databases in-place is not supported. " +
    `Original error: ${msg}`
  );
}

// ---------------------------------------------------------------------------
// Connection Pool — Read/Write Separation
// ---------------------------------------------------------------------------
// LadybugDB supports multiple Connection objects from a single Database
// instance for concurrent queries within one process.
//
// Read pool: N connections (default 4, configurable) for concurrent reads.
// Write conn: 1 dedicated connection, serialized via ConcurrencyLimiter.
//
// This enables multi-agent scenarios where 4-6 MCP sessions issue read
// queries concurrently while indexing writes are serialized.
// ---------------------------------------------------------------------------

let readPoolSize = 4;
const readPool: LadybugConnection[] = [];
let readPoolIndex = 0;

let writeConn: LadybugConnection | null = null;
let writeLimiter: ConcurrencyLimiter | null = null;
let writeQueueTimeoutMs = 30_000;

// Initialization mutex: prevents concurrent callers from double-initializing
// the DB instance or connection pool across async boundaries.
let dbInitPromise: Promise<LadybugDatabase> | null = null;
let poolInitPromise: Promise<void> | null = null;

/**
 * Configure the connection pool parameters.
 * Must be called BEFORE initLadybugDb() for the settings to take effect.
 */
export function configurePool(opts: {
  readPoolSize?: number;
  writeQueueTimeoutMs?: number;
}): void {
  if (readPool.length > 0 || poolInitPromise !== null) {
    throw new DatabaseError(
      "configurePool() must be called before pool initialization (before initLadybugDb or first getLadybugConn call)",
    );
  }
  if (opts.readPoolSize !== undefined) {
    if (opts.readPoolSize < 1 || opts.readPoolSize > 8) {
      throw new DatabaseError(
        `readPoolSize must be between 1 and 8, got ${opts.readPoolSize}`,
      );
    }
    readPoolSize = opts.readPoolSize;
  }
  if (opts.writeQueueTimeoutMs !== undefined) {
    writeQueueTimeoutMs = opts.writeQueueTimeoutMs;
  }
}

async function loadLadybug(): Promise<LadybugModule> {
  if (ladybugModule) {
    return ladybugModule;
  }

  try {
    const imported = await import("kuzu");
    const ladybug = (imported.default ?? imported) as unknown as LadybugModule;
    ladybugModule = ladybug;
    return ladybugModule;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(
      `Graph database driver not available: ${msg}. The 'kuzu' package should be installed automatically as an optional dependency of sdl-mcp (backed by @ladybugdb/core). Try: npm install`,
    );
  }
}

export function resolveLadybugBufferManagerSizeBytes(
  totalMemoryBytes = totalmem(),
  envValue = process.env.SDL_LADYBUG_BUFFER_POOL_BYTES ??
    process.env.SDL_KUZU_BUFFER_POOL_BYTES,
): number {
  const parsedEnvValue = envValue ? Number(envValue) : Number.NaN;
  if (Number.isFinite(parsedEnvValue) && parsedEnvValue >= ONE_GB) {
    return Math.floor(parsedEnvValue);
  }

  const autoSized = Math.floor(totalMemoryBytes * DEFAULT_BUFFER_MANAGER_RATIO);
  return Math.min(Math.max(autoSized, ONE_GB), EIGHT_GB);
}

export async function getLadybugDb(dbPath?: string): Promise<LadybugDatabase> {
  const resolvedPath = dbPath
    ? normalizePath(normalizeGraphDbPath(dbPath))
    : currentDbPath;

  if (!resolvedPath) {
    throw new DatabaseError(
      "LadybugDB not initialized. Call initLadybugDb(dbPath) first.",
    );
  }

  // Fast path: already initialized for this path.
  if (dbInstance && currentDbPath === resolvedPath) {
    return dbInstance;
  }

  // Serialize initialization: if another caller is already opening the DB
  // for this path, await its result instead of double-initializing.
  if (dbInitPromise) {
    const existing = await dbInitPromise;
    if (dbInstance && currentDbPath === resolvedPath) {
      return existing;
    }
  }

  const initFn = async (): Promise<LadybugDatabase> => {
    const modules = await loadLadybug();

    if (dbInstance) {
      logger.warn("LadybugDB path changed, closing existing connection");
      await closeLadybugDb();
    }

    const normalizedPath = normalizePath(resolvedPath);

    const parentDir = dirname(normalizedPath);
    if (parentDir && parentDir !== "." && !existsSync(parentDir)) {
      try {
        mkdirSync(parentDir, { recursive: true });
        logger.debug("Created LadybugDB parent directory", { path: parentDir });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DatabaseError(
          `Failed to create LadybugDB parent directory at ${parentDir}: ${msg}`,
        );
      }
    }

    try {
      const bufferManagerSize = resolveLadybugBufferManagerSizeBytes();
      dbInstance = new modules.Database(
        normalizedPath,
        bufferManagerSize,
        true,
        false,
        0,
        true,
        DEFAULT_CHECKPOINT_THRESHOLD_BYTES,
      );
      currentDbPath = normalizedPath;
      logger.info("LadybugDB database opened", {
        path: normalizedPath,
        bufferManagerSizeBytes: bufferManagerSize,
        checkpointThresholdBytes: DEFAULT_CHECKPOINT_THRESHOLD_BYTES,
      });
      return dbInstance;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(formatReindexGuidanceError(normalizedPath, msg));
    }
  };

  dbInitPromise = initFn();
  try {
    return await dbInitPromise;
  } finally {
    dbInitPromise = null;
  }
}

async function isConnectionHealthy(conn: LadybugConnection): Promise<boolean> {
  try {
    const result = await conn.query("RETURN 1");
    result.close();
    return true;
  } catch {
    return false;
  }
}

async function createConnection(
  db: LadybugDatabase,
): Promise<LadybugConnection> {
  const modules = await loadLadybug();
  const conn = new modules.Connection(db);
  if ("setMaxNumThreadForExec" in conn) {
    await (
      conn as unknown as LadybugConnectionWithThreads
    ).setMaxNumThreadForExec(1);
  }
  return conn;
}

async function getHealthyConnection(
  conn: LadybugConnection,
  db: LadybugDatabase,
  label: string,
): Promise<LadybugConnection> {
  if (await isConnectionHealthy(conn)) {
    return conn;
  }

  logger.warn(`LadybugDB ${label} connection unhealthy, recreating`);
  try {
    await conn.close();
  } catch (closeError) {
    logger.debug(
      `Failed to close unhealthy LadybugDB ${label} connection before recreation`,
      {
        error:
          closeError instanceof Error ? closeError.message : String(closeError),
      },
    );
  }

  return createConnection(db);
}

/**
 * Get a read connection from the pool (round-robin).
 * This is the primary function for read-only queries.
 * Backward-compatible: this is what getLadybugConn() returns.
 */
export async function getLadybugReadConn(): Promise<LadybugConnection> {
  const db = await getLadybugDb();

  // Fast path: pool fully initialized (read + write + limiter all ready).
  if (readPool.length > 0 && writeLimiter !== null) {
    // skip to round-robin below
  } else if (poolInitPromise) {
    // Another caller is initializing the pool — wait for it.
    await poolInitPromise;
  } else {
    // We are the first caller — initialize the pool.
    // Build all connections into locals, then publish atomically so
    // concurrent callers never observe a partially-initialized pool.
    const initPool = async (): Promise<void> => {
      logger.debug(
        `Initializing LadybugDB connection pool: ${readPoolSize} read + 1 write`,
      );

      const localReadPool: LadybugConnection[] = [];

      try {
        // Create read connections into local array
        for (let i = 0; i < readPoolSize; i++) {
          const conn = await createConnection(db);
          localReadPool.push(conn);
        }

        // Create dedicated write connection
        const localWriteConn = await createConnection(db);

        // Create write serializer
        const localWriteLimiter = new ConcurrencyLimiter({
          maxConcurrency: 1,
          queueTimeoutMs: writeQueueTimeoutMs,
        });

        // Publish all refs atomically — no concurrent caller can see
        // partial state because no `await` between these assignments.
        readPool.push(...localReadPool);
        writeConn = localWriteConn;
        writeLimiter = localWriteLimiter;
      } catch (err) {
        // Clean up any partially-created connections before re-throwing
        for (const conn of localReadPool) {
          try {
            await conn.close();
          } catch {
            // Best-effort cleanup
          }
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new DatabaseError(
          `Failed to initialize LadybugDB connection pool: ${msg}`,
        );
      }
    };

    poolInitPromise = initPool();
    try {
      await poolInitPromise;
    } finally {
      poolInitPromise = null;
    }
  }

  // Round-robin selection — return the connection directly without a
  // per-checkout health probe. The previous implementation issued a
  // `RETURN 1` query on every read checkout, doubling read latency.
  // Callers that hit a connection error should retry; the pool will
  // recreate unhealthy connections lazily on demand.
  const idx = readPoolIndex;
  readPoolIndex = (readPoolIndex + 1) % readPool.length;
  return readPool[idx];
}

/**
 * Replace a read-pool connection that was found to be unhealthy.
 * Call this from error-handling paths when a query fails due to a
 * broken connection, to trigger lazy reconnection on the next checkout.
 */
export async function recycleReadConnection(
  unhealthyConn: LadybugConnection,
): Promise<void> {
  const idx = readPool.indexOf(unhealthyConn);
  if (idx === -1) return;

  const db = await getLadybugDb();

  // Re-validate after await: pool may have been closed or the connection
  // may have been recycled by a concurrent caller (H6 TOCTOU guard).
  if (readPool.length === 0 || readPool[idx] !== unhealthyConn) return;

  try {
    await unhealthyConn.close();
  } catch {
    // Best-effort close of broken connection
  }

  // Re-validate again: closeLadybugDb() may have run during the close await
  if (readPool.length === 0) return;

  try {
    readPool[idx] = await createConnection(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to recreate read connection [${idx}]: ${msg}`);
  }
}

/**
 * Backward-compatible alias for getLadybugReadConn().
 * All existing callers (62 files) continue to work unchanged.
 */
export async function getLadybugConn(): Promise<LadybugConnection> {
  return getLadybugReadConn();
}

/**
 * Execute a write operation with serialized access to the write connection.
 * This is the preferred way to perform write operations — it ensures only
 * one write is in-flight at a time via ConcurrencyLimiter(maxConcurrency=1).
 *
 * Health checks are not performed on every call (removed from hot path — H5).
 * Instead, if the write fails due to a broken connection, the connection is
 * recycled and the caller can retry.
 */
export async function withWriteConn<T>(
  fn: (conn: LadybugConnection) => Promise<T>,
): Promise<T> {
  // Ensure pool is initialized
  await getLadybugReadConn();

  if (!writeLimiter || !writeConn) {
    throw new DatabaseError(
      "Write connection not initialized. Call initLadybugDb() first.",
    );
  }

  return writeLimiter.run(async () => {
    try {
      return await fn(writeConn!);
    } catch (err) {
      // On connection-level failure, attempt to recycle the write connection
      // and re-throw so the caller can decide whether to retry.
      try {
        const db = await getLadybugDb();
        const healthy = await getHealthyConnection(writeConn!, db, "write");
        if (healthy !== writeConn) {
          writeConn = healthy;
        }
      } catch {
        // If reconnect also fails, leave writeConn as-is and propagate
        // the original error.
      }
      throw err;
    }
  });
}

/**
 * Get pool statistics for monitoring.
 */
export function getPoolStats(): {
  readPoolSize: number;
  readPoolInitialized: number;
  writeQueued: number;
  writeActive: number;
} {
  const limiterStats = writeLimiter?.getStats() ?? { active: 0, queued: 0 };
  return {
    readPoolSize,
    readPoolInitialized: readPool.length,
    writeQueued: limiterStats.queued,
    writeActive: limiterStats.active,
  };
}

export async function initLadybugDb(dbPath: string): Promise<void> {
  const normalizedPath = normalizePath(normalizeGraphDbPath(dbPath));

  logger.info("Initializing LadybugDB", { path: normalizedPath });

  const parentDir = dirname(normalizedPath);
  if (parentDir && parentDir !== "." && !existsSync(parentDir)) {
    try {
      mkdirSync(parentDir, { recursive: true });
      logger.debug("Created LadybugDB parent directory", { path: parentDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(
        `Failed to create LadybugDB parent directory at ${parentDir}: ${msg}`,
      );
    }
  }

  try {
    await getLadybugDb(normalizedPath);
    // getLadybugConn() triggers pool initialization; use the read conn
    // for the read-only schema version check, but route DDL writes
    // through the write connection for serialization safety (H2).
    const conn = await getLadybugConn();

    await withWriteConn(async (wConn) => {
      await createSchema(wConn);
    });
    const schemaVersion = await getSchemaVersion(conn);
    if (schemaVersion !== LADYBUG_SCHEMA_VERSION) {
      throw new DatabaseError(
        `LadybugDB schema version mismatch: expected ${LADYBUG_SCHEMA_VERSION}, found ${schemaVersion ?? "unknown"}. Rebuild or reindex the graph database with this version of SDL-MCP.`,
      );
    }

    logger.info("LadybugDB schema initialized", { path: normalizedPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(formatReindexGuidanceError(normalizedPath, msg));
  }
}

export async function closeLadybugDb(): Promise<void> {
  // Drain in-flight writes before closing connections. Timeout after 5s
  // to avoid hanging indefinitely if a write is stuck.
  if (writeLimiter) {
    try {
      await Promise.race([
        writeLimiter.drain(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    } catch {
      // Best-effort drain — proceed with teardown regardless
    }

    // Clear queued tasks BEFORE closing connections so that processQueue
    // cannot schedule new tasks against connections we are about to close (H7).
    writeLimiter.clearQueue(
      new DatabaseError("LadybugDB is closing, write queue cleared"),
    );
    writeLimiter = null;
  }

  // Close read pool
  for (const conn of readPool) {
    try {
      await conn.close();
    } catch (err) {
      logger.warn("Error closing LadybugDB read connection", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  readPool.length = 0;
  readPoolIndex = 0;

  // Close write connection
  if (writeConn) {
    try {
      await writeConn.close();
    } catch (err) {
      logger.warn("Error closing LadybugDB write connection", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    writeConn = null;
  }

  if (dbInstance) {
    try {
      await dbInstance.close();
    } catch (err) {
      logger.warn("Error closing LadybugDB database", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    dbInstance = null;
  }

  currentDbPath = null;
  logger.debug("LadybugDB closed");
}

export function isLadybugAvailable(): boolean {
  try {
    require.resolve("kuzu");
    return true;
  } catch {
    return false;
  }
}

export function getLadybugDbPath(): string | null {
  return currentDbPath;
}
