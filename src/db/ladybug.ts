import { existsSync, mkdirSync } from "fs";
import { createRequire } from "node:module";
import { totalmem } from "node:os";
import { dirname } from "path";
import { normalizePath } from "../util/paths.js";
import { logger } from "../util/logger.js";
import { DatabaseError } from "../domain/errors.js";
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

// Connection Pool
// NOTE: Ladybug write transactions are sensitive to concurrent execution across
// connections. Use a single shared connection to avoid write-write conflicts
// during indexing and tool execution.
const MAX_POOL_SIZE = 1;
const connectionPool: LadybugConnection[] = [];
let connectionIndex = 0;

// Initialization mutex: prevents concurrent callers from double-initializing
// the DB instance or connection pool across async boundaries.
let dbInitPromise: Promise<LadybugDatabase> | null = null;
let poolInitPromise: Promise<void> | null = null;

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

export async function getLadybugConn(): Promise<LadybugConnection> {
  const db = await getLadybugDb();

  // Fast path: pool already initialized.
  if (connectionPool.length > 0) {
    // skip to round-robin below
  } else if (poolInitPromise) {
    // Another caller is initializing the pool — wait for it.
    await poolInitPromise;
  } else {
    // We are the first caller — initialize the pool.
    const initPool = async (): Promise<void> => {
      const modules = await loadLadybug();
      logger.debug(
        `Initializing LadybugDB connection pool with ${MAX_POOL_SIZE} connections`,
      );
      for (let i = 0; i < MAX_POOL_SIZE; i++) {
        try {
          const conn = new modules.Connection(db);
          if ("setMaxNumThreadForExec" in conn) {
            await (
              conn as unknown as LadybugConnectionWithThreads
            ).setMaxNumThreadForExec(1);
          }
          connectionPool.push(conn);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new DatabaseError(
            `Failed to create LadybugDB connection: ${msg}`,
          );
        }
      }
    };

    poolInitPromise = initPool();
    try {
      await poolInitPromise;
    } finally {
      poolInitPromise = null;
    }
  }

  // Round-robin selection
  const conn = connectionPool[connectionIndex];
  connectionIndex = (connectionIndex + 1) % connectionPool.length;

  if (!(await isConnectionHealthy(conn))) {
    logger.warn(
      `LadybugDB connection ${connectionIndex} unhealthy, recreating`,
    );
    try {
      await conn.close();
    } catch (closeError) {
      logger.debug(
        "Failed to close unhealthy LadybugDB connection before recreation",
        {
          error:
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
        },
      );
    }

    const modules = await loadLadybug();
    const newConn = new modules.Connection(db);
    if ("setMaxNumThreadForExec" in newConn) {
      await (
        newConn as unknown as LadybugConnectionWithThreads
      ).setMaxNumThreadForExec(1);
    }
    connectionPool[
      connectionIndex === 0 ? connectionPool.length - 1 : connectionIndex - 1
    ] = newConn;
    return newConn;
  }

  return conn;
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
    const conn = await getLadybugConn();

    await createSchema(conn);
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
  for (const conn of connectionPool) {
    try {
      await conn.close();
    } catch (err) {
      logger.warn("Error closing LadybugDB connection", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  connectionPool.length = 0;
  connectionIndex = 0;

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
