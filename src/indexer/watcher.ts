import { watch } from "fs";
import { isAbsolute, relative } from "path";

import type { RepoConfig } from "../config/types.js";
import {
  WATCH_DEBOUNCE_MS,
  WATCH_STABILITY_THRESHOLD_MS,
  WATCH_POLL_INTERVAL_MS,
  WATCHER_ERROR_MAX_COUNT,
  WATCHER_STALE_THRESHOLD_MS,
  WATCHER_REINDEX_RETRY_BASE_MS,
  WATCHER_REINDEX_RETRY_MAX_MS,
  WATCHER_REINDEX_MAX_ATTEMPTS,
  WATCHER_REINDEX_OPERATION_TIMEOUT_MS,
  WATCHER_DEFAULT_MAX_WATCHED_FILES,
} from "../config/constants.js";
import { loadConfig } from "../config/loadConfig.js";
import { getLadybugConn, getReadPoolHealth } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { normalizePath } from "../util/paths.js";
import { patchSavedFile } from "../live-index/file-patcher.js";
import { withIndexingGate } from "../mcp/indexing-gate.js";
import { globToSafeRegex } from "../util/safeRegex.js";

import type { IndexWatchHandle, WatcherHealth } from "./indexer.js";
import { getLanguageExtensions } from "./fileScanner.js";
import {
  PROVIDER_ORDER,
  WATCHER_RESYNC_KEY,
  WATCHMAN_WARNING_MAX_COUNT,
  cacheAutoWatchmanFailure,
  getCachedAutoWatchmanFailure,
  isWatchmanRecrawlWarning,
  startWatchmanRuntimeWatcher,
  type ProviderEvent,
  type RuntimeWatcher,
  type WatcherProviderName,
} from "./watchman-provider.js";
import { logger } from "../util/logger.js";
import { logWatcherHealthTelemetry } from "../mcp/telemetry.js";

// Local interface for chokidar FSWatcher to avoid 'as any' casts

interface ChokidarWatcher {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, fn: (...args: any[]) => void): this;
  close(): Promise<void>;
  getWatched?(): Record<string, string[]>;
}

export type IndexRepoFn = (
  repoId: string,
  mode: "full" | "incremental",
) => Promise<unknown>;

export async function processWatchedFileChange(params: {
  repoId: string;
  filePath: string;
  indexRepo: IndexRepoFn;
  patchSavedFileFn?: (input: {
    repoId: string;
    filePath: string;
  }) => Promise<unknown>;
}): Promise<void> {
  const { repoId, filePath, indexRepo, patchSavedFileFn } = params;
  if (patchSavedFileFn) {
    try {
      await withIndexingGate(() => patchSavedFileFn({ repoId, filePath }));
      return;
    } catch (patchError: unknown) {
      // Fall back to repo-wide incremental indexing below.
      logger.debug("patchSavedFile failed, falling back to incremental index", {
        repoId,
        filePath,
        error:
          patchError instanceof Error ? patchError.message : String(patchError),
      });
    }
  }

  await indexRepo(repoId, "incremental");
}

type ChokidarModule = {
  watch: (
    paths: string | string[],
    options?: Record<string, unknown>,
  ) => unknown;
};
type ChokidarIgnoredPredicate = (
  path: string,
  stats?: { isDirectory?(): boolean },
) => boolean;

async function loadChokidar(): Promise<ChokidarModule | null> {
  try {
    return await import("chokidar");
  } catch (err) {
    logger.debug(
      "[sdl-mcp] chokidar not available: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

// Keep the historical watcher.ts test surface stable after extracting
// Watchman provider internals into a dedicated module.
export {
  _buildWatchmanStartupResyncForTesting,
  _buildWatchmanSubscriptionForTesting,
  _normalizeWatchmanFileNameForTesting,
  _probeWatchmanClientAvailabilityForTesting,
  _selectWatcherProviderForTesting,
  _watchmanAvailabilityForTesting,
  _watchmanCommandWithTimeoutForTesting,
  _watchmanResponseHasResyncSignalForTesting,
} from "./watchman-provider.js";

/**
 * @internal
 */
export function _drainPendingWatcherChangesForTesting(
  pending: Map<string, { timer: NodeJS.Timeout }>,
  health: PendingWatcherHealthCounters,
): void {
  drainPendingWatcherChanges(pending, health);
}

/**
 * @internal
 */
export function _decrementPendingChangeForGenerationForTesting(
  health: Pick<PendingWatcherHealthCounters, "pendingChanges">,
  currentGeneration: number,
  attemptGeneration: number,
): boolean {
  return decrementPendingChangeForGeneration(
    health,
    currentGeneration,
    attemptGeneration,
  );
}

/**
 * @internal
 */
export function _rotateAbortControllerForTesting(
  controller: AbortController,
): AbortController {
  return rotateAbortController(controller);
}

/**
 * @internal
 */
export function _startWatcherReindexForTesting(
  state: WatcherReindexCoalescer,
): boolean {
  return startWatcherReindex(state);
}

/**
 * @internal
 */
export function _finishWatcherReindexForTesting(
  state: WatcherReindexCoalescer,
): boolean {
  return finishWatcherReindex(state);
}

const watcherErrors: string[] = [];
type MutableWatcherHealth = WatcherHealth & { pendingChanges: number };
type PendingWatcherChange = {
  timer: NodeJS.Timeout;
  filePath: string;
  forceIncremental: boolean;
  generation: number;
};
type PendingWatcherHealthCounters = {
  pendingChanges: number;
  queueDepth: number;
};
type WatcherReindexCoalescer = {
  active: boolean;
  dirty: boolean;
};

const watcherHealthByRepo = new Map<string, MutableWatcherHealth>();

function drainPendingWatcherChanges<T extends Pick<PendingWatcherChange, "timer">>(
  pending: Map<string, T>,
  health: PendingWatcherHealthCounters,
): void {
  for (const change of pending.values()) {
    clearTimeout(change.timer);
  }
  pending.clear();
  health.pendingChanges = 0;
  health.queueDepth = 0;
}

function decrementPendingChangeForGeneration(
  health: Pick<PendingWatcherHealthCounters, "pendingChanges">,
  currentGeneration: number,
  attemptGeneration: number,
): boolean {
  if (currentGeneration !== attemptGeneration) {
    return false;
  }
  health.pendingChanges = Math.max(0, health.pendingChanges - 1);
  return true;
}

function startWatcherReindex(state: WatcherReindexCoalescer): boolean {
  if (state.active) {
    state.dirty = true;
    return false;
  }
  state.active = true;
  return true;
}

function finishWatcherReindex(state: WatcherReindexCoalescer): boolean {
  if (!state.active) {
    return false;
  }
  state.active = false;
  const shouldRunFollowUp = state.dirty;
  state.dirty = false;
  return shouldRunFollowUp;
}

function resetWatcherReindex(state: WatcherReindexCoalescer): void {
  state.active = false;
  state.dirty = false;
}

function rotateAbortController(controller: AbortController): AbortController {
  controller.abort();
  return new AbortController();
}

function cloneWatcherHealth(state: MutableWatcherHealth): WatcherHealth {
  return {
    enabled: state.enabled,
    running: state.running,
    provider: state.provider,
    configuredProvider: state.configuredProvider,
    fallbackReason: state.fallbackReason,
    filesWatched: state.filesWatched,
    eventsReceived: state.eventsReceived,
    eventsProcessed: state.eventsProcessed,
    errors: state.errors,
    queueDepth: state.queueDepth,
    restartCount: state.restartCount,
    stale: state.stale,
    lastEventAt: state.lastEventAt,
    lastSuccessfulReindexAt: state.lastSuccessfulReindexAt,
    watchmanVersion: state.watchmanVersion,
    watchmanWarningCount: state.watchmanWarningCount,
    watchmanWarnings: state.watchmanWarnings
      ? [...state.watchmanWarnings]
      : undefined,
    watchmanRecrawlCount: state.watchmanRecrawlCount,
    watchmanFreshInstanceCount: state.watchmanFreshInstanceCount,
    watchmanWatchRoot: state.watchmanWatchRoot,
    watchmanRelativePath: state.watchmanRelativePath,
    watchmanLastClock: state.watchmanLastClock,
  };
}

export function getWatcherHealth(repoId: string): WatcherHealth | null {
  const state = watcherHealthByRepo.get(repoId);
  return state ? cloneWatcherHealth(state) : null;
}

export function getAllWatcherHealth(): Record<string, WatcherHealth> {
  const out: Record<string, WatcherHealth> = {};
  for (const [repoId, state] of watcherHealthByRepo.entries()) {
    out[repoId] = cloneWatcherHealth(state);
  }
  return out;
}

/**
 * For testing only: seed a watcher health entry without starting a real watcher.
 * @internal
 */
export function _setWatcherHealthForTesting(
  repoId: string,
  health: Partial<WatcherHealth> & { errors?: number },
): void {
  const existing = watcherHealthByRepo.get(repoId);
  const base: MutableWatcherHealth = existing ?? {
    enabled: true,
    running: true,
    provider: null,
    configuredProvider: "auto",
    fallbackReason: null,
    filesWatched: 0,
    eventsReceived: 0,
    eventsProcessed: 0,
    errors: 0,
    queueDepth: 0,
    restartCount: 0,
    stale: false,
    lastEventAt: null,
    lastSuccessfulReindexAt: null,
    watchmanWarningCount: 0,
    watchmanWarnings: [],
    watchmanRecrawlCount: 0,
    watchmanFreshInstanceCount: 0,
    pendingChanges: 0,
  };
  watcherHealthByRepo.set(repoId, { ...base, ...health, pendingChanges: 0 });
}

/**
 * For testing only: remove a watcher health entry.
 * @internal
 */
export function _clearWatcherHealthForTesting(repoId: string): void {
  watcherHealthByRepo.delete(repoId);
}

export function isWatcherStale(
  health: Pick<
    MutableWatcherHealth,
    "pendingChanges" | "eventsReceived" | "lastSuccessfulReindexAt"
  >,
  nowMs = Date.now(),
): boolean {
  if (health.pendingChanges <= 0) {
    return false;
  }
  if (health.eventsReceived <= 0) {
    return false;
  }

  const lastSuccessMs = health.lastSuccessfulReindexAt
    ? Date.parse(health.lastSuccessfulReindexAt)
    : 0;

  return (
    lastSuccessMs === 0 || nowMs - lastSuccessMs > WATCHER_STALE_THRESHOLD_MS
  );
}

export async function watchRepositoryWithIndexer(
  repoId: string,
  indexRepo: IndexRepoFn,
): Promise<IndexWatchHandle> {
  const conn = await getLadybugConn();
  const repoRow = await ladybugDb.getRepo(conn, repoId);
  if (!repoRow) {
    throw new Error(`Repository ${repoId} not found`);
  }

  let repoConfig: RepoConfig;
  try {
    repoConfig = JSON.parse(repoRow.configJson);
  } catch {
    logger.error("Corrupt configJson for repo", { repoId });
    throw new Error(`Corrupt configJson for repo ${repoId}`);
  }
  const ignorePatterns = repoConfig.ignore ?? [];
  const compiledIgnorePatterns = compileIgnorePatterns(ignorePatterns);
  const extensions = getLanguageExtensions(repoConfig.languages);

  const appConfig = loadConfig();
  const configuredProvider = appConfig.indexing?.watchProvider ?? "auto";
  const maxWatchedFiles =
    appConfig.indexing?.maxWatchedFiles ?? WATCHER_DEFAULT_MAX_WATCHED_FILES;
  const estimatedFileCount = await ladybugDb.getFileCount(conn, repoId);
  if (estimatedFileCount > maxWatchedFiles) {
    throw new Error(
      `Watcher cap exceeded for ${repoId}: ${estimatedFileCount} files > maxWatchedFiles ${maxWatchedFiles}`,
    );
  }

  const health: MutableWatcherHealth = {
    enabled: true,
    running: true,
    provider: null,
    configuredProvider,
    fallbackReason: null,
    filesWatched: estimatedFileCount,
    eventsReceived: 0,
    eventsProcessed: 0,
    errors: 0,
    queueDepth: 0,
    restartCount: 0,
    stale: false,
    lastEventAt: null,
    lastSuccessfulReindexAt: null,
    watchmanWarningCount: 0,
    watchmanWarnings: [],
    watchmanRecrawlCount: 0,
    watchmanFreshInstanceCount: 0,
    watchmanRelativePath: null,
    watchmanLastClock: null,
    pendingChanges: 0,
  };
  watcherHealthByRepo.set(repoId, health);

  const pending = new Map<string, PendingWatcherChange>();
  let activeWatcher: RuntimeWatcher | null = null;
  let closed = false;
  let restarting = false;
  let lastRestartMs = 0;
  let providerFailureActive = false;
  let watcherGeneration = 0;
  // AbortController for in-flight reindex operations. close() and
  // restartWatcher() abort it so a late-completing reindex doesn't decrement
  // pendingChanges twice or schedule retries against a stale watcher state.
  let abortController = new AbortController();
  const reindexCoalescer: WatcherReindexCoalescer = {
    active: false,
    dirty: false,
  };
  let scheduleFollowUpReindex: (() => void) | null = null;
  const staleCheckIntervalMs = Math.max(
    5_000,
    Math.floor(WATCHER_STALE_THRESHOLD_MS / 4),
  );

  const updateQueueDepth = (): void => {
    health.queueDepth = pending.size;
  };

  const clearPendingChanges = (): void => {
    watcherGeneration += 1;
    abortController = rotateAbortController(abortController);
    resetWatcherReindex(reindexCoalescer);
    drainPendingWatcherChanges(pending, health);
  };

  const recordWatcherError = (message: string): void => {
    health.errors += 1;
    logger.warn(message);
    watcherErrors.push(`${new Date().toISOString()} - ${message}`);
    if (watcherErrors.length > WATCHER_ERROR_MAX_COUNT) {
      watcherErrors.splice(0, watcherErrors.length - WATCHER_ERROR_MAX_COUNT);
    }
    if (health.errors >= WATCHER_ERROR_MAX_COUNT && !health.stale) {
      health.stale = true;
      logger.error("Watcher error budget exceeded", {
        repoId,
        hint: "Run: sdl-mcp index --force",
      });
    }
  };

  const markEventReceived = (): void => {
    health.eventsReceived += 1;
    health.lastEventAt = new Date().toISOString();
  };

  const reindexWithRetry = async (
    filePath: string,
    attempt = 0,
    options: { forceIncremental?: boolean; generation?: number } = {},
  ): Promise<void> => {
    // Snapshot the abort signal at entry. If restartWatcher() or close()
    // swaps abortController out from under us during the await, the snapshot
    // still tracks the cancellation we care about for THIS reindex.
    const abortSignal = abortController.signal;
    const generation = options.generation ?? watcherGeneration;
    const ownsReindex =
      attempt === 0 ? startWatcherReindex(reindexCoalescer) : true;
    let scheduledRetry = false;
    let attemptTimedOut = false;
    try {
      if (attempt === 0 && !ownsReindex) {
        return;
      }
      // Health gate: bail before touching the DB if the read pool is
      // already wedged. Avoids piling on more 60s reindex timeouts when
      // a native call is hung. The catch block below schedules a
      // backoff retry; pool typically recovers within seconds once the
      // hung writer settles or the watchdog flips the conn.
      const poolHealth = getReadPoolHealth();
      if (!poolHealth.healthy) {
        throw new Error(
          `read pool unhealthy (stuck=${poolHealth.stuck}/${poolHealth.total}); deferring reindex`,
        );
      }
      logger.debug(
        options.forceIncremental
          ? "Watcher resync requested"
          : "File change detected",
        { filePath },
      );
      // Bound the operation: the underlying patchSavedFile / indexRepo path
      // routes through `withWriteConn`, whose limiter has a 30s queue
      // timeout — but if the in-flight write itself stalls inside Ladybug,
      // the call hangs indefinitely, freezing pendingChanges and turning
      // watcher stale-restart into a no-op. The timeout treats the attempt
      // as a failure without spawning retries behind uncancelled work.
      let timeoutTimer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          attemptTimedOut = true;
          reject(
            new Error(
              `reindex attempt timed out after ${WATCHER_REINDEX_OPERATION_TIMEOUT_MS}ms`,
            ),
          );
        }, WATCHER_REINDEX_OPERATION_TIMEOUT_MS);
        timeoutTimer.unref();
      });
      try {
        const work = options.forceIncremental
          ? indexRepo(repoId, "incremental")
          : processWatchedFileChange({
              repoId,
              filePath,
              indexRepo,
              patchSavedFileFn: ({
                repoId: changedRepoId,
                filePath: changedFilePath,
              }) =>
                patchSavedFile({
                  repoId: changedRepoId,
                  filePath: changedFilePath,
                }),
            });
        await Promise.race([work, timeoutPromise]);
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
      if (closed || abortSignal.aborted || generation !== watcherGeneration) {
        return;
      }
      health.eventsProcessed += 1;
      health.lastSuccessfulReindexAt = new Date().toISOString();
      if (!providerFailureActive) {
        health.stale = false;
      }
    } catch (error) {
      if (closed || abortSignal.aborted || generation !== watcherGeneration) {
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      recordWatcherError(
        `[sdl-mcp] Failed incremental index for ${filePath}: ${msg}`,
      );
      if (
        !attemptTimedOut &&
        attempt + 1 < WATCHER_REINDEX_MAX_ATTEMPTS &&
        !closed &&
        !abortSignal.aborted &&
        generation === watcherGeneration
      ) {
        const delay = Math.min(
          WATCHER_REINDEX_RETRY_MAX_MS,
          WATCHER_REINDEX_RETRY_BASE_MS * 2 ** attempt,
        );
        scheduledRetry = true;
        setTimeout(() => {
          // Re-check abort/closed at retry firing time so a watcher restart
          // between schedule and fire doesn't reindex against stale state.
          if (
            closed ||
            abortSignal.aborted ||
            generation !== watcherGeneration
          ) {
            decrementPendingChangeForGeneration(
              health,
              watcherGeneration,
              generation,
            );
            return;
          }
          void reindexWithRetry(filePath, attempt + 1, {
            ...options,
            generation,
          }).catch((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            recordWatcherError(`[sdl-mcp] reindexWithRetry failed: ${errMsg}`);
          });
        }, delay).unref();
      }
      // exhausted retries fall through to finally for decrement
    } finally {
      if (ownsReindex && !scheduledRetry) {
        const shouldRunFollowUp = finishWatcherReindex(reindexCoalescer);
        if (
          shouldRunFollowUp &&
          !closed &&
          !abortSignal.aborted &&
          generation === watcherGeneration
        ) {
          scheduleFollowUpReindex?.();
        }
      }
      if (!scheduledRetry) {
        decrementPendingChangeForGeneration(
          health,
          watcherGeneration,
          generation,
        );
      }
    }
  };

  const debounceMs = appConfig.indexing?.watchDebounceMs ?? WATCH_DEBOUNCE_MS;

  const schedule = (
    filePath: string,
    options: { forceIncremental?: boolean } = {},
  ): void => {
    const key = options.forceIncremental ? WATCHER_RESYNC_KEY : filePath;
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    } else {
      health.pendingChanges += 1;
    }
    const generation = existing?.generation ?? watcherGeneration;
    const debounceTimer = setTimeout(() => {
      pending.delete(key);
      updateQueueDepth();
      void reindexWithRetry(filePath, 0, {
        forceIncremental:
          options.forceIncremental === true ||
          existing?.forceIncremental === true,
        generation,
      }).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        recordWatcherError(`[sdl-mcp] reindexWithRetry failed: ${errMsg}`);
      });
    }, debounceMs);
    debounceTimer.unref();
    pending.set(key, {
      timer: debounceTimer,
      filePath,
      forceIncremental:
        options.forceIncremental === true || existing?.forceIncremental === true,
      generation,
    });
    updateQueueDepth();
  };

  scheduleFollowUpReindex = () => {
    // Coalesced changes may combine path events and provider resyncs from an
    // active run, so one incremental pass catches the final repository state.
    schedule(repoRow.rootPath, { forceIncremental: true });
  };

  const handler = (relativeFilePath: string): void => {
    const normalizedFilePath = normalizePath(relativeFilePath);
    if (shouldIgnorePath(normalizedFilePath, compiledIgnorePatterns)) {
      return;
    }
    if (!matchesExtensions(normalizedFilePath, extensions)) {
      return;
    }
    markEventReceived();
    schedule(normalizedFilePath);
  };

  const handleProviderEvent = (event: ProviderEvent): void => {
    if (event.type === "path") {
      handler(event.relativePath);
      return;
    }

    markEventReceived();
    health.stale = true;
    logger.warn("Watcher resync requested", {
      repoId,
      provider: health.provider,
      reason: event.reason,
      warning: event.warning,
    });
    // Watchman recrawl/fresh-instance notifications invalidate any queued
    // precise path events, so collapse all pending work into one full
    // incremental pass instead of mixing stale patches with the resync.
    clearPendingChanges();
    schedule(repoRow.rootPath, { forceIncremental: true });
  };

  const disabledAutoProviders = new Map<WatcherProviderName, string>();

  const recordWatchmanWarning = (warning: string): void => {
    const trimmed = warning.trim();
    if (!trimmed) return;
    health.watchmanWarningCount = (health.watchmanWarningCount ?? 0) + 1;
    const warnings = health.watchmanWarnings ?? [];
    warnings.push(trimmed);
    if (warnings.length > WATCHMAN_WARNING_MAX_COUNT) {
      warnings.splice(0, warnings.length - WATCHMAN_WARNING_MAX_COUNT);
    }
    health.watchmanWarnings = warnings;
    if (isWatchmanRecrawlWarning(trimmed)) {
      health.watchmanRecrawlCount = (health.watchmanRecrawlCount ?? 0) + 1;
    }
  };

  const handleWatchmanRuntimeFailure = (detail: string): void => {
    providerFailureActive = true;
    recordWatcherError(`[sdl-mcp] Watchman provider failure: ${detail}`);
    health.running = false;
    health.stale = true;
    health.fallbackReason =
      configuredProvider === "auto" ? `watchman: ${detail}` : detail;
    if (configuredProvider === "auto") {
      disabledAutoProviders.set("watchman", detail);
      void restartWatcher("watchman-runtime-failure", {
        bypassDebounce: true,
        scheduleResyncAfterRestart: true,
        resyncReason: "watchman runtime failure",
      }).catch((restartError: unknown) => {
        const restartMsg =
          restartError instanceof Error
            ? restartError.message
            : String(restartError);
        recordWatcherError(
          `[sdl-mcp] restartWatcher failed after Watchman failure: ${restartMsg}`,
        );
      });
    }
  };

  const startWatchmanProvider = (): Promise<RuntimeWatcher> =>
    startWatchmanRuntimeWatcher({
      repoId,
      repoRoot: repoRow.rootPath,
      configuredProvider,
      extensions,
      health,
      recordWatchmanWarning,
      handleProviderEvent,
      onRuntimeFailure: handleWatchmanRuntimeFailure,
    });
  const startChokidarProvider = async (): Promise<RuntimeWatcher> => {
    const chokidar = await loadChokidar();
    if (!chokidar) {
      throw new Error("chokidar is not installed or could not be loaded");
    }

    const watcher = chokidar.watch(repoRow.rootPath, {
      ignored: createChokidarIgnoredPredicate(
        repoRow.rootPath,
        compiledIgnorePatterns,
      ),
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: WATCH_STABILITY_THRESHOLD_MS,
        pollInterval: WATCH_POLL_INTERVAL_MS,
      },
    });
    const typedWatcher = watcher as ChokidarWatcher;

    const readyPromise = new Promise<void>((resolveReady) => {
      typedWatcher.on("ready", () => {
        const watched = typedWatcher.getWatched?.();
        if (watched && typeof watched === "object") {
          // Filter to files matching the configured source extensions.
          // chokidar.getWatched() returns ALL files in watched dirs,
          // including .git, build artifacts, lockfiles, and other noise.
          // The user-meaningful number is "how many indexable source
          // files are we tracking", not "how many fs entries".
          let count = 0;
          for (const entries of Object.values(watched) as string[][]) {
            for (const entry of entries) {
              if (matchesExtensions(entry, extensions)) count++;
            }
          }
          health.filesWatched = count;
        }
        resolveReady();
      });
    });

    const chokidarHandler = (filePath: string): void => {
      const relPath = normalizePath(relative(repoRow.rootPath, filePath));
      handleProviderEvent({ type: "path", relativePath: relPath });
    };

    typedWatcher.on("add", chokidarHandler);
    typedWatcher.on("change", chokidarHandler);
    typedWatcher.on("unlink", chokidarHandler);

    typedWatcher.on("error", (error: Error) => {
      recordWatcherError(`[sdl-mcp] File watcher error: ${error}`);
    });

    return {
      provider: "chokidar",
      ready: readyPromise,
      close: async () => {
        await typedWatcher.close();
      },
    };
  };

  const startFsWatchProvider = async (): Promise<RuntimeWatcher> => {
    const fsWatcher = watch(
      repoRow.rootPath,
      { recursive: true },
      (_eventType, filename) => {
        if (!filename) return;
        handleProviderEvent({
          type: "path",
          relativePath: normalizePath(filename.toString()),
        });
      },
    );

    return {
      provider: "fsWatch",
      ready: Promise.resolve(),
      close: async () => {
        fsWatcher.close();
      },
    };
  };

  const startProvider = async (
    provider: WatcherProviderName,
  ): Promise<RuntimeWatcher> => {
    switch (provider) {
      case "watchman":
        return startWatchmanProvider();
      case "chokidar":
        return startChokidarProvider();
      case "fsWatch":
        return startFsWatchProvider();
    }
  };

  const startWatcher = async (): Promise<RuntimeWatcher> => {
    const fallbackReasons: string[] = [];
    const order =
      configuredProvider === "auto" ? PROVIDER_ORDER : [configuredProvider];

    for (const provider of order) {
      const disabledReason =
        disabledAutoProviders.get(provider) ??
        getCachedAutoWatchmanFailure(configuredProvider, provider);
      if (configuredProvider === "auto" && disabledReason) {
        fallbackReasons.push(`${provider}: ${disabledReason}`);
        continue;
      }

      try {
        const watcher = await startProvider(provider);
        health.provider = watcher.provider;
        health.fallbackReason =
          fallbackReasons.length > 0 ? fallbackReasons.join("; ") : null;
        health.running = true;
        providerFailureActive = false;
        if (watcher.startupResync) {
          handleProviderEvent(watcher.startupResync);
        }
        return watcher;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (configuredProvider !== "auto") {
          health.provider = provider;
          health.fallbackReason = reason;
          health.running = false;
          health.stale = true;
          providerFailureActive = true;
          throw new Error(
            `Configured watcher provider '${configuredProvider}' failed: ${reason}`,
          );
        }
        cacheAutoWatchmanFailure(configuredProvider, provider, reason);
        fallbackReasons.push(`${provider}: ${reason}`);
        health.fallbackReason = fallbackReasons.join("; ");
        logger.warn("Watcher provider unavailable; trying fallback", {
          repoId,
          provider,
          reason,
        });
      }
    }

    health.provider = null;
    health.running = false;
    health.stale = true;
    providerFailureActive = true;
    throw new Error(
      `No watcher provider available: ${fallbackReasons.join("; ")}`,
    );
  };

  const restartWatcher = async (
    reason: string,
    options: {
      bypassDebounce?: boolean;
      scheduleResyncAfterRestart?: boolean;
      resyncReason?: string;
    } = {},
  ): Promise<void> => {
    if (closed || restarting) {
      return;
    }
    const now = Date.now();
    if (
      options.bypassDebounce !== true &&
      now - lastRestartMs < WATCHER_STALE_THRESHOLD_MS / 2
    ) {
      logger.debug("Restart watcher suppressed by debounce", {
        repoId,
        reason,
        sinceLastRestartMs: now - lastRestartMs,
      });
      return;
    }
    restarting = true;
    lastRestartMs = now;
    health.restartCount += 1;
    logger.info("Restarting watcher", {
      repoId,
      reason,
      abandonedPending: pending.size,
    });
    // Drain stale debounce timers and reset pending counters. Without this,
    // a wedged write conn leaves `pending`/`pendingChanges` frozen for the
    // life of the process — every subsequent stale check restarts the
    // watcher again with the same numbers, so the recovery loop never
    // converges. New file events will re-populate pending naturally.
    clearPendingChanges();
    try {
      if (activeWatcher) {
        await activeWatcher.close();
      }
      activeWatcher = await startWatcher();
      health.running = true;
      if (options.scheduleResyncAfterRestart === true) {
        handleProviderEvent({
          type: "resync",
          reason: options.resyncReason ?? reason,
        });
      } else {
        health.stale = false;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      providerFailureActive = true;
      health.running = false;
      health.stale = true;
      recordWatcherError(
        `[sdl-mcp] Failed to restart watcher for ${repoId}: ${msg}`,
      );
    } finally {
      restarting = false;
    }
  };

  activeWatcher = await startWatcher();

  const staleTimer = setInterval(() => {
    if (closed) {
      return;
    }
    const stale = providerFailureActive || isWatcherStale(health);
    health.stale = stale;
    try {
      logWatcherHealthTelemetry({
        repoId,
        enabled: health.enabled,
        running: health.running,
        provider: health.provider,
        configuredProvider: health.configuredProvider,
        fallbackReason: health.fallbackReason,
        stale: health.stale,
        errors: health.errors,
        queueDepth: health.queueDepth,
        eventsReceived: health.eventsReceived,
        eventsProcessed: health.eventsProcessed,
        restartCount: health.restartCount,
        watchmanVersion: health.watchmanVersion,
        watchmanWarningCount: health.watchmanWarningCount,
        watchmanWarnings: health.watchmanWarnings,
        watchmanRecrawlCount: health.watchmanRecrawlCount,
        watchmanFreshInstanceCount: health.watchmanFreshInstanceCount,
        watchmanWatchRoot: health.watchmanWatchRoot,
        watchmanRelativePath: health.watchmanRelativePath,
        watchmanLastClock: health.watchmanLastClock,
      });
    } catch {
      // observability is best-effort
    }
    if (stale) {
      const staleMsg = `[sdl-mcp] Watcher stale detected for ${repoId}: pending=${health.pendingChanges}, queueDepth=${health.queueDepth}`;
      recordWatcherError(staleMsg);
      void restartWatcher("stale-index-detected").catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        recordWatcherError(`[sdl-mcp] restartWatcher failed: ${errMsg}`);
      });
    }
  }, staleCheckIntervalMs);
  staleTimer.unref();

  return {
    ready: activeWatcher.ready,
    close: async () => {
      closed = true;
      clearInterval(staleTimer);
      clearPendingChanges();
      health.running = false;
      health.stale = false;
      if (activeWatcher) {
        await activeWatcher.close();
      }
      watcherHealthByRepo.delete(repoId);
    },
  };
}

function matchesExtensions(path: string, extensions: string[]): boolean {
  return extensions.some((ext) => path.endsWith(ext));
}

function compileIgnorePatterns(ignorePatterns: readonly string[]): RegExp[] {
  // Keep scanner and watcher on the same raw-pattern compilation path.
  return ignorePatterns.map((pattern) => globToSafeRegex(pattern));
}

function matchesAnyPattern(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

function shouldIgnorePath(
  path: string,
  ignorePatterns: readonly RegExp[],
  isDirectory = false,
): boolean {
  const normalized = normalizePath(path);
  if (!normalized || normalized === ".") {
    return false;
  }
  if (matchesAnyPattern(normalized, ignorePatterns)) {
    return true;
  }
  return isDirectory && matchesAnyPattern(`${normalized}/`, ignorePatterns);
}

function toRepoRelativeWatchPath(
  repoRoot: string,
  candidatePath: string,
): string | null {
  const candidate = candidatePath.trim();
  if (!candidate) return "";

  const relativePath = isAbsolute(candidate)
    ? normalizePath(relative(repoRoot, candidate))
    : normalizePath(candidate).replace(/^\.\//, "");

  if (!relativePath || relativePath === ".") return "";
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath;
}

function createChokidarIgnoredPredicate(
  repoRoot: string,
  ignorePatterns: readonly RegExp[],
): ChokidarIgnoredPredicate {
  // Chokidar v4+ treats string ignores as exact paths, so compile SDL globs
  // into a predicate that can prune ignored directories before watcher setup.
  return (candidatePath, stats) => {
    const relativePath = toRepoRelativeWatchPath(repoRoot, candidatePath);
    if (relativePath === null || relativePath.length === 0) {
      return false;
    }
    return shouldIgnorePath(
      relativePath,
      ignorePatterns,
      stats?.isDirectory?.() ?? false,
    );
  };
}

/**
 * @internal
 */
export function _createChokidarIgnoredPredicateForTesting(
  repoRoot: string,
  ignorePatterns: readonly string[],
): ChokidarIgnoredPredicate {
  return createChokidarIgnoredPredicate(
    repoRoot,
    compileIgnorePatterns(ignorePatterns),
  );
}
