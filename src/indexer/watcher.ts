import { watch } from "fs";
import { createRequire } from "module";
import { relative } from "path";

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
  WATCHER_DEFAULT_MAX_WATCHED_FILES,
} from "../config/constants.js";
import { loadConfig } from "../config/loadConfig.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { normalizePath } from "../util/paths.js";
import { patchSavedFile } from "../live-index/file-patcher.js";

import type { IndexWatchHandle, WatcherHealth } from "./indexer.js";
import { logger } from "../util/logger.js";

// Local interface for chokidar FSWatcher to avoid 'as any' casts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      await patchSavedFileFn({ repoId, filePath });
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

type ChokidarModule = { watch: (path: string, options?: unknown) => unknown };

const require = createRequire(import.meta.url);

function loadChokidar(): ChokidarModule | null {
  try {
    return require("chokidar");
  } catch {
    return null;
  }
}

const watcherErrors: string[] = [];
type MutableWatcherHealth = WatcherHealth & { pendingChanges: number };
type RuntimeWatcher = { close: () => Promise<void>; ready: Promise<void> };

const watcherHealthByRepo = new Map<string, MutableWatcherHealth>();

function cloneWatcherHealth(state: MutableWatcherHealth): WatcherHealth {
  return {
    enabled: state.enabled,
    running: state.running,
    filesWatched: state.filesWatched,
    eventsReceived: state.eventsReceived,
    eventsProcessed: state.eventsProcessed,
    errors: state.errors,
    queueDepth: state.queueDepth,
    restartCount: state.restartCount,
    stale: state.stale,
    lastEventAt: state.lastEventAt,
    lastSuccessfulReindexAt: state.lastSuccessfulReindexAt,
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
    filesWatched: 0,
    eventsReceived: 0,
    eventsProcessed: 0,
    errors: 0,
    queueDepth: 0,
    restartCount: 0,
    stale: false,
    lastEventAt: null,
    lastSuccessfulReindexAt: null,
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

export async function watchRepositoryWithIndexer(
  repoId: string,
  indexRepo: IndexRepoFn,
): Promise<IndexWatchHandle> {
  const conn = await getLadybugConn();
  const repoRow = await ladybugDb.getRepo(conn, repoId);
  if (!repoRow) {
    throw new Error(`Repository ${repoId} not found`);
  }

  const repoConfig: RepoConfig = JSON.parse(repoRow.configJson);
  const ignorePatterns = repoConfig.ignore ?? [];
  const extensions = repoConfig.languages.map((lang) => `.${lang}`);

  const appConfig = loadConfig();
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
    filesWatched: estimatedFileCount,
    eventsReceived: 0,
    eventsProcessed: 0,
    errors: 0,
    queueDepth: 0,
    restartCount: 0,
    stale: false,
    lastEventAt: null,
    lastSuccessfulReindexAt: null,
    pendingChanges: 0,
  };
  watcherHealthByRepo.set(repoId, health);

  const pending = new Map<string, NodeJS.Timeout>();
  let activeWatcher: RuntimeWatcher | null = null;
  let closed = false;
  let restarting = false;
  let lastRestartMs = 0;
  const staleCheckIntervalMs = Math.max(
    5_000,
    Math.floor(WATCHER_STALE_THRESHOLD_MS / 4),
  );

  const updateQueueDepth = (): void => {
    health.queueDepth = pending.size;
  };

  const recordWatcherError = (message: string): void => {
    health.errors += 1;
    logger.warn(message);
    watcherErrors.push(`${new Date().toISOString()} - ${message}`);
    if (watcherErrors.length > WATCHER_ERROR_MAX_COUNT) {
      watcherErrors.shift();
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
  ): Promise<void> => {
    try {
      logger.debug("File change detected", { filePath });
      await processWatchedFileChange({
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
      health.eventsProcessed += 1;
      health.pendingChanges = Math.max(0, health.pendingChanges - 1);
      health.lastSuccessfulReindexAt = new Date().toISOString();
      health.stale = false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      recordWatcherError(
        `[sdl-mcp] Failed incremental index for ${filePath}: ${msg}`,
      );
      if (attempt + 1 < WATCHER_REINDEX_MAX_ATTEMPTS && !closed) {
        const delay = Math.min(
          WATCHER_REINDEX_RETRY_MAX_MS,
          WATCHER_REINDEX_RETRY_BASE_MS * 2 ** attempt,
        );
        setTimeout(() => {
          void reindexWithRetry(filePath, attempt + 1).catch((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            recordWatcherError(`[sdl-mcp] reindexWithRetry failed: ${errMsg}`);
          });
        }, delay);
      } else {
        // All retry attempts exhausted; decrement pending so stale detection stays accurate
        health.pendingChanges = Math.max(0, health.pendingChanges - 1);
      }
    }
  };

  const debounceMs = appConfig.indexing?.watchDebounceMs ?? WATCH_DEBOUNCE_MS;

  const schedule = (filePath: string): void => {
    const existing = pending.get(filePath);
    if (existing) {
      clearTimeout(existing);
    } else {
      health.pendingChanges += 1;
    }
    pending.set(
      filePath,
      setTimeout(() => {
        pending.delete(filePath);
        updateQueueDepth();
        void reindexWithRetry(filePath).catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          recordWatcherError(`[sdl-mcp] reindexWithRetry failed: ${errMsg}`);
        });
      }, debounceMs),
    );
    updateQueueDepth();
  };

  const handler = (relativeFilePath: string): void => {
    const normalizedFilePath = normalizePath(relativeFilePath);
    if (shouldIgnorePath(normalizedFilePath, ignorePatterns)) {
      return;
    }
    if (!matchesExtensions(normalizedFilePath, extensions)) {
      return;
    }
    markEventReceived();
    schedule(normalizedFilePath);
  };

  const startWatcher = (): RuntimeWatcher => {
    const chokidar = loadChokidar();
    if (chokidar) {
      const watcher = chokidar.watch(repoRow.rootPath, {
        ignored: ignorePatterns,
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
            const count = Object.values(watched).reduce(
              (total, entries) => total + entries.length,
              0,
            );
            health.filesWatched = count;
          }
          resolveReady();
        });
      });

      const chokidarHandler = (filePath: string): void => {
        const relPath = normalizePath(relative(repoRow.rootPath, filePath));
        handler(relPath);
      };

      typedWatcher.on("add", chokidarHandler);
      typedWatcher.on("change", chokidarHandler);
      typedWatcher.on("unlink", chokidarHandler);

      typedWatcher.on("error", (error: Error) => {
        recordWatcherError(`[sdl-mcp] File watcher error: ${error}`);
      });

      return {
        ready: readyPromise,
        close: async () => {
          await typedWatcher.close();
        },
      };
    }

    const fsWatcher = watch(
      repoRow.rootPath,
      { recursive: true },
      (_eventType, filename) => {
        if (!filename) return;
        handler(normalizePath(filename.toString()));
      },
    );

    return {
      ready: Promise.resolve(),
      close: async () => {
        fsWatcher.close();
      },
    };
  };

  const restartWatcher = async (reason: string): Promise<void> => {
    if (closed || restarting) {
      return;
    }
    const now = Date.now();
    if (now - lastRestartMs < WATCHER_STALE_THRESHOLD_MS / 2) {
      return;
    }
    restarting = true;
    lastRestartMs = now;
    health.restartCount += 1;
    logger.info("Restarting watcher", { repoId, reason });
    try {
      if (activeWatcher) {
        await activeWatcher.close();
      }
      activeWatcher = startWatcher();
      health.running = true;
      health.stale = false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      recordWatcherError(
        `[sdl-mcp] Failed to restart watcher for ${repoId}: ${msg}`,
      );
    } finally {
      restarting = false;
    }
  };

  const staleTimer = setInterval(() => {
    if (closed) {
      return;
    }
    if (health.pendingChanges <= 0) {
      health.stale = false;
      return;
    }
    const lastSuccessMs = health.lastSuccessfulReindexAt
      ? Date.parse(health.lastSuccessfulReindexAt)
      : 0;
    const stale =
      lastSuccessMs === 0 ||
      Date.now() - lastSuccessMs > WATCHER_STALE_THRESHOLD_MS;
    health.stale = stale;
    if (stale) {
      const staleMsg = `[sdl-mcp] Watcher stale detected for ${repoId}: pending=${health.pendingChanges}, queueDepth=${health.queueDepth}`;
      recordWatcherError(staleMsg);
      void restartWatcher("stale-index-detected").catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        recordWatcherError(`[sdl-mcp] restartWatcher failed: ${errMsg}`);
      });
    }
  }, staleCheckIntervalMs);

  activeWatcher = startWatcher();

  return {
    ready: activeWatcher.ready,
    close: async () => {
      closed = true;
      clearInterval(staleTimer);
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
      updateQueueDepth();
      health.running = false;
      health.pendingChanges = 0;
      health.stale = false;
      if (activeWatcher) {
        await activeWatcher.close();
      }
    },
  };
}

function matchesExtensions(path: string, extensions: string[]): boolean {
  return extensions.some((ext) => path.endsWith(ext));
}

function shouldIgnorePath(path: string, ignorePatterns: string[]): boolean {
  const normalized = normalizePath(path);
  for (const pattern of ignorePatterns) {
    const token = pattern
      .replace(/\*\*\//g, "")
      .replace(/\/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/\/+/g, "/")
      .trim();
    if (!token) continue;
    if (normalized.includes(token)) {
      return true;
    }
  }
  return false;
}
