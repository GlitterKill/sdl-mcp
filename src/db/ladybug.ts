import { existsSync, mkdirSync } from "fs";
import { createRequire } from "node:module";
import { totalmem } from "node:os";
import { dirname } from "path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { normalizePath } from "../util/paths.js";
import { logger } from "../util/logger.js";
import { loadConfig } from "../config/loadConfig.js";
import { DatabaseError } from "../domain/errors.js";
import { ConcurrencyLimiter } from "../util/concurrency.js";
import {
  markExtensionLoaded,
  getExtensionCapabilities as getExtCaps,
  resetExtensionCapabilities,
} from "./extension-caps.js";
import { normalizeGraphDbPath } from "./graph-db-path.js";
import {
  createBaseSchema,
  createSecondaryIndexes,
  getSchemaVersion,
  migrateVecColumnsToFixedSize,
} from "./ladybug-schema.js";
import { LADYBUG_SCHEMA_VERSION, migrations } from "./migrations/index.js";
import { runPendingMigrations } from "./migration-runner.js";
import {
  clearConnectionPoisoned,
  clearPreparedStatementCache,
  drainConnMutex,
  isConnectionPoisoned,
} from "./ladybug-core.js";
import { resetJoinHintCache } from "./ladybug-edges.js";

// ---------------------------------------------------------------------------
// Close Hooks — allows external modules (e.g. indexer caches) to register
// cleanup callbacks without the db/ layer importing from them (hexagonal).
// ---------------------------------------------------------------------------
const closeHooks: Array<() => void> = [];

/**
 * Register a callback to be invoked when the database is closed.
 * This enables external modules (e.g. indexer caches) to hook into
 * DB teardown without creating a circular import from db/ -> indexer/.
 */
export function registerDbCloseHook(fn: () => void): void {
  closeHooks.push(fn);
}

// ---------------------------------------------------------------------------
// Extension Capabilities
// ---------------------------------------------------------------------------
// Track which Kuzu extensions (fts, vector) loaded successfully.
// INSTALL is attempted once per pool initialization; LOAD is attempted per
// connection. Failures are best-effort — they never block DB initialization.
// State lives in extension-caps.ts to break circular imports.
// ---------------------------------------------------------------------------

/** Names of Kuzu extensions managed by this module. */
const MANAGED_EXTENSIONS = ["fts", "vector"] as const;

// Set to true once INSTALL has been attempted for the pool lifetime.
let extensionsInstallAttempted = false;

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
const FOUR_GB = 4 * ONE_GB;
// 25% of system RAM (was 50%/8GB cap; reduced to avoid OOM when SCIP
// auto-ingest runs immediately after index refresh on ≤16GB systems).
const DEFAULT_BUFFER_MANAGER_RATIO = 0.25;
const DEFAULT_CHECKPOINT_THRESHOLD_BYTES = 128 * 1024 * 1024;

function formatReindexGuidanceError(dbPath: string, msg: string): string {
  logger.error("Database initialization failed", { dbPath, error: msg });
  const isWalCorruption =
    msg.includes("WAL") || msg.includes("wal") || msg.includes("corrupt");
  const isLockError = msg.includes("lock") || msg.includes("EBUSY");

  let guidance = `LadybugDB initialization failed at ${dbPath}: ${msg}. `;

  if (isWalCorruption) {
    guidance +=
      "\n\nThis appears to be a WAL (write-ahead log) corruption issue. " +
      "To recover:\n" +
      "  1. Stop any running SDL-MCP processes\n" +
      `  2. Delete the database file: ${dbPath}\n` +
      "  3. Re-index all repositories: sdl-mcp index\n" +
      "  4. Semantic embeddings will be recomputed during the next index refresh.";
  } else if (isLockError) {
    guidance +=
      "\n\nThe database file appears to be locked by another process. " +
      "Check for other SDL-MCP instances and stop them before retrying.";
  } else {
    guidance +=
      "\nIf the database is corrupted, delete it and re-run indexing with: sdl-mcp index. " +
      "Semantic embeddings are derived artifacts and will be recomputed.";
  }

  return guidance;
}

// ---------------------------------------------------------------------------
// Connection Pool — Read/Write Separation
// ---------------------------------------------------------------------------
// LadybugDB supports multiple Connection objects from a single Database
// instance for concurrent queries within one process.
//
// Read pool: N connections (default 4, configurable) for concurrent reads.
// Write conn: 1 dedicated connection, serialized via ConcurrencyLimiter.
// ---------------------------------------------------------------------------

let readPoolSize = 4;
const readPool: LadybugConnection[] = [];
let readPoolIndex = 0;

let writeConn: LadybugConnection | null = null;
let writeLimiter: ConcurrencyLimiter | null = null;
let writeQueueTimeoutMs = 30_000;

let deferredIndexesPending = false;
let vecMigrationDone = false;

// Per-slot recycling guard: prevents concurrent recycling of the same pool slot (TOCTOU).
const recyclingSlots = new Set<number>();

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
    // No-op if the requested settings match the current values (M6).
    // Note: readPoolSize / writeQueueTimeoutMs hold their defaults (4 / 30000)
    // until configurePool() is called. If the pool was initialized via
    // initLadybugDb() without a prior configurePool() call, and a subsequent
    // configurePool({ readPoolSize: 4 }) arrives, this will silently no-op
    // because the defaults happen to match — which is the intended behavior.
    const sameReadSize =
      opts.readPoolSize === undefined || opts.readPoolSize === readPoolSize;
    const sameTimeout =
      opts.writeQueueTimeoutMs === undefined ||
      opts.writeQueueTimeoutMs === writeQueueTimeoutMs;
    if (sameReadSize && sameTimeout) {
      return; // Already initialized with same settings
    }
    throw new DatabaseError(
      "configurePool() must be called before pool initialization (before initLadybugDb or first getLadybugConn call)",
    );
  }
  if (opts.readPoolSize !== undefined) {
    if (opts.readPoolSize < 1 || opts.readPoolSize > 16) {
      throw new DatabaseError(
        `readPoolSize must be between 1 and 16, got ${opts.readPoolSize}`,
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
  return Math.min(Math.max(autoSized, ONE_GB), FOUR_GB);
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
  if (!isConnectionPoisoned(conn) && (await isConnectionHealthy(conn))) {
    return conn;
  }

  logger.warn(
    `LadybugDB ${label} connection unhealthy or poisoned, recreating`,
  );
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
  } finally {
    clearConnectionPoisoned(conn);
  }

  return createConnection(db);
}

/**
 * Attempt to INSTALL extensions once per pool lifetime (best-effort).
 * Called during pool initialization with the write connection.
 */
async function installExtensionsOnce(conn: LadybugConnection): Promise<void> {
  if (extensionsInstallAttempted) return;
  extensionsInstallAttempted = true;

  for (const ext of MANAGED_EXTENSIONS) {
    try {
      const result = await conn.query(`INSTALL ${ext}`);
      if (Array.isArray(result)) {
        for (const r of result) r.close();
      } else {
        result.close();
      }
      logger.debug(`Kuzu extension installed`, { extension: ext });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`Kuzu extension INSTALL skipped (best-effort)`, {
        extension: ext,
        reason: msg,
      });
    }
  }
}

/**
 * Attempt to LOAD extensions on a connection (best-effort, per-session).
 * Marks each successfully loaded extension via markExtensionLoaded().
 */
async function loadExtensionsOnConnection(
  conn: LadybugConnection,
): Promise<void> {
  for (const ext of MANAGED_EXTENSIONS) {
    try {
      const result = await conn.query(`LOAD EXTENSION ${ext}`);
      if (Array.isArray(result)) {
        for (const r of result) r.close();
      } else {
        result.close();
      }
      markExtensionLoaded(ext);
      logger.debug(`Kuzu extension loaded`, { extension: ext });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Kuzu extension LOAD failed`, {
        extension: ext,
        reason: msg,
      });
    }
  }
}

/**
 * Force a WAL checkpoint on the given write connection (best-effort).
 *
 * Workaround for LadybugDB 0.15.2 native crash: `LOAD EXTENSION fts` can hit
 * `UNREACHABLE_CODE` in `wal_record.cpp:76` when the WAL has uncheckpointed
 * records. Forcing CHECKPOINT before LOAD (and on graceful shutdown) keeps
 * the WAL empty so the extension's replay path never runs.
 *
 * Failures are logged and swallowed — CHECKPOINT must never block DB init
 * or shutdown.
 */
async function checkpointWal(
  conn: LadybugConnection,
  phase: string,
): Promise<boolean> {
  try {
    const result = await conn.query("CHECKPOINT");
    if (Array.isArray(result)) {
      for (const r of result) r.close();
    } else {
      result.close();
    }
    logger.debug(`LadybugDB CHECKPOINT completed`, { phase });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`LadybugDB CHECKPOINT failed (best-effort)`, {
      phase,
      reason: msg,
    });
    return false;
  }
}

/**
 * Force a WAL checkpoint before starting a large indexing run.
 *
 * Runs through `withWriteConn` so the checkpoint is serialized against any
 * other in-flight writes by the global write-exec mutex. Read-pool callers
 * use separate connections and cannot interleave. All failures are swallowed
 * — the checkpoint is a best-effort safety measure; indexing will proceed
 * even if the WAL flush fails.
 *
 * This is the public entry point the indexer uses; `checkpointWal` remains
 * private and is used only during pool init and shutdown.
 */
export async function preIndexCheckpoint(): Promise<void> {
  // Skip if the pool isn't ready — indexer may be driving an init path.
  if (!writeConn) return;

  // Race with a short timeout. If another writer holds the mutex (e.g. a
  // deferred derived-refresh still in flight), we do NOT want to block
  // indexing for ~minutes waiting for CHECKPOINT. Checkpoint is purely a
  // best-effort WAL flush; skipping it is always safe.
  const PRE_INDEX_CHECKPOINT_TIMEOUT_MS = 2_000;
  try {
    const work = withWriteConn(async (conn) => {
      await checkpointWal(conn, "pre-index");
    });
    const timeout = new Promise<"timeout">((resolve) => {
      const t = setTimeout(
        () => resolve("timeout"),
        PRE_INDEX_CHECKPOINT_TIMEOUT_MS,
      );
      t.unref?.();
    });
    const winner = await Promise.race([
      work.then(() => "ok" as const),
      timeout,
    ]);
    if (winner === "timeout") {
      logger.debug("preIndexCheckpoint skipped (write mutex busy)", {
        timeoutMs: PRE_INDEX_CHECKPOINT_TIMEOUT_MS,
      });
      // Let the checkpoint finish in the background; swallow any error.
      work.catch(() => {});
    }
  } catch (err) {
    // withWriteConn can throw on poisoned pool — non-fatal for indexing.
    logger.debug("preIndexCheckpoint skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

        // Create single write connection
        const localWriteConn = await createConnection(db);

        // Write limiter — serializes all write operations through the single
        // write connection (LadybugDB allows only ONE write transaction at a time).
        const localWriteLimiter = new ConcurrencyLimiter({
          maxConcurrency: 1,
          queueTimeoutMs: writeQueueTimeoutMs,
        });

        // Step: attempt INSTALL once, then LOAD on write + all read conns.
        // Best-effort — failures must not prevent pool initialization.
        await installExtensionsOnce(localWriteConn);
        // Force a CHECKPOINT before LOAD EXTENSION to drain any uncheckpointed
        // WAL records. Kuzu 0.15.2 `fts` extension hits UNREACHABLE_CODE in
        // wal_record.cpp:76 when parsing a dirty WAL on LOAD — aborting the
        // process mid-session. Ensuring an empty WAL sidesteps that path.
        //
        // If the CHECKPOINT itself fails (e.g. the WAL already contains
        // unrecognizable records from a previous crash), skip LOAD EXTENSION
        // entirely — loading extensions on a dirty WAL triggers a native
        // abort() that kills the process. The pool operates without FTS
        // until the next clean startup.
        const walClean = await checkpointWal(
          localWriteConn,
          "pre-extension-load",
        );
        if (walClean) {
          for (const c of [localWriteConn, ...localReadPool]) {
            await loadExtensionsOnConnection(c);
          }
        } else {
          logger.warn(
            "Skipping LOAD EXTENSION — WAL is dirty and cannot be checkpointed. " +
              "FTS will be unavailable until the WAL is resolved. " +
              "Try stopping all processes using this DB and restarting.",
          );
        }

        // Log extension capabilities after INSTALL+LOAD phase
        logger.info(`LadybugDB extension capabilities after pool init`, {
          ...getExtCaps(),
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

  // Per-slot recycling guard: if another caller is already recycling this
  // slot, bail out to prevent double-close / double-create races.
  if (recyclingSlots.has(idx)) return;
  recyclingSlots.add(idx);

  try {
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
  } finally {
    recyclingSlots.delete(idx);
  }
}

/**
 * Backward-compatible alias for getLadybugReadConn().
 * All existing callers (62 files) continue to work unchanged.
 */
export async function getLadybugConn(): Promise<LadybugConnection> {
  return getLadybugReadConn();
}

export async function withWriteConn<T>(
  fn: (conn: LadybugConnection) => Promise<T>,
): Promise<T> {
  await getLadybugReadConn();
  if (!writeLimiter || !writeConn) {
    throw new DatabaseError(
      "Write connection not initialized. Call initLadybugDb() first.",
    );
  }
  return writeLimiter.run(async () => {
    const conn = writeConn;
    if (!conn) {
      throw new DatabaseError(
        "Write connection was closed during queue wait. Server may be shutting down.",
      );
    }
    try {
      return await fn(conn);
    } catch (err) {
      try {
        const db = await getLadybugDb();
        const healthy = await getHealthyConnection(conn, db, "write");
        if (healthy !== conn) writeConn = healthy;
      } catch {}
      throw err;
    }
  });
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

  let freshlyCreated = false;

  try {
    // Step 1: Open database and initialize connection pool
    await getLadybugDb(normalizedPath);
    await getLadybugConn(); // triggers pool init

    // Step 2: Read current schema version (may throw if table doesn't exist)
    let currentVersion: number | null = null;
    try {
      const conn = await getLadybugConn();
      currentVersion = await getSchemaVersion(conn);
    } catch {
      // SchemaVersion table does not exist — fresh database
      currentVersion = null;
    }

    if (currentVersion === null) {
      // Fresh DB (SchemaVersion table missing) or corrupted (table exists, no row).
      // Run createSchema() to set up everything at latest version.
      freshlyCreated = true;
      deferredIndexesPending = true;
      logger.info(
        "Fresh database detected, creating base schema (indexes deferred)",
        {
          version: LADYBUG_SCHEMA_VERSION,
        },
      );
      await withWriteConn(async (wConn) => {
        await createBaseSchema(wConn);
      });
    } else if (currentVersion < LADYBUG_SCHEMA_VERSION) {
      // Existing DB needs migration — capture version in const for TS narrowing
      const dbVersion = currentVersion;
      await withWriteConn(async (wConn) => {
        await runPendingMigrations(wConn, dbVersion, migrations);
      });
      // Clear prepared statement cache on read pool connections too
      for (const conn of getReadPool()) {
        clearPreparedStatementCache(conn);
      }
    } else if (currentVersion > LADYBUG_SCHEMA_VERSION) {
      // DB is newer than code — best-effort
      logger.warn("Database schema is newer than this version of SDL-MCP", {
        dbVersion: currentVersion,
        codeVersion: LADYBUG_SCHEMA_VERSION,
        message: "Running in best-effort mode",
      });
    }
    // else: currentVersion === LADYBUG_SCHEMA_VERSION — no-op

    // Step 3: Bootstrap retrieval indexes (FTS + vector) if extensions are available
    if (freshlyCreated) {
      logger.info(
        "Deferring retrieval index bootstrap until after first full index",
      );
    } else
      try {
        const sdlConfig = loadConfig();
        const semanticConfig = sdlConfig.semantic;
        if (semanticConfig?.enabled && semanticConfig.retrieval) {
          const indexConn = await getLadybugConn();
          // Migrate DOUBLE[] → DOUBLE[N] for vector indexing (existing DBs)
          // Only migrate vec columns on existing DBs — fresh DBs already have DOUBLE[N].
          // ALTER TABLE DROP+ADD corrupts Kuzu's column cache for the current process.
          if (!freshlyCreated && !vecMigrationDone) {
            await migrateVecColumnsToFixedSize(indexConn);
            vecMigrationDone = true;
          }
          // Get a fresh connection after DDL changes to avoid stale column cache

          // Dynamic import to break circular dependency (ladybug ↔ index-lifecycle).
          const { ensureIndexes, ensureEntityIndexes } =
            await import("../retrieval/index-lifecycle.js");
          const indexResult = await ensureIndexes(
            indexConn,
            semanticConfig.retrieval,
          );
          const entityResult = await ensureEntityIndexes(indexConn);
          logger.info("Retrieval indexes bootstrapped", {
            created: [...indexResult.created, ...entityResult.created],
            skipped: [...indexResult.skipped, ...entityResult.skipped],
            failed: [...indexResult.failed, ...entityResult.failed],
          });
        } else {
          logger.debug(
            "Semantic retrieval not enabled, skipping index bootstrap",
          );
        }
      } catch (indexErr) {
        // Index bootstrap failure should not block DB init
        logger.warn(
          `[ladybug] Retrieval index bootstrap failed (non-fatal): ${
            indexErr instanceof Error ? indexErr.message : String(indexErr)
          }`,
        );
      }

    // Confirm final state
    const finalConn = await getLadybugConn();
    const finalVersion = await getSchemaVersion(finalConn);
    logger.info("LadybugDB schema initialized", {
      path: normalizedPath,
      schemaVersion: finalVersion,
    });
  } catch (err) {
    if (err instanceof DatabaseError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(formatReindexGuidanceError(normalizedPath, msg));
  }
}

/**
 * Close all LadybugDB connections and the database instance.
 *
 * **Important (Windows / kuzu 0.15.2):** After this function returns, the
 * process MUST call `process.exit()` before the event loop drains naturally.
 * kuzu's N-API destructor on closed Connection/Database objects segfaults
 * during V8's at-exit GC sweep. All known callers (ShutdownManager, CLI
 * commands, stress-test harness) already call `process.exit()` after cleanup.
 */
export function hasDeferredIndexes(): boolean {
  return deferredIndexesPending;
}

export async function buildDeferredIndexes(): Promise<void> {
  if (!deferredIndexesPending) return;

  const startMs = Date.now();
  logger.info("Building deferred secondary indexes after fresh load");

  await withWriteConn(async (wConn) => {
    await createSecondaryIndexes(wConn);
  });

  try {
    const sdlConfig = loadConfig();
    const semanticConfig = sdlConfig.semantic;
    if (semanticConfig?.enabled && semanticConfig.retrieval) {
      const indexConn = await getLadybugConn();
      const { ensureIndexes, ensureEntityIndexes } =
        await import("../retrieval/index-lifecycle.js");
      await ensureIndexes(indexConn, semanticConfig.retrieval);
      await ensureEntityIndexes(indexConn);
    }
  } catch (err) {
    logger.warn(
      `Deferred retrieval index build failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  deferredIndexesPending = false;
  logger.info("Deferred indexes built", { durationMs: Date.now() - startMs });
}

export async function closeLadybugDb(): Promise<void> {
  // Drain in-flight writes before closing connections. Timeout after 5s
  // to avoid hanging indefinitely if a write is stuck.
  if (writeLimiter) {
    try {
      let timeoutHandle: NodeJS.Timeout | undefined;
      await Promise.race([
        writeLimiter.drain(),
        new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(resolve, 5_000);
          timeoutHandle.unref();
        }),
      ]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
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

  // Drain per-connection execution mutexes before tearing down the pools.
  const shutdownError = new DatabaseError(
    "LadybugDB is closing, per-conn queue cleared",
  );
  for (const conn of readPool) {
    try {
      await drainConnMutex(conn, 5_000, shutdownError);
    } catch {
      // Best-effort drain — proceed with teardown regardless
    }
  }

  await flushStaleFinalizers();

  // Synchronously capture and clear the read pool so concurrent readers
  // immediately see "not initialized" instead of accessing closing connections.
  const poolSnapshot = [...readPool];
  readPool.length = 0;
  readPoolIndex = 0;
  recyclingSlots.clear();

  // Close captured read connections
  for (const conn of poolSnapshot) {
    try {
      await conn.close();
    } catch (err) {
      logger.warn("Error closing LadybugDB read connection", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Close write connection
  if (writeConn) {
    // Force CHECKPOINT on the way out so the next startup opens a clean WAL.
    // Prevents the Kuzu 0.15.2 UNREACHABLE_CODE crash in wal_record.cpp:76
    // when `LOAD EXTENSION fts` replays an uncheckpointed WAL.
    await checkpointWal(writeConn, "pre-close");
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
  deferredIndexesPending = false;
  extensionsInstallAttempted = false;
  resetExtensionCapabilities();
  resetJoinHintCache();
  for (const hook of closeHooks) {
    try {
      hook();
    } catch (err) {
      logger.warn("Error in DB close hook", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  closeHooks.length = 0;
  logger.debug("LadybugDB closed");
}

/**
 * Return current connection pool statistics (read pool size, initialized
 * connections, and write-limiter queue depth).  Safe to call before or
 * after initialization.
 */
export function getPoolStats(): {
  readPoolSize: number;
  readPoolInitialized: number;
  writeInitialized: boolean;
  writeQueued: number;
  writeActive: number;
} {
  const writeStats = writeLimiter?.getStats() ?? { active: 0, queued: 0 };
  return {
    readPoolSize,
    readPoolInitialized: readPool.length,
    writeInitialized: writeConn !== null,
    writeQueued: writeStats.queued,
    writeActive: writeStats.active,
  };
}

/**
 * Return all read pool connections. Used by the migration runner
 * to clear prepared statement caches after DDL changes.
 */
export function getReadPool(): readonly import("kuzu").Connection[] {
  return readPool;
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

/**
 * Ensure `globalThis.gc` is available by enabling `--expose-gc` at runtime.
 * Idempotent — only runs the V8 flag + vm bootstrap once.
 */
let gcExposed = typeof globalThis.gc === "function";
function ensureGcExposed(): void {
  if (gcExposed) return;
  try {
    setFlagsFromString("--expose-gc");
    globalThis.gc = runInNewContext("gc") as typeof globalThis.gc;
    gcExposed = true;
  } catch {
    // Non-fatal — flushStaleFinalizers degrades to a no-op
  }
}

/**
 * Flush stale LadybugDB QueryResult N-API pointers by forcing a GC cycle.
 *
 * LadybugDB (kuzu 0.15.2) C++ destructors can hit freed memory (0xC0000005)
 * when V8 finalizes QueryResult pointers at unpredictable times. Call this
 * before heavy napi allocations (e.g. SCIP decoder document iteration) to
 * finalize stale pointers while connections are still alive.
 */
export async function flushStaleFinalizers(): Promise<void> {
  ensureGcExposed();
  if (typeof globalThis.gc === "function") {
    logger.debug("Flushing stale N-API finalizers via forced GC");
    globalThis.gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// Re-export for backward compatibility — canonical home is extension-caps.ts.
export { getExtensionCapabilities } from "./extension-caps.js";
