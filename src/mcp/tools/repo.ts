import { existsSync, readFileSync } from "fs";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "path";
import {
  type RepoRegisterRequest,
  RepoRegisterResponse,
  type RepoStatusRequest,
  RepoStatusResponse,
  type IndexRefreshRequest,
  IndexRefreshResponse,
  type RepoOverviewRequest,
  RepoOverviewResponse,
} from "../tools.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import {
  getWatcherHealth,
  indexRepo,
  type IndexProgress,
} from "../../indexer/indexer.js";
import { createVersionAndSnapshot } from "../../indexer/indexer-version.js";
import { RepoConfig } from "../../config/types.js";
import { LanguageSchema } from "../../config/types.js";
import { normalizePath } from "../../util/paths.js";
import { DatabaseError, ConfigError, ValidationError } from "../errors.js";
import { logger } from "../../util/logger.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getServerInfo } from "../../util/runtime-identity.js";

import { MAX_FILE_BYTES } from "../../config/constants.js";
import { buildRepoOverview, clearOverviewCache } from "../../graph/overview.js";
import { clearSliceCache } from "../../graph/sliceCache.js";
import { symbolCardCache } from "../../graph/cache.js";
import {
  getRepoHealthSnapshot,
  probeRepositoryRoot,
} from "../../services/health.js";
import {
  logPrefetchTelemetry,
  logWatcherHealthTelemetry,
} from "../telemetry.js";
import { getPrefetchStats } from "../../graph/prefetch.js";
import { surfaceRelevantMemories } from "../../memory/surface.js";
import { getMemoryCapabilities } from "../../config/memory-config.js";
import { recordToolTrace } from "../../graph/prefetch-model.js";
import { invalidateGraphSnapshot } from "../../graph/graphSnapshotCache.js";
import { buildConditionalResponse } from "../../util/conditional-response.js";
import {
  withSpan,
  SPAN_NAMES,
  isTracingEnabled,
  type SpanAttributes,
} from "../../util/tracing.js";
import type { ToolContext } from "../../server.js";
import { getDefaultLiveIndexCoordinator } from "../../live-index/coordinator.js";
import type { Connection } from "kuzu";
import { ensureBaselineEnforcementAssets } from "../../cli/commands/enforcement-bootstrap.js";
import { refreshSemanticEnrichment } from "../../semantic/enrichment.js";
import {
  getDerivedStateSummary,
  graphIntegrityIsVerifiedForVersion,
  graphIntegrityNextBestAction,
} from "../../db/ladybug-derived-state.js";

// Health snapshot cache with 30s TTL to avoid expensive recomputation.
// lastKnownHealth persists indefinitely as a stale fallback when fresh computation times out.
const healthSnapshotCache = new Map<
  string,
  {
    snapshot: Awaited<ReturnType<typeof getRepoHealthSnapshot>>;
    cachedAt: number;
  }
>();
const lastKnownHealth = new Map<
  string,
  Awaited<ReturnType<typeof getRepoHealthSnapshot>>
>();
const HEALTH_CACHE_TTL_MS = 30_000;

async function getCachedHealthSnapshot(repoId: string): Promise<{
  snapshot: Awaited<ReturnType<typeof getRepoHealthSnapshot>>;
  isStale: boolean;
}> {
  const cached = healthSnapshotCache.get(repoId);
  if (cached && Date.now() - cached.cachedAt < HEALTH_CACHE_TTL_MS) {
    return { snapshot: cached.snapshot, isStale: false };
  }
  try {
    const snapshot = await getRepoHealthSnapshot(repoId);
    healthSnapshotCache.set(repoId, { snapshot, cachedAt: Date.now() });
    lastKnownHealth.set(repoId, snapshot);
    return { snapshot, isStale: false };
  } catch (err) {
    // On failure, return last known health if available (marked stale)
    const stale = lastKnownHealth.get(repoId);
    if (stale) return { snapshot: stale, isStale: true };
    throw err;
  }
}
const SUPPORTED_LANGUAGES = [...LanguageSchema.options];
const ON_DEMAND_REPO_LANGUAGES = new Set([
  "php",
  "sh",
  "powershell",
  "ruby",
  "lua",
  "dart",
  "swift",
  "groovy",
  "perl",
  "r",
  "elixir",
  "fsharp",
  "fortran",
  "haskell",
  "julia",
  "nix",
  "clojure",
  "ocaml",
  "d",
  "haxe",
  "commonlisp",
  "zig",
  "gleam",
]);
const DEFAULT_REPO_LANGUAGES = SUPPORTED_LANGUAGES.filter(
  (language) => !ON_DEMAND_REPO_LANGUAGES.has(language),
);

/**
 * Checks whether a resolved repository root path is within at least one of the
 * configured allowed roots.  When `allowedRoots` is empty the check is a no-op
 * (backward-compatible unrestricted mode).
 *
 * @param resolvedRoot - Absolute, normalised path to the repo root
 * @param allowedRoots - Allowed root prefixes from security config (may be empty)
 * @throws {ValidationError} If the path is not under any allowed root
 */
export function checkRepoRootAllowlist(
  resolvedRoot: string,
  allowedRoots: string[],
): void {
  if (allowedRoots.length === 0) {
    logger.warn(
      "No allowedRepoRoots configured — any absolute path can be registered as a repository",
    );
    return; // empty allowlist = unrestricted (backward compatible)
  }

  const normalizedResolvedRoot = normalizePath(resolvedRoot);

  const allowed = allowedRoots.some((allowedRoot) => {
    const normalizedAllowed = normalizePath(resolve(allowedRoot));
    const prefix = normalizedAllowed.endsWith("/")
      ? normalizedAllowed
      : `${normalizedAllowed}/`;
    return (
      normalizedResolvedRoot === normalizedAllowed ||
      normalizedResolvedRoot.startsWith(prefix)
    );
  });

  if (!allowed) {
    throw new ValidationError(
      `Repository root path is not within any allowed root: ${resolvedRoot}`,
    );
  }
}

export function resolveRepoLanguages(
  languages?: string[],
): RepoConfig["languages"] {
  if (!languages || languages.length === 0) {
    return [...DEFAULT_REPO_LANGUAGES] as RepoConfig["languages"];
  }

  const invalid = languages.filter(
    (lang) =>
      !SUPPORTED_LANGUAGES.includes(
        lang as (typeof SUPPORTED_LANGUAGES)[number],
      ),
  );
  if (invalid.length > 0) {
    throw new ConfigError(
      `Invalid languages: ${invalid.join(", ")}. Supported languages: ${SUPPORTED_LANGUAGES.join(", ")}`,
    );
  }

  return languages as RepoConfig["languages"];
}

/**
 * Handles repository registration requests.
 * Creates a new repository or updates an existing one with the given configuration.
 * Detects package.json, tsconfig, and workspace configuration automatically.
 *
 * @param args - Raw arguments containing repoId, rootPath, and optional config
 * @returns Registration response with repoId and ok status
 * @throws {ConfigError} If root path does not exist
 */
export async function handleRepoRegister(
  args: unknown,
): Promise<RepoRegisterResponse> {
  const request = args as RepoRegisterRequest;
  const {
    repoId,
    rootPath,
    ignore,
    languages,
    maxFileBytes,
    dryRun,
    updateExisting,
    detail,
  } = request;

  recordToolTrace({
    repoId,
    taskType: "repo",
    tool: "repo.register",
  });

  // Resolve the root to an absolute path and validate — this catches
  // traversal attempts like "../../etc/passwd" that string matching misses.
  // On Windows, relative paths like "./foo" resolve to absolute paths, so
  // we compare resolved-vs-resolved to detect traversal sequences.
  const normalizedRoot = normalizePath(rootPath);
  const resolvedRoot = normalizePath(resolve(normalizedRoot));

  // For traversal detection, resolve the input as-is and check if double-resolve changes it.
  // This catches ".." sequences that escape the intended directory.
  const doubleResolved = normalizePath(resolve(resolvedRoot));
  if (resolvedRoot !== doubleResolved) {
    throw new ValidationError("Root path contains path traversal sequences");
  }

  if (!existsSync(resolvedRoot)) {
    throw new ConfigError(
      "The provided rootPath does not exist or is inaccessible",
    );
  }

  // Security: enforce allowlist if configured
  const appConfig = loadConfig();
  checkRepoRootAllowlist(
    resolvedRoot,
    appConfig.security?.allowedRepoRoots ?? [],
  );

  const packageJson = detectPackageJson(resolvedRoot);
  const tsconfigPath = detectTsconfig(resolvedRoot);
  const workspaceGlobs = packageJson?.fullPath
    ? detectWorkspaces(packageJson.fullPath)
    : undefined;

  const conn = await getLadybugConn();
  const existingRepo = await ladybugDb.getRepo(conn, repoId);

  const defaultIgnore = [
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "**/build/**",
  ];
  const stringArrayOrUndefined = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value
      : undefined;
  const configRecord = (() => {
    if (!existingRepo?.configJson) return {} as Partial<RepoConfig>;
    try {
      const parsed: unknown = JSON.parse(existingRepo.configJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Partial<RepoConfig>;
      }
    } catch (err) {
      logger.debug("Failed to parse existing repo config during registration", {
        repoId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {} as Partial<RepoConfig>;
  })();

  const currentConfig: RepoConfig | undefined = existingRepo
    ? {
        repoId,
        rootPath: normalizePath(resolve(normalizePath(existingRepo.rootPath))),
        ignore: stringArrayOrUndefined(configRecord.ignore) ?? defaultIgnore,
        languages: resolveRepoLanguages(
          stringArrayOrUndefined(configRecord.languages),
        ),
        maxFileBytes:
          typeof configRecord.maxFileBytes === "number"
            ? configRecord.maxFileBytes
            : MAX_FILE_BYTES,
        includeNodeModulesTypes:
          typeof configRecord.includeNodeModulesTypes === "boolean"
            ? configRecord.includeNodeModulesTypes
            : true,
        packageJsonPath:
          typeof configRecord.packageJsonPath === "string"
            ? configRecord.packageJsonPath
            : undefined,
        tsconfigPath:
          typeof configRecord.tsconfigPath === "string"
            ? configRecord.tsconfigPath
            : undefined,
        workspaceGlobs: stringArrayOrUndefined(configRecord.workspaceGlobs),
      }
    : undefined;

  const rootChanged = currentConfig
    ? currentConfig.rootPath !== resolvedRoot
    : true;
  const proposedConfig: RepoConfig = {
    repoId,
    rootPath: resolvedRoot,
    ignore: ignore ?? currentConfig?.ignore ?? defaultIgnore,
    languages: languages
      ? resolveRepoLanguages(languages)
      : (currentConfig?.languages ?? resolveRepoLanguages(undefined)),
    maxFileBytes: maxFileBytes ?? currentConfig?.maxFileBytes ?? MAX_FILE_BYTES,
    includeNodeModulesTypes: currentConfig?.includeNodeModulesTypes ?? true,
    packageJsonPath: packageJson?.relPath ?? (rootChanged ? undefined : currentConfig?.packageJsonPath),
    tsconfigPath: tsconfigPath ?? (rootChanged ? undefined : currentConfig?.tsconfigPath),
    workspaceGlobs: workspaceGlobs ?? (rootChanged ? undefined : currentConfig?.workspaceGlobs),
  };

  const diffFields: Array<keyof RepoConfig> = [
    "rootPath",
    "ignore",
    "languages",
    "maxFileBytes",
    "includeNodeModulesTypes",
    "packageJsonPath",
    "tsconfigPath",
    "workspaceGlobs",
  ];
  const configChanges = currentConfig
    ? diffFields.flatMap((field) => {
        const before = currentConfig[field] ?? null;
        const after = proposedConfig[field] ?? null;
        return JSON.stringify(before) === JSON.stringify(after)
          ? []
          : [{ field: String(field), before, after }];
      })
    : diffFields.map((field) => ({
        field: String(field),
        before: null,
        after: proposedConfig[field] ?? null,
      }));
  const toConfigRecord = (config: RepoConfig): Record<string, unknown> =>
    JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const dryRunConfigSnapshots =
    detail === "full"
      ? {
          currentConfig: currentConfig ? toConfigRecord(currentConfig) : undefined,
          proposedConfig: toConfigRecord(proposedConfig),
        }
      : {};

  if (dryRun) {
    return {
      ok: true,
      repoId,
      dryRun: true,
      changed: configChanges.length > 0,
      configChanges,
      ...dryRunConfigSnapshots,
      message: existingRepo
        ? "Dry run only; existing repo registration was not changed."
        : "Dry run only; repo would be registered.",
    };
  }

  if (existingRepo && configChanges.length > 0 && !updateExisting) {
    return {
      ok: false,
      repoId,
      changed: true,
      requiresUpdateExisting: true,
      configChanges,
      currentConfig: currentConfig ? toConfigRecord(currentConfig) : undefined,
      proposedConfig: toConfigRecord(proposedConfig),
      message:
        "Existing repo config differs; no changes applied. Re-run with updateExisting:true to apply this registration update.",
    };
  }

  if (existingRepo && configChanges.length === 0) {
    return {
      ok: true,
      repoId,
      changed: false,
      message: "Existing repo registration already matches; no changes applied.",
    };
  }

  await withWriteConn(async (wConn) => {
    await ladybugDb.upsertRepo(wConn, {
      repoId,
      rootPath: resolvedRoot,
      configJson: JSON.stringify(proposedConfig),
      createdAt: existingRepo?.createdAt ?? new Date().toISOString(),
    });
  });

  invalidateGraphSnapshot(repoId);
  clearOverviewCache();

  // Ensure a baseline version exists for newly registered repos
  // so that slice.build / delta.get don't fail with NO_VERSION.
  if (!existingRepo) {
    try {
      await createVersionAndSnapshot({
        repoId,
        versionId: `v${Date.now()}`,
        reason: "Initial registration",
      });
    } catch (err) {
      logger.warn("Failed to create initial version during registration", {
        repoId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    ensureBaselineEnforcementAssets(resolvedRoot, repoId);
  } catch (err) {
    logger.warn("Failed to ensure baseline SDL enforcement assets", {
      repoId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    ok: true,
    repoId,
    changed: configChanges.length > 0,
    configChanges,
    message: existingRepo
      ? "Existing repo registration updated."
      : "Repo registered.",
  };
}

/**
 * Detects package.json in the repository root.
 *
 * @param rootPath - Absolute path to repository root
 * @returns Object with relative and full paths to package.json, or undefined if not found
 * @internal
 */
function detectPackageJson(
  rootPath: string,
): { relPath: string; fullPath: string } | undefined {
  const path = join(rootPath, "package.json");
  if (!existsSync(path)) return undefined;
  return {
    relPath: normalizePath(relative(rootPath, path)),
    fullPath: path,
  };
}

/**
 * Detects TypeScript configuration file in the repository root.
 * Checks for tsconfig.json or tsconfig.base.json.
 *
 * @param rootPath - Absolute path to repository root
 * @returns Relative path to tsconfig file, or undefined if not found
 * @internal
 */
function detectTsconfig(rootPath: string): string | undefined {
  const candidates = ["tsconfig.json", "tsconfig.base.json"];
  for (const candidate of candidates) {
    const fullPath = join(rootPath, candidate);
    if (existsSync(fullPath)) {
      return normalizePath(candidate);
    }
  }
  return undefined;
}

/**
 * Detects workspace configuration from package.json.
 * Supports both array and object workspace formats.
 *
 * @param packageJsonPath - Absolute path to package.json file
 * @returns Array of workspace glob patterns, or undefined if not configured
 * @internal
 */
function detectWorkspaces(packageJsonPath: string): string[] | undefined {
  try {
    const raw = readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw);
    const workspacesField = parsed.workspaces;

    if (!workspacesField) {
      return undefined;
    }

    if (Array.isArray(workspacesField)) {
      return workspacesField;
    }

    if (
      typeof workspacesField === "object" &&
      Array.isArray(workspacesField.packages)
    ) {
      return workspacesField.packages;
    }
  } catch (error) {
    logger.warn("Failed to parse package.json for workspace detection", {
      packageJsonPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  return undefined;
}

/**
 * Handles repository status requests.
 * Returns indexing statistics including files indexed, symbols indexed, and last index time.
 *
 * @param args - Raw arguments containing repoId
 * @returns Status response with repoId, rootPath, and indexing statistics
 * @throws {DatabaseError} If repository not found
 */
export async function handleRepoStatus(
  args: unknown,
): Promise<RepoStatusResponse> {
  const request = args as RepoStatusRequest;
  const { repoId, surfaceMemories, detail = "minimal", includeTelemetry = false } = request;

  const executeStatus = async () => {
    recordToolTrace({
      repoId,
      taskType: "status",
      tool: "repo.status",
    });

    const conn = await getLadybugConn();
    const repo = await ladybugDb.getRepo(conn, repoId);
    if (!repo) {
      throw new DatabaseError(`Repository ${repoId} not found`);
    }

    const appConfig = loadConfig();
    const rootProbe = await probeRepositoryRoot(repo.rootPath);
    const rootAvailable = rootProbe.status === "available";
    const configuredRegistration = appConfig.repos.some(
      (configuredRepo) => configuredRepo.repoId === repoId,
    );
    const rootRecoveryAction = rootAvailable
      ? undefined
      : configuredRegistration
        ? "Restore the repository root or update its rootPath in SDL_CONFIG, then restart SDL-MCP."
        : "Restore the repository root, update it with sdl.repo.register, or remove the runtime registration with sdl.repo.unregister.";
    const rootAvailability = rootRecoveryAction
      ? { ...rootProbe, nextBestAction: rootRecoveryAction }
      : rootProbe;

    const includeExpensiveStatus = detail !== "minimal" || includeTelemetry;
    const includeLiveIndex = detail === "full" || includeTelemetry;

    const unavailableHealth = {
      snapshot: {
        score: null as number | null,
        components: {
          freshness: 0,
          coverage: 0,
          errorRate: 0,
          edgeQuality: 0,
          embeddingFailures: 0,
        },
        available: false,
      },
      isStale: false,
    };

function compactWatcherHealthForStatus(
  watcherHealth: ReturnType<typeof getWatcherHealth>,
) {
  if (!watcherHealth) return watcherHealth;
  return {
    enabled: watcherHealth.enabled,
    running: watcherHealth.running,
    provider: watcherHealth.provider,
    configuredProvider: watcherHealth.configuredProvider,
    fallbackReason: watcherHealth.fallbackReason,
    errors: watcherHealth.errors,
    queueDepth: watcherHealth.queueDepth,
    stale: watcherHealth.stale,
    lastEventAt: watcherHealth.lastEventAt,
    lastSuccessfulReindexAt: watcherHealth.lastSuccessfulReindexAt,
  };
}

function compactPrefetchStatsForStatus(
  prefetchStats: ReturnType<typeof getPrefetchStats> | undefined,
) {
  if (!prefetchStats) return undefined;
  return {
    enabled: prefetchStats.enabled,
    queueDepth: prefetchStats.queueDepth,
    running: prefetchStats.running,
    hitRate: prefetchStats.hitRate,
    wasteRate: prefetchStats.wasteRate,
    avgLatencyReductionMs: prefetchStats.avgLatencyReductionMs,
    lastRunAt: prefetchStats.lastRunAt,
    policyMode: prefetchStats.policyMode,
    suppressedPrefetch: prefetchStats.suppressedPrefetch,
    acceptedPrefetch: prefetchStats.acceptedPrefetch,
  };
}
    const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
    const filesIndexed = await ladybugDb.getFileCount(conn, repoId);
    const symbolsIndexed = await ladybugDb.getSymbolCount(conn, repoId);
    const lastIndexedAt = await ladybugDb.getLastIndexedAt(conn, repoId);
    const healthResult = includeExpensiveStatus && rootAvailable
      ? await Promise.race([
          getCachedHealthSnapshot(repoId),
          new Promise<typeof unavailableHealth>((resolve) =>
            setTimeout(() => {
              logger.debug(
                "Health computation timed out for repoStatus, returning unavailable",
              );
              resolve(unavailableHealth);
            }, 5000).unref(),
          ),
        ])
      : unavailableHealth;
    const recentVersions = includeLiveIndex
      ? await ladybugDb.getVersionsByRepo(conn, repoId, 10)
      : ([] as Awaited<ReturnType<typeof ladybugDb.getVersionsByRepo>>);
    const health = healthResult.snapshot;
    const healthIsStale = healthResult.isStale;
    const watcherHealth = includeExpensiveStatus
      ? getWatcherHealth(repoId)
      : null;
    const prefetchStats = includeExpensiveStatus
      ? getPrefetchStats(repoId)
      : undefined;
    const liveIndexStatus = includeLiveIndex
      ? await getDefaultLiveIndexCoordinator()
          .getLiveStatus(repoId)
          .catch((err) => {
            logger.warn("Failed to get live index status", {
              repoId,
              error: err instanceof Error ? err.message : String(err),
            });
            return undefined;
          })
      : undefined;
    if (watcherHealth) {
      logWatcherHealthTelemetry({
        repoId,
        enabled: watcherHealth.enabled,
        running: watcherHealth.running,
        provider: watcherHealth.provider,
        configuredProvider: watcherHealth.configuredProvider,
        fallbackReason: watcherHealth.fallbackReason,
        stale: watcherHealth.stale,
        errors: watcherHealth.errors,
        queueDepth: watcherHealth.queueDepth,
        eventsReceived: watcherHealth.eventsReceived,
        eventsProcessed: watcherHealth.eventsProcessed,
        restartCount: watcherHealth.restartCount,
        watchmanVersion: watcherHealth.watchmanVersion,
        watchmanWarningCount: watcherHealth.watchmanWarningCount,
        watchmanWarnings: watcherHealth.watchmanWarnings,
        watchmanRecrawlCount: watcherHealth.watchmanRecrawlCount,
        watchmanFreshInstanceCount: watcherHealth.watchmanFreshInstanceCount,
        watchmanWatchRoot: watcherHealth.watchmanWatchRoot,
        watchmanRelativePath: watcherHealth.watchmanRelativePath,
        watchmanLastClock: watcherHealth.watchmanLastClock,
      });
    }
    if (prefetchStats) {
      logPrefetchTelemetry({
        repoId,
        hitRate: prefetchStats.hitRate,
        wasteRate: prefetchStats.wasteRate,
        avgLatencyReductionMs: prefetchStats.avgLatencyReductionMs,
        queueDepth: prefetchStats.queueDepth,
        policyMode: prefetchStats.policyMode,
        outcomeSamples: prefetchStats.outcomeSamples,
        suppressedPrefetch: prefetchStats.suppressedPrefetch,
        acceptedPrefetch: prefetchStats.acceptedPrefetch,
        topStrategies: prefetchStats.topStrategies,
      });
    }

    // Derived-state freshness (clusters/processes/algorithms/summaries/
    // embeddings). Surfaces dirty flags and recovery guidance if a prior
    // post-index derived computation was interrupted or failed.
    let derivedState: Awaited<ReturnType<typeof getDerivedStateSummary>> = null;
    try {
      derivedState = await getDerivedStateSummary(repoId);
    } catch (err) {
      logger.debug("derivedState lookup failed (non-critical)", {
        repoId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const graphIntegrityReady = graphIntegrityIsVerifiedForVersion(
      derivedState,
      latestVersion?.versionId ?? null,
    );
    if (
      derivedState?.graphIntegrityState === "verified" &&
      !graphIntegrityReady
    ) {
      derivedState = {
        ...derivedState,
        nextBestAction: graphIntegrityNextBestAction("version-mismatch"),
      };
    }
    const effectiveHealth = rootAvailable && graphIntegrityReady
      ? health
      : unavailableHealth.snapshot;

    // Surface relevant memories if enabled (default: false) and config allows it
    const memCaps = getMemoryCapabilities(appConfig, repoId);
    let memories:
      | Awaited<ReturnType<typeof surfaceRelevantMemories>>
      | undefined;
    if (surfaceMemories === true && memCaps.surfacingEnabled) {
      try {
        memories = await surfaceRelevantMemories(conn, {
          repoId,
          limit: memCaps.defaultSurfaceLimit,
        });
        if (memories.length === 0) memories = undefined;
      } catch (err) {
        logger.debug("Memory surfacing failed (non-critical)", {
          repoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      repoId,
      rootPath: repo.rootPath,
      rootAvailability,
      latestVersionId: latestVersion?.versionId ?? null,
      recentVersions:
        detail === "full"
          ? recentVersions.map((v) => ({
              versionId: v.versionId,
              createdAt: v.createdAt,
              reason: v.reason,
            }))
          : undefined,
      filesIndexed,
      symbolsIndexed,
      countNotes: {
        filesIndexed: "Files counted by repo.status index state.",
        symbolsIndexed:
          "Real symbols counted by repo.status index state; repo.overview stats use the overview symbol query.",
      },
      lastIndexedAt,
      ...(!rootAvailable
        ? { healthAvailable: false }
        : includeExpensiveStatus
        ? {
            healthScore: effectiveHealth.score,
            healthComponents: effectiveHealth.components,
            healthAvailable: effectiveHealth.available,
          }
        : {}),
      ...(!rootAvailable
        ? { healthNote: rootRecoveryAction }
        : !includeExpensiveStatus
        ? {
            healthNote:
              'Health omitted because detail:"minimal" skips health computation. Use detail:"standard" to inspect health.',
          }
        : !graphIntegrityReady
          ? {
              healthNote:
                derivedState?.nextBestAction ??
                graphIntegrityNextBestAction("unknown"),
            }
        : !health.available
          ? {
              healthNote:
                "Health computation timed out or is pending. Run sdl.index.refresh (incremental) to populate, or retry; a cached result may become available shortly.",
            }
          : healthIsStale
          ? {
              healthNote:
                "Health data may be stale (last known result). Fresh computation failed; retry or run sdl.index.refresh.",
            }
          : {}),
      watcherHealth: includeExpensiveStatus
        ? compactWatcherHealthForStatus(watcherHealth)
        : undefined,
      watcherNote: includeExpensiveStatus && watcherHealth === null
        ? "Watcher not active. Run 'sdl-mcp serve' or call sdl.index.refresh after edits."
        : undefined,
      prefetchStats: compactPrefetchStatsForStatus(prefetchStats),
      serverInfo: getServerInfo(),
      liveIndexStatus,
      memories,
      derivedState: derivedState ?? undefined,
    };
  };

  if (isTracingEnabled()) {
    const attrs: SpanAttributes = { repoId };
    return withSpan(
      SPAN_NAMES.REPO_STATUS,
      async (span) => {
        const result = await executeStatus();
        span.setAttributes({
          "counts.files": result.filesIndexed,
          "counts.symbols": result.symbolsIndexed,
          versionId: result.latestVersionId ?? undefined,
        });
        return result;
      },
      attrs,
    );
  }

  return executeStatus();
}

/**
 * Handles index refresh requests.
 * Triggers re-indexing of the repository in either full or incremental mode.
 *
 * @param args - Raw arguments containing repoId and mode ("full" or "incremental")
 * @returns Index refresh response with versionId and changed file count
 * @throws {DatabaseError} If repository not found
 */
export async function handleIndexRefresh(
  args: unknown,
  context?: ToolContext,
): Promise<IndexRefreshResponse> {
  const request = args as IndexRefreshRequest;
  const { repoId, mode } = request;
  const asyncMode = request.async === true;
  const includeDiagnostics = request.includeDiagnostics === true;

  recordToolTrace({
    repoId,
    taskType: "index",
    tool: "index.refresh",
  });

  const toResponse = (
    result: Awaited<ReturnType<typeof indexRepo>>,
  ): IndexRefreshResponse => {
    const response: IndexRefreshResponse = {
      ok: true,
      repoId,
      versionId: result.versionId,
      changedFiles: result.changedFiles,
    };
    if (includeDiagnostics && result.timings) {
      response.diagnostics = { timings: result.timings };
    }
    return response;
  };

  // Post-refresh cache invalidation. Provider facts are now owned by the
  // provider-first indexer; this hook only handles caches and optional semantic
  // enrichment after `indexRepo` has finished.
  const runPostRefresh = async (_conn: Connection): Promise<void> => {
    clearSliceCache();
    clearOverviewCache();
    symbolCardCache.clear();
    invalidateGraphSnapshot(repoId);
    const config = loadConfig();
    if (
      config.semanticEnrichment?.enabled &&
      config.semanticEnrichment.autoRunOnIndexRefresh
    ) {
      await refreshSemanticEnrichment(
        { repoId, skipProviders: ["scip"] },
        config,
      ).catch((err: unknown) => {
        logger.warn("Post-index semantic enrichment failed", {
          repoId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  };

  const executeRefresh = async () => {
    const conn = await getLadybugConn();
    const repo = await ladybugDb.getRepo(conn, repoId);
    if (!repo) {
      throw new DatabaseError(`Repository ${repoId} not found`);
    }

    const progressToken = context?.progressToken;
    const sendNotification = context?.sendNotification;
    const onProgress =
      progressToken !== undefined && sendNotification
        ? (progress: IndexProgress) => {
            const subLabel = progress.substage ? `:${progress.substage}` : "";
            const base =
              `[${progress.stage}${subLabel}] ${progress.currentFile ?? ""}`.trim();
            const message = progress.message
              ? `${base} ${progress.message}`.trim()
              : base;
            sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: progress.current,
                total: progress.total,
                message,
                _meta: {
                  stage: progress.stage,
                  substage: progress.substage,
                  stageCurrent: progress.stageCurrent,
                  stageTotal: progress.stageTotal,
                  currentFile: progress.currentFile,
                },
              },
            }).catch((err) => {
              logger.warn("Failed to send progress notification", {
                error: err instanceof Error ? err.message : String(err),
              });
              return undefined;
            });
          }
        : undefined;

    const result = await indexRepo(repoId, mode, onProgress, context?.signal, {
      includeTimings: includeDiagnostics,
    });

    await runPostRefresh(conn);

    return toResponse(result);
  };

  // Async mode: return immediately, run indexing in background
  if (asyncMode) {
    const operationId = `idx-${randomUUID().slice(0, 8)}`;
    logger.info("Async index refresh started", { repoId, mode, operationId });
    // Re-bind executeRefresh without request-scoped signal (it aborts when client disconnects)
    const bgRefresh = async () => {
      const conn = await getLadybugConn();
      const repo = await ladybugDb.getRepo(conn, repoId);
      if (!repo) throw new DatabaseError(`Repository ${repoId} not found`);
      const result = await indexRepo(repoId, mode, undefined, undefined);
      await runPostRefresh(conn);
      return toResponse(result);
    };
    bgRefresh().then(
      (result) =>
        logger.info("Async index refresh completed", {
          repoId,
          operationId,
          versionId: result.versionId,
          changedFiles: result.changedFiles,
        }),
      (err) =>
        logger.error("Async index refresh failed", {
          repoId,
          operationId,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
    return {
      ok: true,
      repoId,
      async: true,
      operationId,
      message: `Indexing started in background (operationId: ${operationId}). Check progress via sdl.repo.status.`,
    };
  }

  if (isTracingEnabled()) {
    const attrs: SpanAttributes = { repoId, mode };
    return withSpan(
      SPAN_NAMES.INDEX_REFRESH,
      async (span) => {
        const result = await executeRefresh();
        span.setAttributes({
          "counts.changedFiles": result.changedFiles,
          versionId: result.versionId,
        });
        return result;
      },
      attrs,
    );
  }

  return executeRefresh();
}

/**
 * Handles repository overview requests.
 * Returns a token-efficient summary of the codebase with configurable detail levels.
 *
 * Detail levels:
 * - "stats": High-level statistics only (~100 tokens)
 * - "directories": Stats + directory summaries (~500-1000 tokens)
 * - "full": Stats + directories + hotspots + architecture (~1500 tokens)
 *
 * @param args - Raw arguments containing repoId, level, and optional filters
 * @returns Repository overview with stats, directories, and optionally hotspots
 * @throws {DatabaseError} If repository not found
 */
export async function handleRepoOverview(
  args: unknown,
): Promise<RepoOverviewResponse> {
  const request = args as RepoOverviewRequest;
  const { repoId } = request;

  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const overview = await buildRepoOverview(request);

  return buildConditionalResponse(overview, {
    ifNoneMatch: request.ifNoneMatch,
    // Ignore generatedAt so identical overview content can reuse client cache.
    stableValue: {
      ...overview,
      generatedAt: null,
    },
  });
}
