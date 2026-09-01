import { existsSync, mkdirSync, renameSync } from "fs";
import { createRequire } from "node:module";
import { totalmem } from "node:os";
import { dirname } from "path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { normalizePath } from "../util/paths.js";
import { logger } from "../util/logger.js";
import { loadConfig } from "../config/loadConfig.js";
import { DB_SHUTDOWN_DRAIN_TIMEOUT_MS } from "../config/constants.js";
import { DatabaseError } from "../domain/errors.js";
import { ConcurrencyLimiter } from "../util/concurrency.js";
import {
  markExtensionLoaded,
  markExtensionUnavailable,
  getExtensionCapabilities as getExtCaps,
  resetExtensionCapabilities,
} from "./extension-caps.js";
import { normalizeGraphDbPath } from "./graph-db-path.js";
import {
  abandonLadybugFamily,
  acquireNormalLadybugFamily,
  acquireQualificationLadybugCloneFamily,
  acquireValidatedLadybugCloneFamily,
  finalizeNormalLadybugFamilyClose,
  finalizeSafeRebuildLadybugFamily,
  finalizeValidatedLadybugCloneFamily,
  hasPendingLadybugFamilyLeaseCleanup,
  reserveSafeRebuildLadybugFamily,
  retryPendingLadybugFamilyLeaseCleanup,
  sealSafeRebuildFamilyForReopen,
  verifySafeRebuildFamilyBeforeReopen,
  type LadybugFamilyLease,
  type LadybugLineageDriver,
  type QualificationLadybugCloneCapability,
} from "./ladybug-lineage.js";
import type { VerifiedLadybugFamilyCopy } from "./ladybug-family-files.js";
import {
  isWindowsFtsRuntimeUnavailable,
  withWindowsFtsRuntime,
} from "./ladybug-windows-fts-runtime.js";
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
  exec,
  execCheckpoint,
  execDdl,
  drainConnMutex,
  isConnectionPoisoned,
  isConnStuck,
} from "./ladybug-core.js";
import {
  createManagedLadybugDatabase,
  hasPendingShadowLadybugDatabaseCleanup,
  retryPendingShadowLadybugDatabaseCleanup,
} from "./ladybug-database-lifecycle.js";
import {
  bindCurrentLadybugOperation,
  getCurrentLadybugOperationMode,
  queueExclusiveLadybugOperation,
  withExclusiveLadybugOperation,
  withLadybugCloseOperation,
  withLadybugInitialization,
  withSharedLadybugOperation,
} from "./ladybug-operation-gate.js";
import { resetJoinHintCache } from "./ladybug-edges.js";
import {
  configureWriteConnAcquirer,
  getActivePostIndexSession,
  getCurrentSession,
} from "./write-session.js";

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
const MANAGED_EXTENSIONS = ["fts", "vector", "algo"] as const;

// Set to true once INSTALL has been attempted for the pool lifetime.
let extensionsInstallAttempted = false;

// Local interface for optional thread-count method on LadybugDB connections
interface LadybugConnectionWithThreads {
  setMaxNumThreadForExec(n: number): Promise<void>;
}

type LadybugModule = typeof import("kuzu") & {
  VERSION: string;
  STORAGE_VERSION: bigint;
};
type LadybugDatabase = import("kuzu").Database;
type LadybugConnection = import("kuzu").Connection;
type ManagedExtension = (typeof MANAGED_EXTENSIONS)[number];
type ConnectionExtensionLoadState = Partial<Record<ManagedExtension, boolean>>;

let connectionExtensionLoadState = new WeakMap<
  LadybugConnection,
  ConnectionExtensionLoadState
>();

function recordConnectionExtensionLoad(
  conn: LadybugConnection,
  ext: ManagedExtension,
  loaded: boolean,
): void {
  const state = connectionExtensionLoadState.get(conn) ?? {};
  state[ext] = loaded;
  connectionExtensionLoadState.set(conn, state);
}

function getActiveConnectionsWithReplacement(
  replacement?: LadybugConnection,
  replaced?: LadybugConnection,
): LadybugConnection[] {
  const activeConnections: LadybugConnection[] = [];
  if (writeConn) {
    activeConnections.push(
      writeConn === replaced && replacement ? replacement : writeConn,
    );
  }
  for (const conn of readPool) {
    activeConnections.push(
      conn === replaced && replacement ? replacement : conn,
    );
  }
  if (replacement && !activeConnections.includes(replacement)) {
    activeConnections.push(replacement);
  }
  return activeConnections;
}

function publishExtensionCapabilitiesForConnections(
  activeConnections: readonly LadybugConnection[],
): void {
  for (const ext of MANAGED_EXTENSIONS) {
    const loadedByEveryActiveConnection =
      activeConnections.length > 0 &&
      activeConnections.every(
        (conn) => connectionExtensionLoadState.get(conn)?.[ext] === true,
      );
    if (loadedByEveryActiveConnection) {
      markExtensionLoaded(ext);
    } else {
      markExtensionUnavailable(ext);
    }
  }
}

const require = createRequire(import.meta.url);

let ladybugModule: LadybugModule | null = null;
let dbInstance: LadybugDatabase | null = null;
let poisonedOpeningDb: LadybugDatabase | null = null;
let currentDbPath: string | null = null;
let activeFamilyLease: LadybugFamilyLease | null = null;
let familyOwnershipPoisoned = false;
let familyCloseMustAbandon = false;

const SAFE_REBUILD_SESSION = Symbol("SafeRebuildLadybugSession");

export interface SafeRebuildLadybugSession {
  readonly [SAFE_REBUILD_SESSION]: true;
  readonly dbPath: string;
  readonly lease: LadybugFamilyLease;
}

const ONE_GB = 1024 * 1024 * 1024;
const FOUR_GB = 4 * ONE_GB;
// 25% of system RAM (was 50%/8GB cap; reduced to avoid OOM during large
// provider-first SCIP materialization on <=16GB systems).
const DEFAULT_BUFFER_MANAGER_RATIO = 0.25;
const DEFAULT_CHECKPOINT_THRESHOLD_BYTES = 128 * 1024 * 1024;
const MIN_CHECKPOINT_THRESHOLD_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_THRESHOLD_BYTES = 8 * ONE_GB;
const CHECKPOINT_THRESHOLD_ENV = "SDL_MCP_LADYBUG_CHECKPOINT_THRESHOLD_BYTES";

export interface LadybugDbInitOptions {
  bufferPoolBytes?: number | null;
  checkpointThresholdBytes?: number | null;
  /** Keep a durable safe-rebuild reopen read-only until validation completes. */
  skipRetrievalIndexBootstrap?: boolean;
}

/** @internal exported for focused config/env tests. */
export function resolveLadybugCheckpointThresholdBytes(
  env: NodeJS.ProcessEnv = process.env,
  explicitValue?: number | null,
): number {
  const candidate =
    explicitValue ?? Number.parseInt((env[CHECKPOINT_THRESHOLD_ENV] ?? "").trim(), 10);
  if (!Number.isFinite(candidate)) {
    return DEFAULT_CHECKPOINT_THRESHOLD_BYTES;
  }

  if (
    candidate < MIN_CHECKPOINT_THRESHOLD_BYTES ||
    candidate > MAX_CHECKPOINT_THRESHOLD_BYTES
  ) {
    logger.warn("Ignoring LadybugDB checkpoint threshold outside safe bounds", {
      env: CHECKPOINT_THRESHOLD_ENV,
      value: candidate,
      minBytes: MIN_CHECKPOINT_THRESHOLD_BYTES,
      maxBytes: MAX_CHECKPOINT_THRESHOLD_BYTES,
    });
    return DEFAULT_CHECKPOINT_THRESHOLD_BYTES;
  }

  return Math.trunc(candidate);
}

function formatReindexGuidanceError(dbPath: string, msg: string): string {
  logger.error("Database initialization failed", { dbPath, error: msg });
  const isWalCorruption =
    msg.includes("WAL") || msg.includes("wal") || msg.includes("corrupt");
  const isLockError = msg.includes("lock") || msg.includes("EBUSY");

  let guidance = `LadybugDB initialization failed at ${dbPath}: ${msg}. `;

  if (isWalCorruption) {
    guidance +=
      "\n\nThis appears to be a WAL (write-ahead log) corruption issue. " +
      "Preserve the complete database family; do not delete or reopen it in place. " +
      "To recover safely:\n" +
      "  1. Stop any running SDL-MCP processes\n" +
      `  2. Copy ${dbPath} and every sidecar with the same base name to quarantine\n` +
      "  3. Build a fresh candidate: sdl-mcp index --force --safe-rebuild <absolute-new-path>\n" +
      "  4. Switch the configured graph path only after the command validates the candidate.";
  } else if (isLockError) {
    guidance +=
      "\n\nThe database file appears to be locked by another process. " +
      "Check for other SDL-MCP instances and stop them before retrying.";
  } else {
    guidance +=
      "\nPreserve the existing database. If storage integrity is uncertain, stop SDL-MCP " +
      "and build a fresh candidate with: sdl-mcp index --force --safe-rebuild <absolute-new-path>.";
  }

  guidance +=
    "\nSemantic embeddings and other derived artifacts can be recomputed from source after recovery.";

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
let pendingWriteConnectionRecovery: Promise<void> | null = null;
let dbClosePromise: Promise<void> | null = null;
let preserveCloseHooksForCurrentClose = false;
let strictCloseForCurrentClose = false;
let preserveFamilyLeaseForCurrentClose = false;
const activeExclusiveReadLeases = new Set<Promise<void>>();
const exclusiveReadCloseFailures: unknown[] = [];
const retainedNativeConnections = new Set<LadybugConnection>();

function retainNativeConnectionForCloseRetry(
  conn: LadybugConnection,
  label: string,
  error: unknown,
): void {
  retainedNativeConnections.add(conn);
  familyOwnershipPoisoned = true;
  familyCloseMustAbandon = true;
  logger.warn(label, {
    error: error instanceof Error ? error.message : String(error),
  });
}

const sessionWriteBodyLimiters = new WeakMap<
  LadybugConnection,
  ConcurrencyLimiter
>();
let writeQueueTimeoutMs = 30_000;

let deferredIndexesPending = false;
let vecMigrationDone = false;

// Per-slot recycling guard: prevents concurrent recycling of the same pool slot (TOCTOU).
const recyclingSlots = new Set<number>();
const pendingReadConnectionRecoveries = new Map<number, Promise<void>>();

// Initialization mutex: prevents concurrent callers from double-initializing
// the DB instance or connection pool across async boundaries.
let dbInitPromise: Promise<LadybugDatabase> | null = null;

function getSessionWriteBodyLimiter(
  conn: LadybugConnection,
): ConcurrencyLimiter {
  let limiter = sessionWriteBodyLimiters.get(conn);
  if (!limiter) {
    limiter = new ConcurrencyLimiter({
      maxConcurrency: 1,
      queueTimeoutMs: writeQueueTimeoutMs,
    });
    sessionWriteBodyLimiters.set(conn, limiter);
  }
  return limiter;
}
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

function lineageDriver(modules: LadybugModule): LadybugLineageDriver {
  return {
    version: modules.VERSION,
    storageVersion: modules.STORAGE_VERSION.toString(10),
  };
}

async function loadLadybug(): Promise<LadybugModule> {
  if (ladybugModule) {
    return ladybugModule;
  }

  try {
    const imported = await import("kuzu");
    ladybugModule = (imported.default ?? imported) as unknown as LadybugModule;
    return ladybugModule;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(
      `Graph database driver not available: ${msg}. The 'kuzu' package should be installed automatically as a dependency of sdl-mcp (backed by @ladybugdb/core). Try: npm install`,
    );
  }
}

export function resolveLadybugBufferManagerSizeBytes(
  totalMemoryBytes = totalmem(),
  envValue = process.env.SDL_LADYBUG_BUFFER_POOL_BYTES ??
    process.env.SDL_KUZU_BUFFER_POOL_BYTES,
  configuredBytes?: number | null,
): number {
  const parsedEnvValue = envValue ? Number(envValue) : Number.NaN;
  if (Number.isFinite(parsedEnvValue) && parsedEnvValue >= ONE_GB) {
    return Math.floor(parsedEnvValue);
  }

  const parsedConfiguredBytes = configuredBytes ?? Number.NaN;
  if (
    Number.isFinite(parsedConfiguredBytes) &&
    parsedConfiguredBytes >= ONE_GB
  ) {
    return Math.floor(parsedConfiguredBytes);
  }

  const autoSized = Math.floor(totalMemoryBytes * DEFAULT_BUFFER_MANAGER_RATIO);
  return Math.min(Math.max(autoSized, ONE_GB), FOUR_GB);
}

export type WalCheckpointSidecarQuarantineResult =
  | {
      status: "not-present" | "wal-present";
      sidecarPath: string;
      walPath: string;
    }
  | {
      status: "quarantined";
      sidecarPath: string;
      walPath: string;
      quarantinePath: string;
    }
  | {
      status: "failed";
      sidecarPath: string;
      walPath: string;
      error: string;
    };

function formatQuarantineTimestamp(nowMs: number): string {
  return String(Math.floor(nowMs));
}

export function quarantineDanglingWalCheckpointSidecar(
  dbPath: string,
  nowMs = Date.now(),
): WalCheckpointSidecarQuarantineResult {
  const normalizedPath = normalizePath(normalizeGraphDbPath(dbPath));
  const sidecarPath = `${normalizedPath}.wal.checkpoint`;
  const walPath = `${normalizedPath}.wal`;

  if (!existsSync(sidecarPath)) {
    return { status: "not-present", sidecarPath, walPath };
  }
  if (existsSync(walPath)) {
    return { status: "wal-present", sidecarPath, walPath };
  }

  const timestamp = formatQuarantineTimestamp(nowMs);
  let quarantinePath = `${sidecarPath}.quarantined-${timestamp}`;
  for (let attempt = 1; existsSync(quarantinePath); attempt++) {
    quarantinePath = `${sidecarPath}.quarantined-${timestamp}-${attempt}`;
  }

  try {
    renameSync(sidecarPath, quarantinePath);
    return { status: "quarantined", sidecarPath, walPath, quarantinePath };
  } catch (err) {
    return {
      status: "failed",
      sidecarPath,
      walPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type LadybugFamilyLeaseAcquirer = (
  dbPath: string,
  driver: LadybugLineageDriver,
) => LadybugFamilyLease;

async function getLadybugDbInternal(
  dbPath: string | undefined,
  options: LadybugDbInitOptions | undefined,
  acquireLease: LadybugFamilyLeaseAcquirer,
): Promise<LadybugDatabase> {
  const resolvedPath = dbPath
    ? normalizePath(normalizeGraphDbPath(dbPath))
    : currentDbPath;

  if (!resolvedPath) {
    throw new DatabaseError(
      "LadybugDB not initialized. Call initLadybugDb(dbPath) first.",
    );
  }

  if (familyOwnershipPoisoned) {
    throw new DatabaseError(
      "LadybugDB native ownership cleanup is pending; retry closeLadybugDb() before opening another family",
    );
  }

  if (dbInstance && currentDbPath === resolvedPath) {
    return dbInstance;
  }

  if (dbInitPromise) {
    const existing = await dbInitPromise;
    if (dbInstance && currentDbPath === resolvedPath) {
      return existing;
    }
  }

  const initFn = async (): Promise<LadybugDatabase> => {
    const normalizedPath = normalizePath(resolvedPath);

    if (dbInstance) {
      throw new DatabaseError(
        "LadybugDB path switching requires callers to await closeLadybugDb({ strict: true }) before opening another family",
      );
    }

    const modules = await loadLadybug();
    const parentDir = dirname(normalizedPath);
    if (parentDir && parentDir !== "." && !existsSync(parentDir)) {
      try {
        mkdirSync(parentDir, { recursive: true });
        logger.debug("Created LadybugDB parent directory", { path: parentDir });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DatabaseError(
          "Failed to create LadybugDB parent directory at " +
            parentDir +
            ": " +
            msg,
        );
      }
    }

    const openingLease = acquireLease(normalizedPath, lineageDriver(modules));
    if (activeFamilyLease && activeFamilyLease !== openingLease) {
      const ownershipError = new DatabaseError(
        "Another LadybugDB family lease is already active in this process",
      );
      rethrowAfterCleanup(
        ownershipError,
        () => abandonLadybugFamily(openingLease),
        "LadybugDB family ownership collision and cleanup both failed",
      );
    }
    activeFamilyLease = openingLease;

    let openingDb: LadybugDatabase | null = null;
    try {
      const bufferManagerSize = resolveLadybugBufferManagerSizeBytes(
        undefined,
        undefined,
        options?.bufferPoolBytes ?? undefined,
      );
      const checkpointThresholdBytes = resolveLadybugCheckpointThresholdBytes(
        process.env,
        options?.checkpointThresholdBytes,
      );
      // The cooperative family lease is already held and the closed-family
      // receipt or purpose-specific clone authority was rechecked immediately
      // before native construction.
      openingDb = createManagedLadybugDatabase(
        modules.Database,
        normalizedPath,
        {
          bufferManagerSize,
          checkpointThresholdBytes,
        },
      );
      const initResult = await withWindowsFtsRuntime(() => openingDb!.init());
      if (isWindowsFtsRuntimeUnavailable(initResult)) {
        await openingDb.init();
      }
      dbInstance = openingDb;
      currentDbPath = normalizedPath;
      logger.info("LadybugDB database opened", {
        path: normalizedPath,
        bufferManagerSizeBytes: bufferManagerSize,
        checkpointThresholdBytes,
      });
      return openingDb;
    } catch (err) {
      const failures: unknown[] = [err];
      let nativeCloseFailed = false;
      if (openingDb) {
        try {
          await openingDb.close();
        } catch (closeErr) {
          failures.push(closeErr);
          nativeCloseFailed = true;
          poisonedOpeningDb = openingDb;
          familyOwnershipPoisoned = true;
          familyCloseMustAbandon = true;
          currentDbPath = normalizedPath;
          logger.warn("Error closing LadybugDB after initialization failure", {
            error:
              closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        }
      }
      if (dbInstance === openingDb) {
        dbInstance = null;
      }
      if (!nativeCloseFailed && activeFamilyLease === openingLease) {
        try {
          abandonLadybugFamily(openingLease);
        } catch (leaseError) {
          failures.push(leaseError);
          familyOwnershipPoisoned = true;
          familyCloseMustAbandon = true;
          currentDbPath = normalizedPath;
          logger.warn("Error releasing LadybugDB family lease after open failure", {
            error:
              leaseError instanceof Error
                ? leaseError.message
                : String(leaseError),
          });
        }
        if (openingLease.released) activeFamilyLease = null;
      }
      if (!familyOwnershipPoisoned) currentDbPath = null;
      const msg = flattenErrorMessages(failures).join("; ");
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

export function getLadybugDb(
  dbPath?: string,
  options?: LadybugDbInitOptions,
): Promise<LadybugDatabase> {
  const normalizedPath = dbPath
    ? normalizePath(normalizeGraphDbPath(dbPath))
    : undefined;
  const open = () =>
    getLadybugDbInternal(
      normalizedPath,
      options,
      acquireNormalLadybugFamily,
    );

  if (
    normalizedPath !== undefined &&
    (!dbInstance || currentDbPath !== normalizedPath)
  ) {
    return withLadybugInitialization(open);
  }
  return withSharedLadybugOperation(open);
}

async function isConnectionHealthy(conn: LadybugConnection): Promise<boolean> {
  try {
    await exec(conn, "RETURN 1");
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
  try {
    if ("setMaxNumThreadForExec" in conn) {
      await (
        conn as unknown as LadybugConnectionWithThreads
      ).setMaxNumThreadForExec(1);
    }
  } catch (err) {
    try {
      await conn.close();
    } catch (closeErr) {
      retainNativeConnectionForCloseRetry(
        conn,
        "Error closing LadybugDB connection after setup failure",
        closeErr,
      );
    }
    throw err;
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
    retainNativeConnectionForCloseRetry(
      conn,
      `Failed to close unhealthy LadybugDB ${label} connection before recreation`,
      closeError,
    );
  } finally {
    clearConnectionPoisoned(conn);
  }

  const replacement = await createConnection(db);
  try {
    await loadExtensionsAfterWalCheckpoint(
      replacement,
      [replacement],
      `pre-extension-load-${label}-replacement`,
      getActiveConnectionsWithReplacement(replacement, conn),
    );
    return replacement;
  } catch (error) {
    try {
      await replacement.close();
    } catch (closeError) {
      retainNativeConnectionForCloseRetry(
        replacement,
        `Failed to close LadybugDB ${label} replacement after setup failure`,
        closeError,
      );
    }
    throw error;
  }
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
      await execDdl(conn, `INSTALL ${ext}`);
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
 * Records each per-connection load; pool-wide publication happens after all active connections are known.
 */
async function loadExtensionsOnConnection(
  conn: LadybugConnection,
): Promise<void> {
  for (const ext of MANAGED_EXTENSIONS) {
    try {
      if (ext === "fts") {
        const result = await withWindowsFtsRuntime(() =>
          execDdl(conn, `LOAD EXTENSION ${ext}`),
        );
        if (isWindowsFtsRuntimeUnavailable(result)) {
          throw new Error(result.recovery);
        }
      } else {
        await execDdl(conn, `LOAD EXTENSION ${ext}`);
      }
      recordConnectionExtensionLoad(conn, ext, true);
      logger.debug(`Kuzu extension loaded`, { extension: ext });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordConnectionExtensionLoad(conn, ext, false);
      logger.warn(`Kuzu extension LOAD failed`, {
        extension: ext,
        reason: msg,
      });
    }
  }
}

function markExtensionsUnavailableAfterSkippedLoad(phase: string): void {
  for (const ext of MANAGED_EXTENSIONS) {
    markExtensionUnavailable(ext);
  }
  logger.warn(
    "Skipping LOAD EXTENSION â€” WAL is dirty and cannot be checkpointed. " +
      "FTS will be unavailable until the WAL is resolved. " +
      "Try stopping all processes using this DB and restarting.",
    { phase },
  );
}

async function loadExtensionsAfterWalCheckpoint(
  checkpointConn: LadybugConnection,
  targetConns: readonly LadybugConnection[],
  phase: string,
  activeConnections: readonly LadybugConnection[] = targetConns,
): Promise<boolean> {
  const walClean = await checkpointWal(checkpointConn, phase);
  if (walClean) {
    for (const conn of targetConns) {
      await loadExtensionsOnConnection(conn);
    }
    publishExtensionCapabilitiesForConnections(activeConnections);
    return true;
  }

  markExtensionsUnavailableAfterSkippedLoad(phase);
  return false;
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
  onFailure?: (error: unknown) => void,
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    await execCheckpoint(conn);
    logger.info(`LadybugDB CHECKPOINT completed`, {
      phase,
      durationMs: Date.now() - startedAt,
    });
    return true;
  } catch (err) {
    onFailure?.(err);
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`LadybugDB CHECKPOINT failed (best-effort)`, {
      phase,
      durationMs: Date.now() - startedAt,
      reason: msg,
    });
    return false;
  }
}

/**
 * Run a best-effort WAL checkpoint through the serialized write connection.
 *
 * This is intentionally timeout-bound. CHECKPOINT is a housekeeping operation:
 * it should keep WAL sidecars from growing indefinitely, but it must not wedge
 * user-facing reads/writes if another write owns the limiter.
 */
export async function runWalCheckpoint(
  phase = "manual",
  timeoutMs = 2_000,
): Promise<boolean> {
  if (!writeConn) return false;

  try {
    return await withExclusiveLadybugOperation(
      () =>
        withWriteConn(
          (conn) => checkpointWal(conn, phase),
          timeoutMs,
        ),
      timeoutMs,
    );
  } catch (err) {
    logger.debug("LadybugDB CHECKPOINT skipped", {
      phase,
      error: err instanceof Error ? err.message : String(err),
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
 * This is the indexer-specific entry point; general WAL maintenance uses
 * `runWalCheckpoint` above.
 */
export async function preIndexCheckpoint(): Promise<void> {
  await runWalCheckpoint("pre-index", 2_000);
}

/**
 * Get a read connection from the pool (round-robin).
 * This is the primary function for read-only queries.
 * Backward-compatible: this is what getLadybugConn() returns.
 */
async function getLadybugReadConnAdmitted(): Promise<LadybugConnection> {
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
      let localWriteConn: LadybugConnection | undefined;

      try {
        // Create read connections into local array
        for (let i = 0; i < readPoolSize; i++) {
          const conn = await createConnection(db);
          localReadPool.push(conn);
        }

        // Create single write connection
        localWriteConn = await createConnection(db);

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
        await loadExtensionsAfterWalCheckpoint(
          localWriteConn,
          [localWriteConn, ...localReadPool],
          "pre-extension-load",
        );

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
        // Unpublished pool handles still own native state until close succeeds.
        const unpublishedConnections = localWriteConn
          ? [...localReadPool, localWriteConn]
          : localReadPool;
        for (const conn of unpublishedConnections) {
          try {
            await conn.close();
          } catch (closeError) {
            retainNativeConnectionForCloseRetry(
              conn,
              "Error closing unpublished LadybugDB pool connection",
              closeError,
            );
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
  //
  // Skip conns flagged stuck by ladybug-core's watchdog or vector deadline.
  // If every conn is stuck, fail fast instead of assigning more work to an
  // occupied native mutex and turning one hung query into a server-wide stall.
  for (let attempt = 0; attempt < readPool.length; attempt++) {
    const idx = readPoolIndex;
    readPoolIndex = (readPoolIndex + 1) % readPool.length;
    const candidate = readPool[idx];
    if (!isConnStuck(candidate)) return candidate;
  }
  throw new DatabaseError(
    "All read connections are stuck; retry after in-flight operations settle",
  );
}

export function getLadybugReadConn(): Promise<LadybugConnection> {
  return withSharedLadybugOperation(getLadybugReadConnAdmitted);
}

/**
 * Replace a read-pool connection that was found to be unhealthy.
 * Call this from error-handling paths when a query fails due to a
 * broken connection, to trigger lazy reconnection on the next checkout.
 */
async function recoverReadConnectionSlot(
  idx: number,
  unhealthyConn: LadybugConnection,
): Promise<void> {
  let replacement: LadybugConnection | undefined;
  try {
    const db = await getLadybugDb();

    // Re-validate after admission: shutdown or another recycler may have
    // changed the slot while recovery was waiting to run.
    if (readPool.length === 0 || readPool[idx] !== unhealthyConn) return;

    try {
      await unhealthyConn.close();
    } catch (closeError) {
      retainNativeConnectionForCloseRetry(
        unhealthyConn,
        `Failed to close unhealthy LadybugDB read connection [${idx}]`,
        closeError,
      );
    } finally {
      clearConnectionPoisoned(unhealthyConn);
    }
    if (readPool.length === 0 || readPool[idx] !== unhealthyConn) return;

    replacement = await createConnection(db);
    const limiter = writeLimiter;
    const checkpointConn = writeConn;
    if (!limiter || !checkpointConn) {
      throw new DatabaseError(
        "Write connection unavailable during read connection recovery",
      );
    }

    const phase = `pre-extension-load-read-replacement-${idx}`;
    const runWithAdmission = bindCurrentLadybugOperation(() =>
      loadExtensionsAfterWalCheckpoint(
        checkpointConn,
        [replacement!],
        phase,
        getActiveConnectionsWithReplacement(replacement, unhealthyConn),
      ),
    );
    await limiter.run(runWithAdmission);
    readPool[idx] = replacement;
    replacement = undefined;
  } catch (err) {
    if (replacement) {
      try {
        await replacement.close();
      } catch (closeError) {
        retainNativeConnectionForCloseRetry(
          replacement,
          `Failed to close LadybugDB read replacement [${idx}] after recovery failure`,
          closeError,
        );
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to recreate read connection [${idx}]: ${msg}`);
  } finally {
    recyclingSlots.delete(idx);
  }
}

function trackReadConnectionRecovery(
  idx: number,
  recovery: Promise<void>,
): Promise<void> {
  pendingReadConnectionRecoveries.set(idx, recovery);
  void recovery.then(
    () => {
      if (pendingReadConnectionRecoveries.get(idx) === recovery) {
        pendingReadConnectionRecoveries.delete(idx);
      }
    },
    (error: unknown) => {
      if (pendingReadConnectionRecoveries.get(idx) === recovery) {
        pendingReadConnectionRecoveries.delete(idx);
      }
      logger.warn(`Read connection recovery admission [${idx}] failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  return recovery;
}

export async function recycleReadConnection(
  unhealthyConn: LadybugConnection,
): Promise<void> {
  const operationMode = getCurrentLadybugOperationMode();
  let recovery: Promise<void> | undefined;

  // Reserve the pool slot under the caller's admission. Shared/root callers
  // synchronously queue a fresh exclusive for writer preference; an ambient
  // exclusive must reuse itself or it would wait on its own admission.
  await withSharedLadybugOperation(async () => {
    const idx = readPool.indexOf(unhealthyConn);
    if (idx === -1) return;

    const pending = pendingReadConnectionRecoveries.get(idx);
    if (pending) {
      recovery = pending;
      return;
    }
    if (recyclingSlots.has(idx)) return;
    recyclingSlots.add(idx);

    if (operationMode === "exclusive") {
      // Start the nested lease before this reservation callback settles so
      // detached callers keep the outer exclusive admission until recovery ends.
      recovery = trackReadConnectionRecovery(
        idx,
        withExclusiveLadybugOperation(() =>
          recoverReadConnectionSlot(idx, unhealthyConn),
        ),
      );
      return;
    }

    recovery = trackReadConnectionRecovery(
      idx,
      queueExclusiveLadybugOperation(() =>
        recoverReadConnectionSlot(idx, unhealthyConn),
      ),
    );
  });

  if (!recovery) return;
  if (operationMode === "shared") {
    throw new DatabaseError(
      "LadybugDB read connection recovery is pending; retry after the current shared operation unwinds",
    );
  }
  await recovery;
}

/**
 * Backward-compatible alias for getLadybugReadConn().
 * All existing callers (62 files) continue to work unchanged.
 */
export async function getLadybugConn(): Promise<LadybugConnection> {
  return getLadybugReadConn();
}

/**
 * Run a read against a temporary connection owned by the callback.
 * Long-lived snapshots use this instead of occupying a round-robin pool slot.
 */
async function withExclusiveReadConnectionAdmitted<T>(
  fn: (conn: LadybugConnection) => Promise<T>,
): Promise<T> {
  if (dbClosePromise) {
    throw new DatabaseError("LadybugDB is closing, cannot start a read lease");
  }

  const db = await getLadybugDb();
  if (dbClosePromise) {
    throw new DatabaseError("LadybugDB is closing, cannot start a read lease");
  }

  let releaseLease!: () => void;
  const lease = new Promise<void>((resolve) => {
    releaseLease = resolve;
  });
  activeExclusiveReadLeases.add(lease);

  let conn: LadybugConnection | undefined;
  let callbackFailed = false;
  let closeFailed = false;
  let closeError: unknown;
  try {
    conn = await createConnection(db);
    return await fn(conn);
  } catch (error) {
    callbackFailed = true;
    throw error;
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch (err) {
        closeFailed = true;
        closeError = err;
        exclusiveReadCloseFailures.push(err);
        retainNativeConnectionForCloseRetry(
          conn,
          "Error closing LadybugDB exclusive read connection",
          err,
        );
      }
    }
    activeExclusiveReadLeases.delete(lease);
    releaseLease();
    // Preserve callback error precedence while still failing a successful read
    // whose native connection could not be released.
    if (!callbackFailed && closeFailed) throw closeError;
  }
}
export function withExclusiveReadConnection<T>(
  fn: (conn: LadybugConnection) => Promise<T>,
): Promise<T> {
  if (dbClosePromise) {
    return Promise.reject(
      new DatabaseError("LadybugDB is closing, cannot start a read lease"),
    );
  }
  return withSharedLadybugOperation(() =>
    withExclusiveReadConnectionAdmitted(fn),
  );
}

async function recoverWriteConnection(
  unhealthyConn: LadybugConnection,
): Promise<void> {
  const limiter = writeLimiter;
  if (!limiter) return;

  await limiter.run(async () => {
    // Another recovery may have replaced this connection while queued.
    if (writeConn !== unhealthyConn) return;
    const db = await getLadybugDb();
    const healthy = await getHealthyConnection(unhealthyConn, db, "write");
    if (healthy !== unhealthyConn) writeConn = healthy;
  });
}

function queueWriteConnectionRecovery(
  unhealthyConn: LadybugConnection,
): Promise<void> {
  if (pendingWriteConnectionRecovery) {
    return pendingWriteConnectionRecovery;
  }

  const recovery = queueExclusiveLadybugOperation(() =>
    recoverWriteConnection(unhealthyConn),
  );
  pendingWriteConnectionRecovery = recovery;
  // Observe detached recovery queued by nested shared work. Avoid finally():
  // its derived rejected promise would itself be unhandled.
  void recovery.then(
    () => {
      if (pendingWriteConnectionRecovery === recovery) {
        pendingWriteConnectionRecovery = null;
      }
    },
    (error: unknown) => {
      if (pendingWriteConnectionRecovery === recovery) {
        pendingWriteConnectionRecovery = null;
      }
      logger.warn("Failed to recover LadybugDB write connection", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  return recovery;
}

async function withWriteConnAdmitted<T>(
  fn: (conn: LadybugConnection) => Promise<T>,
  timeoutMs?: number,
  onWriteFailure?: (conn: LadybugConnection) => void,
): Promise<T> {
  await getLadybugReadConn();
  // Reuse the active post-index session conn when called from inside the
  // session body. Avoids deadlock: the session already owns the writeLimiter
  // slot, so another writeLimiter.run() would queue forever waiting for
  // itself. The session conn is the same write conn the limiter would hand
  // out, but parallel session subphases can still overlap, so serialize
  // these write bodies with a separate mutex. Do not use the low-level
  // query mutex here; write bodies call exec/query internally.
  // Fire-and-forget work spawned inside a session can inherit AsyncLocalStorage
  // after the session ends. Only reuse the session conn while that exact
  // session is still process-active; stale context must use the global limiter.
  const session = getCurrentSession();
  if (session && getActivePostIndexSession() === session) {
    const runWithAdmission = bindCurrentLadybugOperation(() =>
      fn(session.conn),
    );
    return getSessionWriteBodyLimiter(session.conn).run(runWithAdmission);
  }
  if (!writeLimiter || !writeConn) {
    throw new DatabaseError(
      "Write connection not initialized. Call initLadybugDb() first.",
    );
  }
  const runWithAdmission = bindCurrentLadybugOperation(async () => {
    const conn = writeConn;
    if (!conn) {
      throw new DatabaseError(
        "Write connection was closed during queue wait. Server may be shutting down.",
      );
    }
    try {
      return await fn(conn);
    } catch (err) {
      // Queue before this callback releases the shared admission and limiter.
      onWriteFailure?.(conn);
      throw err;
    }
  });
  return writeLimiter.run(runWithAdmission, timeoutMs);
}

export async function withWriteConn<T>(
  fn: (conn: LadybugConnection) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const operationMode = getCurrentLadybugOperationMode();
  const reuseExclusiveAdmission = operationMode === "exclusive";
  if (operationMode === "shared" && pendingWriteConnectionRecovery) {
    throw new DatabaseError(
      "LadybugDB write connection recovery is pending; retry after the current shared operation unwinds",
    );
  }

  let failedConn: LadybugConnection | undefined;
  let recovery: Promise<void> | undefined;
  try {
    return await withSharedLadybugOperation(
      () =>
        withWriteConnAdmitted(fn, timeoutMs, (conn) => {
          failedConn = conn;
          if (!reuseExclusiveAdmission) {
            recovery = queueWriteConnectionRecovery(conn);
          }
        }),
      timeoutMs,
    );
  } catch (err) {
    // An ambient shared root still owns the admission here. The fresh exclusive
    // is already queued for writer preference, so awaiting it would deadlock.
    if (operationMode === "shared") throw err;

    try {
      if (recovery) {
        await recovery;
      } else if (reuseExclusiveAdmission && failedConn) {
        // Reuse the caller's exclusive root; queueing a fresh one here would
        // wait on the admission that is currently awaiting this callback.
        await recoverWriteConnection(failedConn);
      }
    } catch (recoveryError) {
      // Queued recoveries are observed centrally; exclusive-reuse failures are
      // logged here because they do not pass through that observer.
      if (!recovery) {
        logger.warn("Failed to recover LadybugDB write connection", {
          error:
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError),
        });
      }
    }
    throw err;
  }
}

// Wire write-session.ts so withPostIndexWriteSession can acquire the same
// writeLimiter slot. Function reference is hoisted; the actual pool init
// runs lazily on first invocation.
configureWriteConnAcquirer(withWriteConn);

async function initLadybugDbInternal(
  dbPath: string,
  options: LadybugDbInitOptions | undefined,
  acquireLease: LadybugFamilyLeaseAcquirer,
): Promise<void> {
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
    await getLadybugDbInternal(normalizedPath, options, acquireLease);
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
    } else if (options?.skipRetrievalIndexBootstrap) {
      logger.info("Skipping retrieval index bootstrap for validation-only reopen");
    } else
      try {
        const sdlConfig = loadConfig();
        const semanticConfig = sdlConfig.semantic;
        if (semanticConfig?.enabled && semanticConfig.retrieval) {
          let indexConn = await getLadybugConn();
          // Migrate DOUBLE[] → DOUBLE[N] for vector indexing (existing DBs)
          // Only migrate vec columns on existing DBs — fresh DBs already have DOUBLE[N].
          // ALTER TABLE DROP+ADD corrupts Kuzu's column cache for the current process.
          if (!freshlyCreated && !vecMigrationDone) {
            await migrateVecColumnsToFixedSize(indexConn);
            vecMigrationDone = true;
            // Clear prepared-statement caches on every read-pool conn —
            // the post-DDL column metadata invalidates any cached plan
            // that referenced the dropped vec columns.
            for (const c of readPool) clearPreparedStatementCache(c);
            // The conn we just used to run DDL has stale native column
            // metadata cached. Take a fresh checkout for the index-bootstrap
            // calls below.
            indexConn = await getLadybugConn();
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


function requireSafeRebuildSession(
  session: SafeRebuildLadybugSession,
): LadybugFamilyLease {
  if (
    !session ||
    session[SAFE_REBUILD_SESSION] !== true ||
    activeFamilyLease !== session.lease ||
    session.dbPath !== session.lease.dbPath
  ) {
    throw new DatabaseError("Invalid or inactive safe-rebuild LadybugDB session");
  }
  return session.lease;
}

export function initLadybugDb(
  dbPath: string,
  options?: LadybugDbInitOptions,
): Promise<void> {
  return withLadybugInitialization(() =>
    initLadybugDbInternal(dbPath, options, acquireNormalLadybugFamily),
  );
}

export function initSafeRebuildLadybugDb(
  dbPath: string,
  options?: LadybugDbInitOptions,
): Promise<SafeRebuildLadybugSession> {
  return withLadybugInitialization(async () => {
    if (activeFamilyLease || dbInstance) {
      throw new DatabaseError(
        "Safe rebuild requires a fresh process-global LadybugDB owner",
      );
    }
    const leaseHolder: { lease?: LadybugFamilyLease } = {};
    await initLadybugDbInternal(dbPath, options, (path, driver) => {
      const lease = reserveSafeRebuildLadybugFamily(path, driver);
      leaseHolder.lease = lease;
      return lease;
    });
    const lease = leaseHolder.lease;
    if (!lease) {
      throw new DatabaseError("Safe rebuild did not acquire its family lease");
    }
    return {
      [SAFE_REBUILD_SESSION]: true,
      dbPath: lease.dbPath,
      lease,
    };
  });
}

export function reopenSafeRebuildLadybugDb(
  session: SafeRebuildLadybugSession,
  options?: LadybugDbInitOptions,
): Promise<void> {
  return withLadybugInitialization(async () => {
    const lease = requireSafeRebuildSession(session);
    if (dbInstance) {
      throw new DatabaseError(
        "Safe rebuild reopen requires the first database instance to be closed",
      );
    }
    await initLadybugDbInternal(session.dbPath, options, () => {
      verifySafeRebuildFamilyBeforeReopen(lease);
      return lease;
    });
  });
}

export function initQualificationLadybugClone(
  dbPath: string,
  capability: QualificationLadybugCloneCapability,
  options?: LadybugDbInitOptions,
): Promise<void> {
  return withLadybugInitialization(() =>
    initLadybugDbInternal(dbPath, options, (path, driver) =>
      acquireQualificationLadybugCloneFamily(path, capability, driver),
    ),
  );
}

export function initValidatedLadybugClone(
  dbPath: string,
  capability: VerifiedLadybugFamilyCopy,
  options?: LadybugDbInitOptions,
): Promise<void> {
  return withLadybugInitialization(() =>
    initLadybugDbInternal(dbPath, options, (path, driver) =>
      acquireValidatedLadybugCloneFamily(path, capability, driver),
    ),
  );
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

export interface CloseLadybugDbOptions {
  preserveCloseHooks?: boolean;
  /**
   * Propagate an AggregateError after all checkpoint and close cleanup has
   * been attempted. Normal shutdown remains best-effort.
   */
  strict?: boolean;
}

type DeferredIndexTimingRecorder = (
  phaseName: string,
  durationMs: number,
) => void;

interface DeferredRetrievalEnsureOptions {
  includeFtsIndex?: boolean;
  includeVectorIndexes?: boolean;
  includeEntityFtsIndexes?: boolean;
  includeFileSummaryVectorIndexes?: boolean;
  recordTiming?: DeferredIndexTimingRecorder;
}

interface DeferredRetrievalIndexDependencies {
  ensureIndexes: (
    conn: LadybugConnection,
    retrievalConfig: NonNullable<
      NonNullable<ReturnType<typeof loadConfig>["semantic"]>["retrieval"]
    >,
    options: DeferredRetrievalEnsureOptions,
  ) => Promise<IndexEnsureFailureSource>;
  ensureEntityIndexes: (
    conn: LadybugConnection,
    options: DeferredRetrievalEnsureOptions,
  ) => Promise<IndexEnsureFailureSource>;
}

export interface BuildDeferredIndexesDependencies {
  withWriteConn: typeof withWriteConn;
  createSecondaryIndexes: typeof createSecondaryIndexes;
  loadConfig: typeof loadConfig;
  loadRetrievalIndexDependencies: () => Promise<DeferredRetrievalIndexDependencies>;
}

const defaultBuildDeferredIndexesDependencies: BuildDeferredIndexesDependencies =
  {
    withWriteConn,
    createSecondaryIndexes,
    loadConfig,
    loadRetrievalIndexDependencies: async () => {
      const { ensureIndexes, ensureEntityIndexes } = await import(
        "../retrieval/index-lifecycle.js"
      );
      return { ensureIndexes, ensureEntityIndexes };
    },
  };

async function measureDeferredIndexPhase<T>(
  recordTiming: DeferredIndexTimingRecorder | undefined,
  phaseName: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    recordTiming?.(phaseName, Date.now() - startedAt);
  }
}

export interface BuildDeferredIndexesOptions {
  recordTiming?: DeferredIndexTimingRecorder;
  deferSemanticVectorIndexes?: boolean;
  deferSemanticTextIndexes?: boolean;
  /** @internal test seam for failure-policy coverage without opening LadybugDB. */
  _dependenciesForTesting?: BuildDeferredIndexesDependencies;
}

export interface EnsureCriticalSymbolFtsIndexOptions {
  recordTiming?: DeferredIndexTimingRecorder;
  /** @internal test seam for failure-policy coverage without opening LadybugDB. */
  _dependenciesForTesting?: BuildDeferredIndexesDependencies;
}

interface IndexEnsureFailureSource {
  failed: readonly string[];
}

function collectIndexEnsureFailures(
  ...results: IndexEnsureFailureSource[]
): string[] {
  return [...new Set(results.flatMap((result) => result.failed))];
}

/** @internal exported for focused failure-policy tests. */
export function _setDeferredIndexesPendingForTesting(value: boolean): void {
  deferredIndexesPending = value;
}

export async function ensureCriticalSymbolFtsIndex(
  options: EnsureCriticalSymbolFtsIndexOptions = {},
): Promise<void> {
  const dependencies =
    options._dependenciesForTesting ?? defaultBuildDeferredIndexesDependencies;

  await dependencies.withWriteConn(async (wConn) => {
    try {
      const sdlConfig = await measureDeferredIndexPhase(
        options.recordTiming,
        "ensureCriticalSymbolFts.configLoad",
        () => dependencies.loadConfig(),
      );
      const semanticConfig = sdlConfig.semantic;
      const retrievalConfig = semanticConfig?.retrieval;
      if (!semanticConfig?.enabled || !retrievalConfig) return;

      await measureDeferredIndexPhase(
        options.recordTiming,
        "ensureCriticalSymbolFts.retrievalIndexes",
        async () => {
          const { ensureIndexes } =
            await dependencies.loadRetrievalIndexDependencies();
          const recordRetrievalIndexTiming = (
            phaseName: string,
            durationMs: number,
          ): void => {
            options.recordTiming?.(
              `ensureCriticalSymbolFts.retrieval.${phaseName}`,
              durationMs,
            );
          };
          const indexResult = await ensureIndexes(wConn, retrievalConfig, {
            includeFtsIndex: true,
            includeVectorIndexes: false,
            recordTiming: recordRetrievalIndexTiming,
          });
          const failedIndexes = collectIndexEnsureFailures(indexResult);
          if (failedIndexes.length > 0) {
            throw new DatabaseError(
              `Deferred retrieval index build failed for required index(es): ${failedIndexes.join(", ")}`,
            );
          }
        },
      );
    } catch (err) {
      const message = `Critical Symbol FTS index build failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      logger.warn(message);
      throw err instanceof DatabaseError ? err : new DatabaseError(message);
    }
  });
}

export async function buildDeferredIndexes(
  options: BuildDeferredIndexesOptions = {},
): Promise<void> {
  if (!deferredIndexesPending) return;

  const startMs = Date.now();
  const dependencies =
    options._dependenciesForTesting ?? defaultBuildDeferredIndexesDependencies;
  logger.info("Building deferred secondary indexes after fresh load");

  // Hold the writeLimiter slot across BOTH halves of the deferred-index
  // build. Splitting them into two withWriteConn calls leaves a window
  // where another writer (audit log, live-index reconcile) can interleave
  // — the same race shape that produced "Cannot start a new write
  // transaction" warnings before the post-index session refactor. Inside a
  // post-index session, the ALS shortcut in withWriteConn reuses the
  // session conn so this single call doesn't deadlock on the slot the
  // session already holds.
  await dependencies.withWriteConn(async (wConn) => {
    await measureDeferredIndexPhase(
      options.recordTiming,
      "buildDeferredIndexes.secondaryIndexes",
      () => dependencies.createSecondaryIndexes(wConn),
    );

    try {
      const sdlConfig = await measureDeferredIndexPhase(
        options.recordTiming,
        "buildDeferredIndexes.configLoad",
        () => dependencies.loadConfig(),
      );
      const semanticConfig = sdlConfig.semantic;
      const retrievalConfig = semanticConfig?.retrieval;
      if (semanticConfig?.enabled && retrievalConfig) {
        await measureDeferredIndexPhase(
          options.recordTiming,
          "buildDeferredIndexes.retrievalIndexes",
          async () => {
            const { ensureIndexes, ensureEntityIndexes } =
              await dependencies.loadRetrievalIndexDependencies();
            const recordRetrievalIndexTiming = (
              phaseName: string,
              durationMs: number,
            ): void => {
              options.recordTiming?.(
                `buildDeferredIndexes.retrieval.${phaseName}`,
                durationMs,
              );
            };
            const indexResult = await ensureIndexes(wConn, retrievalConfig, {
              includeFtsIndex: !options.deferSemanticTextIndexes,
              includeVectorIndexes: !options.deferSemanticVectorIndexes,
              recordTiming: recordRetrievalIndexTiming,
            });
            const entityResult = await ensureEntityIndexes(wConn, {
              includeEntityFtsIndexes: !options.deferSemanticTextIndexes,
              includeFileSummaryVectorIndexes: !options.deferSemanticVectorIndexes,
              recordTiming: recordRetrievalIndexTiming,
            });
            const failedIndexes = collectIndexEnsureFailures(
              indexResult,
              entityResult,
            );
            if (failedIndexes.length > 0) {
              throw new DatabaseError(
                `Deferred retrieval index build failed for required index(es): ${failedIndexes.join(", ")}`,
              );
            }
          },
        );
      }
    } catch (err) {
      const message = `Deferred retrieval index build failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      logger.warn(message);
      throw err instanceof DatabaseError ? err : new DatabaseError(message);
    }
  });

  deferredIndexesPending = false;
  logger.info("Deferred indexes built", { durationMs: Date.now() - startMs });
}

function requestLadybugDbClose(
  options: CloseLadybugDbOptions,
  preserveFamilyLease: boolean,
): Promise<void> {
  if (!dbClosePromise) {
    preserveCloseHooksForCurrentClose = options.preserveCloseHooks === true;
    strictCloseForCurrentClose = options.strict === true;
    preserveFamilyLeaseForCurrentClose = preserveFamilyLease;
    dbClosePromise = withLadybugCloseOperation(
      closeLadybugDbImpl,
      () =>
        !familyOwnershipPoisoned &&
        retainedNativeConnections.size === 0 &&
        dbInstance === null &&
        poisonedOpeningDb === null &&
        readPool.length === 0 &&
        writeConn === null &&
        !hasPendingLadybugFamilyLeaseCleanup() &&
        !hasPendingShadowLadybugDatabaseCleanup(),
    ).finally(() => {
      dbClosePromise = null;
      preserveCloseHooksForCurrentClose = false;
      strictCloseForCurrentClose = false;
      preserveFamilyLeaseForCurrentClose = false;
    });
  } else {
    if (!options.preserveCloseHooks) {
      // Concurrent close callers share one operation. Clearing wins so a caller
      // cannot accidentally retain hooks requested for disposal by another.
      preserveCloseHooksForCurrentClose = false;
    }
    if (!preserveFamilyLease) {
      // A normal or failure-path close must not leave a capability-owned lease.
      preserveFamilyLeaseForCurrentClose = false;
    }
    // Strict propagation wins for a shared close so validation cannot report
    // success when any part of the shared cleanup failed.
    if (options.strict) strictCloseForCurrentClose = true;
  }
  return dbClosePromise;
}

export function closeLadybugDb(
  options: CloseLadybugDbOptions = {},
): Promise<void> {
  return requestLadybugDbClose(options, false);
}

function rethrowAfterCleanup(
  primaryError: unknown,
  cleanup: () => void,
  message: string,
): never {
  try {
    cleanup();
  } catch (cleanupError) {
    throw new AggregateError([primaryError, cleanupError], message);
  }
  throw primaryError;
}

function abandonActiveFamilyLease(): void {
  const lease = activeFamilyLease;
  if (!lease) return;
  abandonLadybugFamily(lease);
  if (lease.released) activeFamilyLease = null;
}

export async function closeSafeRebuildBeforeReopen(
  session: SafeRebuildLadybugSession,
): Promise<void> {
  const lease = requireSafeRebuildSession(session);
  try {
    await requestLadybugDbClose(
      { preserveCloseHooks: true, strict: true },
      true,
    );
    sealSafeRebuildFamilyForReopen(lease);
  } catch (error) {
    if (!familyOwnershipPoisoned) {
      rethrowAfterCleanup(
        error,
        abandonActiveFamilyLease,
        "Safe-rebuild close/seal and family cleanup both failed",
      );
    }
    throw error;
  }
}

export async function closeAndPublishSafeRebuildLadybugDb(
  session: SafeRebuildLadybugSession,
  beforePublication?: () => void,
): Promise<void> {
  const lease = requireSafeRebuildSession(session);
  try {
    await requestLadybugDbClose({ strict: true }, true);
    finalizeSafeRebuildLadybugFamily(lease, beforePublication);
    activeFamilyLease = null;
  } catch (error) {
    if (activeFamilyLease === lease && !familyOwnershipPoisoned) {
      rethrowAfterCleanup(
        error,
        abandonActiveFamilyLease,
        "Safe-rebuild publication and family cleanup both failed",
      );
    }
    throw error;
  }
}

function flattenErrorMessages(errors: readonly unknown[]): string[] {
  const messages: string[] = [];
  const visit = (error: unknown): void => {
    if (error instanceof AggregateError) {
      for (const nested of error.errors) visit(nested);
      if (error.message) messages.push(error.message);
      return;
    }
    messages.push(error instanceof Error ? error.message : String(error));
  };
  for (const error of errors) visit(error);
  return messages;
}

async function closeLadybugDbImpl(): Promise<void> {
  const closeFailures: unknown[] = [];
  const nativeCloseFailures: unknown[] = [];

  try {
    retryPendingLadybugFamilyLeaseCleanup();
    if (activeFamilyLease?.released) {
      activeFamilyLease = null;
      familyOwnershipPoisoned = false;
      familyCloseMustAbandon = false;
    }
  } catch (error) {
    closeFailures.push(error);
    logger.warn("LadybugDB family lock cleanup remains pending", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await retryPendingShadowLadybugDatabaseCleanup();
  } catch (error) {
    closeFailures.push(error);
    logger.warn("Shadow LadybugDB native cleanup remains pending", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await Promise.allSettled([...activeExclusiveReadLeases]);
  const retainedConnectionSnapshot = [...retainedNativeConnections].filter(
    (conn) => !readPool.includes(conn) && conn !== writeConn,
  );
  closeFailures.push(...exclusiveReadCloseFailures);
  exclusiveReadCloseFailures.length = 0;

  // Best-effort flush of any audit events queued by the post-index buffer
  // (src/mcp/audit-buffer.ts). Done before the writeLimiter drain so the
  // events have a chance to commit while the limiter still accepts work.
  // Failures are logged inside flushAuditBufferOnShutdown and don't block
  // close.
  if (writeLimiter) {
    try {
      const { flushAuditBufferOnShutdown } =
        await import("../mcp/audit-buffer.js");
      await flushAuditBufferOnShutdown(async (body) => {
        await withWriteConn(async (conn) => {
          await body(conn);
        }, DB_SHUTDOWN_DRAIN_TIMEOUT_MS);
      });
    } catch {
      // Best-effort; never block shutdown on audit drain.
    }
  }

  // Drain in-flight writes before closing connections. This wait is bounded
  // so shutdown can proceed if a native write is stuck; keep the outer
  // ShutdownManager watchdog comfortably higher than this per-drain budget.
  if (writeLimiter) {
    try {
      let timeoutHandle: NodeJS.Timeout | undefined;
      await Promise.race([
        writeLimiter.drain(),
        new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(resolve, DB_SHUTDOWN_DRAIN_TIMEOUT_MS);
          timeoutHandle.unref();
        }),
      ]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });
    } catch {
      // Best-effort drain — proceed with teardown regardless
    }

    // Second pass: audit events that arrived from in-flight tool calls
    // DURING the limiter drain landed in the buffer (their recordAuditEvent
    // saw no active session, but the writeLimiter task they queued was
    // cancelled by clearQueue below — actually the path is different;
    // cross-context audit calls during shutdown go straight via
    // withWriteConn and queue here. Either way, sweep the buffer once more
    // before clearQueue so durability is best-effort but contiguous.
    try {
      const { flushAuditBufferOnShutdown } =
        await import("../mcp/audit-buffer.js");
      await flushAuditBufferOnShutdown(async (body) => {
        await withWriteConn(async (conn) => {
          await body(conn);
        }, DB_SHUTDOWN_DRAIN_TIMEOUT_MS);
      });
    } catch {
      // Best-effort; never block shutdown.
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
  const readDrainResults = await Promise.allSettled(
    readPool.map((conn) =>
      drainConnMutex(
        conn,
        DB_SHUTDOWN_DRAIN_TIMEOUT_MS,
        shutdownError,
      ),
    ),
  );
  for (const result of readDrainResults) {
    if (result.status === "rejected") closeFailures.push(result.reason);
  }

  try {
    await flushStaleFinalizers();
  } catch (err) {
    closeFailures.push(err);
    logger.warn("Error flushing LadybugDB finalizers during close", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Synchronously capture and clear the read pool so concurrent readers
  // immediately see "not initialized" instead of accessing closing connections.
  const poolSnapshot = [...readPool];
  readPool.length = 0;
  readPoolIndex = 0;
  recyclingSlots.clear();

  // Retain every failed native handle so a later close can retry ownership
  // cleanup without allowing another family to acquire this process.
  for (const conn of poolSnapshot) {
    try {
      await conn.close();
      retainedNativeConnections.delete(conn);
    } catch (err) {
      closeFailures.push(err);
      nativeCloseFailures.push(err);
      readPool.push(conn);
      logger.warn("Error closing LadybugDB read connection", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Close write connection
  if (writeConn) {
    // Drain the write conn's per-connection mutex before issuing CHECKPOINT.
    // Otherwise CHECKPOINT can race a still-in-flight write executing on
    // the same native handle and crash inside the libkuzu C++ destructor.
    let writeConnDrained = false;
    try {
      writeConnDrained = await drainConnMutex(
        writeConn,
        DB_SHUTDOWN_DRAIN_TIMEOUT_MS,
        shutdownError,
      );
    } catch (err) {
      closeFailures.push(err);
      // Best-effort drain — proceed with close regardless.
      writeConnDrained = false;
    }
    if (writeConnDrained) {
      // Force CHECKPOINT on the way out so the next startup opens a clean WAL.
      // Prevents the Kuzu 0.15.2 UNREACHABLE_CODE crash in wal_record.cpp:76
      // when `LOAD EXTENSION fts` replays an uncheckpointed WAL.
      await checkpointWal(writeConn, "pre-close", (error) => {
        closeFailures.push(error);
      });
    } else {
      closeFailures.push(
        new Error(
          "LadybugDB write connection did not drain before shutdown checkpoint",
        ),
      );
      logger.warn("Skipping LadybugDB shutdown checkpoint", {
        reason: "write connection did not drain before shutdown timeout",
        timeoutMs: DB_SHUTDOWN_DRAIN_TIMEOUT_MS,
      });
    }
    try {
      await writeConn.close();
      retainedNativeConnections.delete(writeConn);
      writeConn = null;
    } catch (err) {
      closeFailures.push(err);
      nativeCloseFailures.push(err);
      logger.warn("Error closing LadybugDB write connection", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const conn of retainedConnectionSnapshot) {
    if (!retainedNativeConnections.has(conn)) continue;
    try {
      await conn.close();
      retainedNativeConnections.delete(conn);
    } catch (err) {
      closeFailures.push(err);
      nativeCloseFailures.push(err);
      logger.warn("Error retrying retained LadybugDB connection close", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (dbInstance) {
    try {
      await dbInstance.close();
      dbInstance = null;
    } catch (err) {
      closeFailures.push(err);
      nativeCloseFailures.push(err);
      logger.warn("Error closing LadybugDB database", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (poisonedOpeningDb) {
    try {
      await poisonedOpeningDb.close();
      poisonedOpeningDb = null;
    } catch (err) {
      closeFailures.push(err);
      nativeCloseFailures.push(err);
      logger.warn("Error retrying failed LadybugDB initialization close", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (
    nativeCloseFailures.length > 0 ||
    retainedNativeConnections.size > 0
  ) {
    familyOwnershipPoisoned = true;
    familyCloseMustAbandon = true;
    logger.warn("LadybugDB native ownership retained for close retry", {
      errors: flattenErrorMessages(nativeCloseFailures),
    });
    if (strictCloseForCurrentClose) {
      throw new AggregateError(
        closeFailures,
        "LadybugDB strict close failed; native ownership retained",
      );
    }
    return;
  }

  currentDbPath = null;
  deferredIndexesPending = false;
  extensionsInstallAttempted = false;
  resetExtensionCapabilities();
  connectionExtensionLoadState = new WeakMap();
  resetJoinHintCache();
  for (const hook of closeHooks) {
    try {
      hook();
    } catch (err) {
      closeFailures.push(err);
      logger.warn("Error in DB close hook", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!preserveCloseHooksForCurrentClose) {
    closeHooks.length = 0;
  }

  if (!preserveFamilyLeaseForCurrentClose && activeFamilyLease) {
    const lease = activeFamilyLease;
    try {
      if (
        !familyCloseMustAbandon &&
        closeFailures.length === 0 &&
        lease.mode === "normal"
      ) {
        // Only a fully successful checkpoint/close may refresh the active
        // closed-family receipt. Any earlier failure leaves it stale.
        finalizeNormalLadybugFamilyClose(lease);
      } else if (
        !familyCloseMustAbandon &&
        closeFailures.length === 0 &&
        lease.mode === "validated-clone"
      ) {
        finalizeValidatedLadybugCloneFamily(lease);
      } else {
        abandonLadybugFamily(lease);
      }
    } catch (error) {
      closeFailures.push(error);
      logger.warn("Error finalizing LadybugDB family lineage", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (lease.released) {
      activeFamilyLease = null;
      familyOwnershipPoisoned = false;
      familyCloseMustAbandon = false;
    } else {
      familyOwnershipPoisoned = true;
      familyCloseMustAbandon = true;
      currentDbPath = lease.dbPath;
    }
  } else if (!activeFamilyLease) {
    familyOwnershipPoisoned = false;
    familyCloseMustAbandon = false;
  }

  logger.debug("LadybugDB closed");
  if (strictCloseForCurrentClose && closeFailures.length > 0) {
    throw new AggregateError(
      closeFailures,
      "LadybugDB strict close failed after cleanup",
    );
  }
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
  writeTotalActiveMs: number;
  writeTotalQueueMs: number;
  writeTotalRuns: number;
  writePeakQueued: number;
  writePeakActive: number;
} {
  const writeStats = writeLimiter?.getStats() ?? {
    active: 0,
    queued: 0,
    totalActiveMs: 0,
    totalQueueMs: 0,
    totalRuns: 0,
    peakQueued: 0,
    peakActive: 0,
  };
  return {
    readPoolSize,
    readPoolInitialized: readPool.length,
    writeInitialized: writeConn !== null,
    writeQueued: writeStats.queued,
    writeActive: writeStats.active,
    writeTotalActiveMs: writeStats.totalActiveMs,
    writeTotalQueueMs: writeStats.totalQueueMs,
    writeTotalRuns: writeStats.totalRuns,
    writePeakQueued: writeStats.peakQueued,
    writePeakActive: writeStats.peakActive,
  };
}

/**
 * Return all read pool connections. Used by the migration runner
 * to clear prepared statement caches after DDL changes.
 */
export function getReadPool(): readonly import("kuzu").Connection[] {
  return readPool;
}

/**
 * Snapshot of read-pool health used by callers that should back off when
 * the DB is unresponsive (e.g. the file watcher). `stuck` counts read conns
 * whose in-flight task has exceeded the watchdog threshold in ladybug-core.
 * `healthy=true` iff fewer than half of the pool is currently stuck.
 */
export function getReadPoolHealth(): {
  total: number;
  stuck: number;
  healthy: boolean;
} {
  const total = readPool.length;
  let stuck = 0;
  for (const conn of readPool) {
    if (isConnStuck(conn)) stuck += 1;
  }
  // Unhealthy when at least half the conns are flagged stuck. (For a
  // 1-conn pool, any stuck conn = unhealthy.) total === 0 means the pool
  // is not initialized yet; treat as healthy so callers don't pre-emptively
  // back off during startup.
  const healthy = total === 0 ? true : stuck * 2 < total;
  return { total, stuck, healthy };
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
