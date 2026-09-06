import { watch } from "fs";
import { isAbsolute, relative, resolve, basename } from "path";

import type { RepoConfig } from "../config/types.js";
import {
  WATCHER_ERROR_MAX_COUNT,
  WATCHER_STALE_THRESHOLD_MS,
  WATCHER_DEFAULT_MAX_WATCHED_FILES,
} from "../config/constants.js";
import { loadConfig } from "../config/loadConfig.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { normalizePath } from "../util/paths.js";
import { getDefaultLiveIndexCoordinator } from "../live-index/coordinator.js";
import type { LiveIndexCoordinator } from "../live-index/types.js";
import { dirtyPathMatchesScipGeneratorConfig } from "../scip/scip-io-runner.js";
import { logWatcherHealthTelemetry } from "../mcp/telemetry.js";
import { logger } from "../util/logger.js";
import { globToSafeRegex } from "../util/safeRegex.js";

import type { IndexWatchHandle, WatcherHealth } from "./indexer.js";
import { getLanguageExtensions } from "./fileScanner.js";
import {
  PROVIDER_ORDER,
  WATCHMAN_WARNING_MAX_COUNT,
  cacheAutoWatchmanFailure,
  getCachedAutoWatchmanFailure,
  isWatchmanRecrawlWarning,
  startWatchmanRuntimeWatcher,
  type ProviderEvent,
  type RuntimeWatcher,
  type WatcherProviderName,
} from "./watchman-provider.js";
import {
  processWatchedFileChange,
  type IndexRepoFn,
} from "./watcher-change-processor.js";

export {
  classifyWatcherReindexFailure,
  processWatchedFileChange,
} from "./watcher-change-processor.js";
export type {
  IndexRepoFn,
  WatcherReindexFailureDisposition,
} from "./watcher-change-processor.js";

// Local interface for chokidar FSWatcher to avoid 'as any' casts

interface ChokidarWatcher {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, fn: (...args: any[]) => void): this;
  close(): Promise<void>;
  getWatched?(): Record<string, string[]>;
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

const watcherErrors: string[] = [];
type MutableWatcherHealth = WatcherHealth & { pendingChanges: number };
const watcherHealthByRepo = new Map<string, MutableWatcherHealth>();

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

/** Only unaccepted watcher events are stale; queued reconciliation has its own status. */
export function isWatcherStale(health: { pendingChanges: number }): boolean {
  return health.pendingChanges > 0;
}

/** Classify once, then synchronously invalidate shared work before any asynchronous recovery. */
export function admitWatcherEvent(params: {
  repoId: string;
  repoRoot: string;
  repoConfig: RepoConfig;
  extensions: readonly string[];
  compiledIgnorePatterns: readonly RegExp[];
  coordinator: Pick<
    LiveIndexCoordinator,
    "recordDiskChange" | "requestReconcileInventory" | "invalidateSourceContext"
  >;
  event: ProviderEvent;
}): boolean | null {
  const { repoId, coordinator, event } = params;
  if (event.type === "resync") {
    if (event.relativePath) {
      const path = toRepoRelativeWatchPath(params.repoRoot, event.relativePath);
      if (path && shouldIgnorePath(path, params.compiledIgnorePatterns, true))
        return null;
    }
    return coordinator.requestReconcileInventory?.(repoId) ?? false;
  }
  const filePath = toRepoRelativeWatchPath(params.repoRoot, event.relativePath);
  if (!filePath)
    return coordinator.requestReconcileInventory?.(repoId) ?? false;
  if (shouldIgnorePath(filePath, params.compiledIgnorePatterns)) return null;
  const projectInput =
    dirtyPathMatchesScipGeneratorConfig(filePath) ||
    [
      params.repoConfig.packageJsonPath,
      params.repoConfig.tsconfigPath,
      params.repoConfig.sourceFileListPath,
    ].some(
      (path) =>
        path && toRepoRelativeWatchPath(params.repoRoot, path) === filePath,
    );
  if (projectInput) {
    coordinator.invalidateSourceContext?.(repoId);
    return (
      coordinator.requestReconcileInventory?.(repoId, { force: true }) ?? false
    );
  }
  if (!matchesExtensions(filePath, params.extensions)) return null;
  return processWatchedFileChange({
    repoId,
    filePath,
    removed: event.removed,
    coordinator,
  });
}

/** Raw events bypass Chokidar's 50ms normalized-change throttle. */
export function chokidarRawEvent(
  event: string,
  path: unknown,
  details: unknown,
  watchedDirectories: ReadonlySet<string>,
): ProviderEvent {
  if (typeof path !== "string" || !path)
    return { type: "resync", reason: "chokidar missing raw filename" };
  let absolutePath: string;
  if (isAbsolute(path)) absolutePath = path;
  else {
    const watchedPath =
      details && typeof details === "object" && "watchedPath" in details
        ? details.watchedPath
        : undefined;
    if (typeof watchedPath !== "string" || !isAbsolute(watchedPath))
      return { type: "resync", reason: "chokidar ambiguous raw filename" };
    if (watchedDirectories.has(normalizePath(watchedPath)))
      absolutePath = resolve(watchedPath, path);
    else if (basename(watchedPath) === path) absolutePath = watchedPath;
    else return { type: "resync", reason: "chokidar ambiguous raw watch root" };
  }
  if (event !== "change" || watchedDirectories.has(normalizePath(absolutePath)))
    return {
      type: "resync",
      reason: "chokidar raw structural event",
      relativePath: absolutePath,
    };
  return { type: "path", relativePath: absolutePath };
}

export async function watchRepositoryWithIndexer(
  repoId: string,
  _indexRepo: IndexRepoFn,
  isWriteReady: () => boolean = () => true,
  options: { coordinator?: LiveIndexCoordinator } = {},
): Promise<IndexWatchHandle> {
  const conn = await getLadybugConn();
  const repoRow = await ladybugDb.getRepo(conn, repoId);
  if (!repoRow) {
    throw new Error(`Repository ${repoId} not found`);
  }
  const coordinator = options.coordinator ?? getDefaultLiveIndexCoordinator();
  coordinator.setReconciliationReadiness?.(repoId, isWriteReady);

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

  let activeWatcher: RuntimeWatcher | null = null;
  let closed = false;
  let restarting = false;
  let lastRestartMs = 0;
  let providerFailureActive = false;
  const staleCheckIntervalMs = Math.max(
    5_000,
    Math.floor(WATCHER_STALE_THRESHOLD_MS / 4),
  );

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
        hint:
          "Inspect the bounded watcher errors and graph-integrity status. " +
          "Check retained reconciliation work and provider readiness before retrying.",
      });
    }
  };

  const markEventReceived = (): void => {
    health.eventsReceived += 1;
    health.lastEventAt = new Date().toISOString();
  };

  const handleProviderEvent = (event: ProviderEvent): void => {
    if (closed) return;
    const accepted = admitWatcherEvent({
      repoId,
      repoRoot: repoRow.rootPath,
      repoConfig,
      extensions,
      compiledIgnorePatterns,
      coordinator,
      event,
    });
    if (accepted === null) return;
    markEventReceived();
    if (accepted) {
      // This counts accepted events, never completed graph publications.
      health.eventsProcessed += 1;
      if (event.type === "resync") health.pendingChanges = 0;
    } else {
      health.pendingChanges += 1;
      recordWatcherError(
        `[sdl-mcp] Reconciliation admission refused for ${repoId}`,
      );
    }
    health.queueDepth = health.pendingChanges;
    health.stale = providerFailureActive || isWatcherStale(health);
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
      // Queue invalidation must observe the first event, before worker debounce.
      awaitWriteFinish: false,
      atomic: false,
    });
    const typedWatcher = watcher as ChokidarWatcher;
    const watchedDirectories = new Set<string>();
    typedWatcher.on("raw", (event: string, path: unknown, details: unknown) => {
      handleProviderEvent(
        chokidarRawEvent(event, path, details, watchedDirectories),
      );
    });

    const readyPromise = new Promise<void>((resolveReady) => {
      typedWatcher.on("ready", () => {
        const watched = typedWatcher.getWatched?.();
        if (watched && typeof watched === "object") {
          // Filter to files matching the configured source extensions.
          // chokidar.getWatched() returns ALL files in watched dirs,
          // including .git, build artifacts, lockfiles, and other noise.
          // The user-meaningful number is "how many indexable source
          // files are we tracking", not "how many fs entries".
          for (const directory of Object.keys(watched))
            watchedDirectories.add(normalizePath(directory));
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

    const chokidarHandler = (filePath: string, removed = false): void => {
      const relPath = normalizePath(relative(repoRow.rootPath, filePath));
      handleProviderEvent({ type: "path", relativePath: relPath, removed });
    };

    typedWatcher.on("add", (filePath: string) => chokidarHandler(filePath));
    typedWatcher.on("change", (filePath: string) => chokidarHandler(filePath));
    typedWatcher.on("unlink", (filePath: string) =>
      chokidarHandler(filePath, true),
    );
    typedWatcher.on("addDir", (filePath: string) => {
      watchedDirectories.add(normalizePath(filePath));
      handleProviderEvent({
        type: "resync",
        reason: "directory added",
        relativePath: filePath,
      });
    });
    typedWatcher.on("unlinkDir", (filePath: string) => {
      watchedDirectories.delete(normalizePath(filePath));
      handleProviderEvent({
        type: "resync",
        reason: "directory removed",
        relativePath: filePath,
      });
    });

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
        if (!filename || _eventType === "rename") {
          handleProviderEvent({
            type: "resync",
            reason: "ambiguous filesystem event",
            relativePath: filename?.toString(),
          });
          // A named source still invalidates immediately, even during inventory.
          if (!filename) return;
        }
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
        let watcher = await startProvider(provider);
        health.provider = watcher.provider;
        health.fallbackReason =
          fallbackReasons.length > 0 ? fallbackReasons.join("; ") : null;
        health.running = true;
        providerFailureActive = false;
        const ready = watcher.ready.then(() => {
          handleProviderEvent({ type: "resync", reason: "watcher ready" });
        });
        watcher = { ...watcher, ready };
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
      unacceptedEvents: health.pendingChanges,
    });
    // Accepted work belongs to the coordinator and survives provider replacement.
    handleProviderEvent({ type: "resync", reason: "watcher restarting" });
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

      health.running = false;
      health.stale = false;
      if (activeWatcher) {
        await activeWatcher.close();
      }
      watcherHealthByRepo.delete(repoId);
    },
  };
}

function matchesExtensions(
  path: string,
  extensions: readonly string[],
): boolean {
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
