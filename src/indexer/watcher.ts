import { watch } from "fs";
import { isAbsolute, relative } from "path";

import type { RepoConfig, WatchProvider } from "../config/types.js";
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
import { resolveWatchmanBinary } from "./watchman-binary.js";
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

type WatcherProviderName = Exclude<WatchProvider, "auto">;
type ProviderAvailabilityStatus = { available: boolean; reason?: string };
type ProviderAvailability = Record<
  WatcherProviderName,
  ProviderAvailabilityStatus
>;
type ProviderSelection = {
  provider: WatcherProviderName;
  fallbackReason: string | null;
};

const cachedAutoWatchmanFailure = {
  reason: null as string | null,
};
let pendingWatchmanAvailabilityProbe: Promise<ProviderAvailabilityStatus> | null = null;

function getCachedAutoWatchmanFailure(
  configuredProvider: WatchProvider,
  provider: WatcherProviderName,
): string | null {
  if (configuredProvider !== "auto" || provider !== "watchman") {
    return null;
  }
  return cachedAutoWatchmanFailure.reason;
}

function isCacheableAutoWatchmanFailure(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return (
    normalized.includes("watchman was not found in path") ||
    normalized.includes("fb-watchman is not installed") ||
    normalized.includes("could not be loaded") ||
    normalized.includes("failed to spawn watchman server") ||
    normalized.includes("get-sockname returned")
  );
}

function cacheAutoWatchmanFailure(
  configuredProvider: WatchProvider,
  provider: WatcherProviderName,
  reason: string,
): void {
  if (
    configuredProvider === "auto" &&
    provider === "watchman" &&
    isCacheableAutoWatchmanFailure(reason)
  ) {
    cachedAutoWatchmanFailure.reason = reason;
  }
}

function resetCachedAutoWatchmanFailure(): void {
  cachedAutoWatchmanFailure.reason = null;
  pendingWatchmanAvailabilityProbe = null;
}

async function checkWatchmanAvailabilityWithCache(
  configuredProvider: WatchProvider,
  probe: () => Promise<ProviderAvailabilityStatus>,
): Promise<ProviderAvailabilityStatus> {
  const cachedReason = getCachedAutoWatchmanFailure(
    configuredProvider,
    "watchman",
  );
  if (cachedReason) {
    return { available: false, reason: cachedReason };
  }

  if (pendingWatchmanAvailabilityProbe) {
    return pendingWatchmanAvailabilityProbe;
  }

  pendingWatchmanAvailabilityProbe = probe()
    .then((availability) => {
      if (!availability.available) {
        cacheAutoWatchmanFailure(
          configuredProvider,
          "watchman",
          availability.reason ?? "watchman unavailable",
        );
      }
      return availability;
    })
    .finally(() => {
      pendingWatchmanAvailabilityProbe = null;
    });

  return pendingWatchmanAvailabilityProbe;
}
type ProviderEvent =
  | { type: "path"; relativePath: string }
  | { type: "resync"; reason: string; warning?: string };
type RuntimeWatcher = {
  provider: WatcherProviderName;
  close: () => Promise<void>;
  ready: Promise<void>;
  startupResync?: ProviderEvent;
};
type WatchmanModule = {
  Client: new (options?: { watchmanBinaryPath?: string }) => WatchmanClient;
};
type WatchmanCapabilityResponse = {
  version?: string;
  capabilities?: Record<string, boolean>;
};
type WatchmanWatchProjectResponse = {
  watch: string;
  relative_path?: string;
  warning?: string;
};
type WatchmanClockResponse = { clock: string };
type WatchmanFileChange = {
  name?: string;
  exists?: boolean;
  type?: string;
  size?: number;
  mtime_ms?: number | { toNumber(): number };
};
type WatchmanSubscriptionResponse = {
  subscription?: string;
  root?: string;
  files?: WatchmanFileChange[];
  clock?: string;
  warning?: string;
  is_fresh_instance?: boolean;
};
type WatchmanSubscriptionConfig = {
  expression: readonly unknown[];
  fields: string[];
  since: string;
  relative_root?: string;
};
type WatchmanClient = {
  capabilityCheck(
    capabilities: { required: string[]; optional?: string[] },
    callback: (
      error: Error | null,
      response: WatchmanCapabilityResponse,
    ) => void,
  ): void;
  command<T>(
    args: readonly unknown[],
    callback: (error: Error | null, response: T) => void,
  ): void;
  on(
    event: "subscription",
    fn: (response: WatchmanSubscriptionResponse) => void,
  ): WatchmanClient;
  on(event: "error", fn: (error: Error) => void): WatchmanClient;
  on(event: "end", fn: () => void): WatchmanClient;
  end(): void;
};

const PROVIDER_ORDER: WatcherProviderName[] = [
  "watchman",
  "chokidar",
  "fsWatch",
];
const WATCHMAN_SUBSCRIPTION_NAME = "sdl-mcp-live-index";
const WATCHMAN_REQUIRED_CAPABILITIES = ["relative_root"];
const WATCHMAN_FIELDS = ["name", "exists", "type", "mtime_ms", "size"];
const WATCHER_RESYNC_KEY = "__sdl_watcher_resync__";
const WATCHMAN_WARNING_MAX_COUNT = 10;
const WATCHMAN_UNSUBSCRIBE_TIMEOUT_MS = 2_000;
const WATCHMAN_STARTUP_COMMAND_TIMEOUT_MS = 5_000;

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

async function loadWatchman(): Promise<WatchmanModule | null> {
  try {
    const imported: unknown = await import("fb-watchman");
    if (isWatchmanModule(imported)) {
      return imported;
    }
    if (isRecord(imported) && isWatchmanModule(imported.default)) {
      return imported.default;
    }
    throw new Error("fb-watchman module did not expose Client");
  } catch (err) {
    logger.debug(
      "[sdl-mcp] watchman not available: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWatchmanModule(value: unknown): value is WatchmanModule {
  return isRecord(value) && typeof value.Client === "function";
}

function selectWatcherProvider(
  configuredProvider: WatchProvider,
  availability: ProviderAvailability,
): ProviderSelection {
  const unavailableReasons: string[] = [];
  const order =
    configuredProvider === "auto" ? PROVIDER_ORDER : [configuredProvider];

  for (const provider of order) {
    const status = availability[provider];
    if (status.available) {
      return {
        provider,
        fallbackReason:
          unavailableReasons.length > 0 ? unavailableReasons.join("; ") : null,
      };
    }
    const reason = status.reason ?? `${provider} unavailable`;
    if (configuredProvider !== "auto") {
      throw new Error(
        `Configured watcher provider '${configuredProvider}' is unavailable: ${reason}`,
      );
    }
    unavailableReasons.push(`${provider}: ${reason}`);
  }

  throw new Error(
    `No watcher provider available: ${unavailableReasons.join("; ")}`,
  );
}

function buildWatchmanSubscription(params: {
  clock: string;
  relativePath?: string | null;
  extensions: readonly string[];
}): WatchmanSubscriptionConfig {
  const suffixes = Array.from(
    new Set(
      params.extensions
        .map((extension) => extension.replace(/^\./, ""))
        .filter((extension) => extension.length > 0),
    ),
  );
  const expression =
    suffixes.length > 0
      ? ([
          "anyof",
          ...suffixes.map((suffix) => ["suffix", suffix] as const),
        ] as const)
      : (["true"] as const);
  const subscription: WatchmanSubscriptionConfig = {
    expression,
    fields: [...WATCHMAN_FIELDS],
    since: params.clock,
  };
  if (params.relativePath) {
    subscription.relative_root = normalizePath(params.relativePath);
  }
  return subscription;
}

function normalizeWatchmanFileName(
  fileName: string,
  context: { watchRoot: string; relativePath?: string | null },
): string {
  const candidate = fileName.trim();
  if (!candidate) return "";

  let normalized = isAbsolute(candidate)
    ? normalizePath(relative(context.watchRoot, candidate))
    : normalizePath(candidate).replace(/^\.\//, "");

  const relativeRoot = context.relativePath
    ? normalizePath(context.relativePath).replace(/\/$/, "")
    : "";
  if (
    relativeRoot.length > 0 &&
    (normalized === relativeRoot || normalized.startsWith(`${relativeRoot}/`))
  ) {
    normalized = normalized.slice(relativeRoot.length).replace(/^\//, "");
  }

  return normalized;
}

function watchmanResponseHasResyncSignal(
  response: Pick<
    WatchmanSubscriptionResponse,
    "is_fresh_instance" | "warning"
  >,
): boolean {
  return (
    response.is_fresh_instance === true ||
    isWatchmanRecrawlWarning(response.warning)
  );
}

function isWatchmanRecrawlWarning(warning: string | undefined): boolean {
  return typeof warning === "string" && /recrawl/i.test(warning);
}

function watchmanCommand<T>(
  client: WatchmanClient,
  args: readonly unknown[],
): Promise<T> {
  return new Promise((resolve, reject) => {
    client.command<T>(args, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timeoutTimer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      reject(new Error(`${description} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutTimer.unref();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  });
}

function watchmanCommandWithTimeout<T>(
  client: WatchmanClient,
  args: readonly unknown[],
  timeoutMs: number,
  description = `watchman ${String(args[0] ?? "command")}`,
): Promise<T> {
  return withTimeout(watchmanCommand<T>(client, args), timeoutMs, description);
}

function watchmanCapabilityCheck(
  client: WatchmanClient,
): Promise<WatchmanCapabilityResponse> {
  return new Promise((resolve, reject) => {
    client.capabilityCheck(
      { required: WATCHMAN_REQUIRED_CAPABILITIES, optional: [] },
      (error, response) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(response);
      },
    );
  });
}

function watchmanCapabilityCheckWithTimeout(
  client: WatchmanClient,
  timeoutMs: number,
): Promise<WatchmanCapabilityResponse> {
  return withTimeout(
    watchmanCapabilityCheck(client),
    timeoutMs,
    "watchman capability check",
  );
}

function buildWatchmanStartupResync(
  warning: string | undefined,
): ProviderEvent | null {
  if (!isWatchmanRecrawlWarning(warning)) {
    return null;
  }
  return {
    type: "resync",
    reason: "watchman watch-project recrawl warning",
    warning,
  };
}

/**
 * @internal
 */
export function _selectWatcherProviderForTesting(
  configuredProvider: WatchProvider,
  availability: ProviderAvailability,
): ProviderSelection {
  return selectWatcherProvider(configuredProvider, availability);
}

/**
 * @internal
 */
export const _watchmanAvailabilityForTesting = {
  check: checkWatchmanAvailabilityWithCache,
  resetCache: resetCachedAutoWatchmanFailure,
};

/**
 * @internal
 */
export function _buildWatchmanSubscriptionForTesting(params: {
  clock: string;
  relativePath?: string | null;
  extensions: readonly string[];
}): WatchmanSubscriptionConfig {
  return buildWatchmanSubscription(params);
}

/**
 * @internal
 */
export function _normalizeWatchmanFileNameForTesting(
  fileName: string,
  context: { watchRoot: string; relativePath?: string | null },
): string {
  return normalizeWatchmanFileName(fileName, context);
}

/**
 * @internal
 */
export function _watchmanResponseHasResyncSignalForTesting(
  response: Pick<
    WatchmanSubscriptionResponse,
    "is_fresh_instance" | "warning"
  >,
): boolean {
  return watchmanResponseHasResyncSignal(response);
}

/**
 * @internal
 */
export function _buildWatchmanStartupResyncForTesting(
  warning: string | undefined,
): ProviderEvent | null {
  return buildWatchmanStartupResync(warning);
}

/**
 * @internal
 */
export function _watchmanCommandWithTimeoutForTesting<T>(
  client: WatchmanClient,
  args: readonly unknown[],
  timeoutMs: number,
): Promise<T> {
  return watchmanCommandWithTimeout<T>(client, args, timeoutMs);
}

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
    let scheduledRetry = false;
    try {
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
      // as a failure so the retry/backoff path can run.
      let timeoutTimer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
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

  const startWatchmanProvider = async (): Promise<RuntimeWatcher> => {
    const watchman = await loadWatchman();
    if (!watchman) {
      throw new Error(
        "fb-watchman is not installed or could not be loaded; install Watchman and keep the optional fb-watchman dependency available",
      );
    }

    const watchmanBinary = resolveWatchmanBinary();
    if (!watchmanBinary.binaryPath) {
      throw new Error(
        watchmanBinary.reason ?? "SDL-managed Watchman binary could not be resolved",
      );
    }
    const watchmanBinaryPath = watchmanBinary.binaryPath;
    const daemonAvailability = await checkWatchmanAvailabilityWithCache(
      configuredProvider,
      async () => {
        const startupClient = new watchman.Client({
          watchmanBinaryPath,
        });
        try {
          await watchmanCapabilityCheckWithTimeout(
            startupClient,
            WATCHMAN_STARTUP_COMMAND_TIMEOUT_MS,
          );
          return { available: true };
        } catch (error) {
          return {
            available: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        } finally {
          try {
            startupClient.end();
          } catch {
            // Best-effort cleanup for the temporary startup probe client.
          }
        }
      },
    );
    if (!daemonAvailability.available) {
      throw new Error(daemonAvailability.reason ?? "Watchman unavailable");
    }

    const client = new watchman.Client({ watchmanBinaryPath });
    let closing = false;
    let runtimeFailed = false;
    let subscribed = false;
    let watchRoot = "";
    let watchmanRelativePath: string | null = null;
    let startupResync: ProviderEvent | undefined;
    let startupComplete = false;
    let startupFailureError: Error | null = null;
    let rejectStartupFailure: ((error: Error) => void) | null = null;
    const startupFailure = new Promise<never>((_, reject) => {
      rejectStartupFailure = reject;
    });
    const failStartup = (error: Error): void => {
      startupFailureError = error;
      rejectStartupFailure?.(error);
    };
    const withStartupFailure = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, startupFailure]);
    let handleRuntimeFailure:
      | ((reason: string, error?: Error) => void)
      | null = null;

    const closeClient = (): void => {
      try {
        client.end();
      } catch (error) {
        logger.debug("Watchman client end failed", {
          repoId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    client.on("error", (error: Error) => {
      if (startupComplete && handleRuntimeFailure) {
        handleRuntimeFailure("error", error);
        return;
      }
      failStartup(error);
      logger.debug("Watchman startup error", {
        repoId,
        error: error.message,
      });
    });
    client.on("end", () => {
      if (startupComplete && handleRuntimeFailure) {
        handleRuntimeFailure("connection ended");
        return;
      }
      failStartup(new Error("Watchman connection ended during startup"));
    });

    try {
      const capability = await withStartupFailure(
        watchmanCapabilityCheckWithTimeout(
          client,
          WATCHMAN_STARTUP_COMMAND_TIMEOUT_MS,
        ),
      );
      if (capability.version) {
        health.watchmanVersion = capability.version;
      }
      try {
        const version = await withStartupFailure(
          watchmanCommandWithTimeout<{ version?: string }>(
            client,
            ["version"],
            WATCHMAN_STARTUP_COMMAND_TIMEOUT_MS,
          ),
        );
        if (version.version) {
          health.watchmanVersion = version.version;
        }
      } catch (error) {
        if (error === startupFailureError) {
          throw error;
        }
        logger.debug("Watchman version command failed", {
          repoId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const watchProject =
        await withStartupFailure(
          watchmanCommandWithTimeout<WatchmanWatchProjectResponse>(
            client,
            ["watch-project", repoRow.rootPath],
            WATCHMAN_STARTUP_COMMAND_TIMEOUT_MS,
          ),
        );
      if (!watchProject.watch) {
        throw new Error("watch-project response did not include a watch root");
      }
      watchRoot = watchProject.watch;
      watchmanRelativePath = watchProject.relative_path
        ? normalizePath(watchProject.relative_path)
        : null;
      health.watchmanWatchRoot = normalizePath(watchRoot);
      health.watchmanRelativePath = watchmanRelativePath;
      if (watchProject.warning) {
        recordWatchmanWarning(watchProject.warning);
        startupResync =
          buildWatchmanStartupResync(watchProject.warning) ?? startupResync;
      }

      const clock = await withStartupFailure(
        watchmanCommandWithTimeout<WatchmanClockResponse>(
          client,
          ["clock", watchRoot],
          WATCHMAN_STARTUP_COMMAND_TIMEOUT_MS,
        ),
      );
      if (!clock.clock) {
        throw new Error("clock response did not include a clock value");
      }
      health.watchmanLastClock = clock.clock;

      const subscription = buildWatchmanSubscription({
        clock: clock.clock,
        relativePath: watchmanRelativePath,
        extensions,
      });
      await withStartupFailure(
        watchmanCommandWithTimeout(
          client,
          ["subscribe", watchRoot, WATCHMAN_SUBSCRIPTION_NAME, subscription],
          WATCHMAN_STARTUP_COMMAND_TIMEOUT_MS,
        ),
      );
      subscribed = true;
    } catch (error) {
      closing = true;
      closeClient();
      throw error;
    }

    handleRuntimeFailure = (reason: string, error?: Error): void => {
      if (closing) return;
      const detail = error ? error.message : reason;
      runtimeFailed = true;
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
        }).catch(
          (restartError: unknown) => {
            const restartMsg =
              restartError instanceof Error
                ? restartError.message
                : String(restartError);
            recordWatcherError(
              `[sdl-mcp] restartWatcher failed after Watchman failure: ${restartMsg}`,
            );
          },
        );
      }
    };
    client.on("subscription", (response: WatchmanSubscriptionResponse) => {
      if (response.subscription !== WATCHMAN_SUBSCRIPTION_NAME) {
        return;
      }
      if (response.warning) {
        recordWatchmanWarning(response.warning);
      }
      if (response.clock) {
        health.watchmanLastClock = response.clock;
      }
      if (response.is_fresh_instance) {
        health.watchmanFreshInstanceCount =
          (health.watchmanFreshInstanceCount ?? 0) + 1;
      }
      if (watchmanResponseHasResyncSignal(response)) {
        handleProviderEvent({
          type: "resync",
          reason: response.is_fresh_instance
            ? "watchman fresh-instance"
            : "watchman recrawl warning",
          warning: response.warning,
        });
        return;
      }

      for (const file of response.files ?? []) {
        if (!file.name) {
          continue;
        }
        const relativePath = normalizeWatchmanFileName(file.name, {
          watchRoot,
          relativePath: watchmanRelativePath,
        });
        if (!relativePath) {
          continue;
        }
        handleProviderEvent({ type: "path", relativePath });
      }
    });

    startupComplete = true;

    return {
      provider: "watchman",
      ready: Promise.resolve(),
      startupResync,
      close: async () => {
        closing = true;
        if (subscribed && !runtimeFailed) {
          try {
            await watchmanCommandWithTimeout(
              client,
              ["unsubscribe", watchRoot, WATCHMAN_SUBSCRIPTION_NAME],
              WATCHMAN_UNSUBSCRIBE_TIMEOUT_MS,
            );
          } catch (error) {
            logger.debug("Watchman unsubscribe failed", {
              repoId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        closeClient();
      },
    };
  };

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
  return ignorePatterns.map((pattern) =>
    globToSafeRegex(normalizePath(pattern)),
  );
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
