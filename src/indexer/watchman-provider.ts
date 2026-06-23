import { isAbsolute, relative } from "path";

import type { WatchProvider } from "../config/types.js";
import { logger } from "../util/logger.js";
import { normalizePath } from "../util/paths.js";
import type { WatcherHealth } from "./indexer.js";
import { resolveWatchmanBinary } from "./watchman-binary.js";

// Watchman-specific helpers are isolated from the generic watcher loop so the
// runtime provider code can stay focused on health state and restart policy.
export type WatcherProviderName = Exclude<WatchProvider, "auto">;
export type ProviderAvailabilityStatus = { available: boolean; reason?: string };
export type ProviderAvailability = Record<
  WatcherProviderName,
  ProviderAvailabilityStatus
>;
export type ProviderSelection = {
  provider: WatcherProviderName;
  fallbackReason: string | null;
};

const cachedAutoWatchmanFailure = {
  reason: null as string | null,
};
let pendingWatchmanAvailabilityProbe: Promise<ProviderAvailabilityStatus> | null = null;

export function getCachedAutoWatchmanFailure(
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

export function cacheAutoWatchmanFailure(
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

export async function checkWatchmanAvailabilityWithCache(
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
export type ProviderEvent =
  | { type: "path"; relativePath: string }
  | { type: "resync"; reason: string; warning?: string };
export type RuntimeWatcher = {
  provider: WatcherProviderName;
  close: () => Promise<void>;
  ready: Promise<void>;
  startupResync?: ProviderEvent;
};
export type WatchmanModule = {
  Client: new (options?: { watchmanBinaryPath?: string }) => WatchmanClient;
};
export type WatchmanCapabilityResponse = {
  version?: string;
  capabilities?: Record<string, boolean>;
};
export type WatchmanWatchProjectResponse = {
  watch: string;
  relative_path?: string;
  warning?: string;
};
export type WatchmanClockResponse = { clock: string };
export type WatchmanFileChange = {
  name?: string;
  exists?: boolean;
  type?: string;
  size?: number;
  mtime_ms?: number | { toNumber(): number };
};
export type WatchmanSubscriptionResponse = {
  subscription?: string;
  root?: string;
  files?: WatchmanFileChange[];
  clock?: string;
  warning?: string;
  is_fresh_instance?: boolean;
};
export type WatchmanSubscriptionConfig = {
  expression: readonly unknown[];
  fields: string[];
  since: string;
  relative_root?: string;
};
export type WatchmanClient = {
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

export const PROVIDER_ORDER: WatcherProviderName[] = [
  "watchman",
  "chokidar",
  "fsWatch",
];
export const WATCHMAN_SUBSCRIPTION_NAME = "sdl-mcp-live-index";
const WATCHMAN_REQUIRED_CAPABILITIES = ["relative_root"];
const WATCHMAN_FIELDS = ["name", "exists", "type", "mtime_ms", "size"];
export const WATCHER_RESYNC_KEY = "__sdl_watcher_resync__";
export const WATCHMAN_WARNING_MAX_COUNT = 10;
export const WATCHMAN_UNSUBSCRIBE_TIMEOUT_MS = 2_000;
export const WATCHMAN_STARTUP_COMMAND_TIMEOUT_MS = 5_000;

export async function loadWatchman(): Promise<WatchmanModule | null> {
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

export function selectWatcherProvider(
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

export function buildWatchmanSubscription(params: {
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

export function normalizeWatchmanFileName(
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

export function watchmanResponseHasResyncSignal(
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

export function isWatchmanRecrawlWarning(warning: string | undefined): boolean {
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

export function watchmanCommandWithTimeout<T>(
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

export function watchmanCapabilityCheckWithTimeout(
  client: WatchmanClient,
  timeoutMs: number,
): Promise<WatchmanCapabilityResponse> {
  return withTimeout(
    watchmanCapabilityCheck(client),
    timeoutMs,
    "watchman capability check",
  );
}

export async function probeWatchmanClientAvailability(
  createClient: () => WatchmanClient,
): Promise<ProviderAvailabilityStatus> {
  const client = createClient();
  const clientFailure = new Promise<never>((_, reject) => {
    client.on("error", reject);
    client.on("end", () => {
      reject(new Error("Watchman connection ended during startup probe"));
    });
  });

  try {
    await Promise.race([
      watchmanCapabilityCheckWithTimeout(
        client,
        WATCHMAN_STARTUP_COMMAND_TIMEOUT_MS,
      ),
      clientFailure,
    ]);
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      client.end();
    } catch {
      // Best-effort cleanup for the temporary startup probe client.
    }
  }
}

export function buildWatchmanStartupResync(
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
export function _probeWatchmanClientAvailabilityForTesting(
  createClient: () => WatchmanClient,
): Promise<ProviderAvailabilityStatus> {
  return probeWatchmanClientAvailability(createClient);
}



export type StartWatchmanRuntimeWatcherParams = {
  repoId: string;
  repoRoot: string;
  configuredProvider: WatchProvider;
  extensions: readonly string[];
  health: WatcherHealth;
  recordWatchmanWarning: (warning: string) => void;
  handleProviderEvent: (event: ProviderEvent) => void;
  onRuntimeFailure: (detail: string) => void;
};

export async function startWatchmanRuntimeWatcher({
  repoId,
  repoRoot,
  configuredProvider,
  extensions,
  health,
  recordWatchmanWarning,
  handleProviderEvent,
  onRuntimeFailure,
}: StartWatchmanRuntimeWatcherParams): Promise<RuntimeWatcher> {
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
    () =>
      probeWatchmanClientAvailability(
        () =>
          new watchman.Client({
            watchmanBinaryPath,
          }),
      ),
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
          ["watch-project", repoRoot],
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
    onRuntimeFailure(detail);
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
}
