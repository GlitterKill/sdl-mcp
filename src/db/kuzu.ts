import { existsSync, mkdirSync } from "fs";
import { createRequire } from "node:module";
import { dirname } from "path";
import { normalizePath } from "../util/paths.js";
import { logger } from "../util/logger.js";
import { DatabaseError } from "../mcp/errors.js";
import { createSchema } from "./kuzu-schema.js";

type KuzuModule = typeof import("kuzu");
type KuzuDatabase = import("kuzu").Database;
type KuzuConnection = import("kuzu").Connection;

const require = createRequire(import.meta.url);

let kuzuModule: KuzuModule | null = null;
let dbInstance: KuzuDatabase | null = null;
let currentDbPath: string | null = null;

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

export async function getKuzuDb(dbPath?: string): Promise<KuzuDatabase> {
  const modules = await loadKuzu();

  const resolvedPath = dbPath ? normalizePath(dbPath) : currentDbPath;

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

  if (!existsSync(normalizedPath)) {
    try {
      mkdirSync(normalizedPath, { recursive: true });
      logger.debug("Created KuzuDB directory", { path: normalizedPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(
        `Failed to create KuzuDB directory at ${normalizedPath}: ${msg}`,
      );
    }
  }

  try {
    // Pass memory limit as second argument. Kuzu uses ~80% of system memory by default.
    // Constrain the buffer pool to 1GB to prevent the Node process from OOMing on large repos.
    const ONE_GB = 1024 * 1024 * 1024;
    dbInstance = new modules.Database(normalizedPath, ONE_GB);
    currentDbPath = normalizedPath;
    logger.info("KuzuDB database opened", { path: normalizedPath });
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
        if (typeof (conn as any).setMaxNumThreadForExec === 'function') {
           await (conn as any).setMaxNumThreadForExec(1);
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
    try { await conn.close(); } catch {}
    
    const modules = await loadKuzu();
    const newConn = new modules.Connection(db);
    if (typeof (newConn as any).setMaxNumThreadForExec === 'function') {
        await (newConn as any).setMaxNumThreadForExec(1);
    }
    connectionPool[connectionIndex === 0 ? connectionPool.length - 1 : connectionIndex - 1] = newConn;
    return newConn;
  }
  
  return conn;
}

export async function initKuzuDb(dbPath: string): Promise<void> {
  const normalizedPath = normalizePath(dbPath);

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
