import { existsSync, mkdirSync } from "fs";
import { createRequire } from "node:module";
import { totalmem } from "node:os";
import { dirname } from "path";
import { normalizePath } from "../util/paths.js";
import { logger } from "../util/logger.js";
import { DatabaseError } from "../mcp/errors.js";
import { normalizeGraphDbPath } from "./graph-db-path.js";
import {
  createSchema,
  getSchemaVersion,
  KUZU_SCHEMA_VERSION,
} from "./kuzu-schema.js";

// Local interface for optional thread-count method on KuzuDB connections
interface KuzuConnectionWithThreads {
  setMaxNumThreadForExec(n: number): Promise<void>;
}

type KuzuModule = typeof import("kuzu");
type KuzuDatabase = import("kuzu").Database;
type KuzuConnection = import("kuzu").Connection;

const require = createRequire(import.meta.url);

let kuzuModule: KuzuModule | null = null;
let dbInstance: KuzuDatabase | null = null;
let currentDbPath: string | null = null;

const ONE_GB = 1024 * 1024 * 1024;
const EIGHT_GB = 8 * ONE_GB;
const DEFAULT_BUFFER_MANAGER_RATIO = 0.5;
const DEFAULT_CHECKPOINT_THRESHOLD_BYTES = 128 * 1024 * 1024;

// Connection Pool
// NOTE: Kuzu write transactions are sensitive to concurrent execution across
// connections. Use a single shared connection to avoid write-write conflicts
// during indexing and tool execution.
const MAX_POOL_SIZE = 1;
const connectionPool: KuzuConnection[] = [];
let connectionIndex = 0;

async function loadKuzu(): Promise<KuzuModule> {
  if (kuzuModule) {
    return kuzuModule;
  }

  try {
    const imported = await import("kuzu");
    const kuzu = (imported.default ?? imported) as unknown as KuzuModule;
    kuzuModule = kuzu;
    return kuzuModule;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(
      `KuzuDB not available: ${msg}. Install with: npm install kuzu`,
    );
  }
}

export function resolveKuzuBufferManagerSizeBytes(
  totalMemoryBytes = totalmem(),
  envValue = process.env.SDL_KUZU_BUFFER_POOL_BYTES,
): number {
  const parsedEnvValue = envValue ? Number(envValue) : Number.NaN;
  if (Number.isFinite(parsedEnvValue) && parsedEnvValue >= ONE_GB) {
    return Math.floor(parsedEnvValue);
  }

  const autoSized = Math.floor(totalMemoryBytes * DEFAULT_BUFFER_MANAGER_RATIO);
  return Math.min(Math.max(autoSized, ONE_GB), EIGHT_GB);
}

export async function getKuzuDb(dbPath?: string): Promise<KuzuDatabase> {
  const modules = await loadKuzu();

  const resolvedPath = dbPath
    ? normalizePath(normalizeGraphDbPath(dbPath))
    : currentDbPath;

  if (!resolvedPath) {
    throw new DatabaseError(
      "KuzuDB not initialized. Call initKuzuDb(dbPath) first.",
    );
  }

  if (dbInstance && currentDbPath === resolvedPath) {
    return dbInstance;
  }

  if (dbInstance) {
    logger.warn("KuzuDB path changed, closing existing connection");
    await closeKuzuDb();
  }

  const normalizedPath = normalizePath(resolvedPath);

  const parentDir = dirname(normalizedPath);
  if (parentDir && parentDir !== "." && !existsSync(parentDir)) {
    try {
      mkdirSync(parentDir, { recursive: true });
      logger.debug("Created KuzuDB parent directory", { path: parentDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(
        `Failed to create KuzuDB parent directory at ${parentDir}: ${msg}`,
      );
    }
  }

  try {
    const bufferManagerSize = resolveKuzuBufferManagerSizeBytes();
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
    logger.info("KuzuDB database opened", {
      path: normalizedPath,
      bufferManagerSizeBytes: bufferManagerSize,
      checkpointThresholdBytes: DEFAULT_CHECKPOINT_THRESHOLD_BYTES,
    });
    return dbInstance;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(
      `Failed to open KuzuDB at ${normalizedPath}: ${msg}`,
    );
  }
}

async function isConnectionHealthy(conn: KuzuConnection): Promise<boolean> {
  try {
    const result = await conn.query("RETURN 1");
    if (Array.isArray(result)) {
      for (const r of result) r.close();
    } else {
      result.close();
    }
    return true;
  } catch {
    return false;
  }
}

export async function getKuzuConn(): Promise<KuzuConnection> {
  const db = await getKuzuDb();
  
  if (connectionPool.length === 0) {
    const modules = await loadKuzu();
    logger.debug(`Initializing KuzuDB connection pool with ${MAX_POOL_SIZE} connections`);
    for (let i = 0; i < MAX_POOL_SIZE; i++) {
      try {
        const conn = new modules.Connection(db);
        if ('setMaxNumThreadForExec' in conn) {
           await (conn as unknown as KuzuConnectionWithThreads).setMaxNumThreadForExec(1);
        }
        connectionPool.push(conn);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DatabaseError(`Failed to create KuzuDB connection: ${msg}`);
      }
    }
  }

  // Round-robin selection
  const conn = connectionPool[connectionIndex];
  connectionIndex = (connectionIndex + 1) % connectionPool.length;
  
  if (!(await isConnectionHealthy(conn))) {
    logger.warn(`KuzuDB connection ${connectionIndex} unhealthy, recreating`);
    try {
      await conn.close();
    } catch (closeError) {
      logger.debug("Failed to close unhealthy KuzuDB connection before recreation", {
        error: closeError instanceof Error ? closeError.message : String(closeError),
      });
    }
    
    const modules = await loadKuzu();
    const newConn = new modules.Connection(db);
    if ('setMaxNumThreadForExec' in newConn) {
        await (newConn as unknown as KuzuConnectionWithThreads).setMaxNumThreadForExec(1);
    }
    connectionPool[connectionIndex === 0 ? connectionPool.length - 1 : connectionIndex - 1] = newConn;
    return newConn;
  }
  
  return conn;
}

export async function initKuzuDb(dbPath: string): Promise<void> {
  const normalizedPath = normalizePath(normalizeGraphDbPath(dbPath));

  logger.info("Initializing KuzuDB", { path: normalizedPath });

  const parentDir = dirname(normalizedPath);
  if (parentDir && parentDir !== "." && !existsSync(parentDir)) {
    try {
      mkdirSync(parentDir, { recursive: true });
      logger.debug("Created KuzuDB parent directory", { path: parentDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(
        `Failed to create KuzuDB parent directory at ${parentDir}: ${msg}`,
      );
    }
  }

  await getKuzuDb(normalizedPath);
  const conn = await getKuzuConn();

  try {
    await createSchema(conn);
    const schemaVersion = await getSchemaVersion(conn);
    if (schemaVersion !== KUZU_SCHEMA_VERSION) {
      throw new DatabaseError(
        `KuzuDB schema version mismatch: expected ${KUZU_SCHEMA_VERSION}, found ${schemaVersion ?? "unknown"}. Rebuild or reindex the graph database with this version of SDL-MCP.`,
      );
    }

    logger.info("KuzuDB schema initialized", { path: normalizedPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(`Failed to initialize KuzuDB schema: ${msg}`);
  }
}

export async function closeKuzuDb(): Promise<void> {
  for (const conn of connectionPool) {
    try {
      await conn.close();
    } catch (err) {
      logger.warn("Error closing KuzuDB connection", {
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
      logger.warn("Error closing KuzuDB database", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    dbInstance = null;
  }

  currentDbPath = null;
  logger.debug("KuzuDB closed");
}

export function isKuzuAvailable(): boolean {
  try {
    require.resolve("kuzu");
    return true;
  } catch {
    return false;
  }
}

export function getKuzuDbPath(): string | null {
  return currentDbPath;
}
