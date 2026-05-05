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
import { MAX_FILE_BYTES } from "../../config/constants.js";
import { buildRepoOverview, clearOverviewCache } from "../../graph/overview.js";
import { clearSliceCache } from "../../graph/sliceCache.js";
import { symbolCardCache } from "../../graph/cache.js";
import { getRepoHealthSnapshot } from "../../services/health.js";
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
    return [...SUPPORTED_LANGUAGES] as RepoConfig["languages"];
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
  const { repoId, rootPath, ignore, languages, maxFileBytes } = request;

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

  const packageJson = detectPackageJson(rootPath);
  const tsconfigPath = detectTsconfig(rootPath);
  const workspaceGlobs = packageJson?.fullPath
    ? detectWorkspaces(packageJson.fullPath)
    : undefined;

  const config: RepoConfig = {
    repoId,
    rootPath,
    ignore: ignore ?? [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/build/**",
    ],
    languages: resolveRepoLanguages(languages),
    maxFileBytes: maxFileBytes ?? MAX_FILE_BYTES,
    includeNodeModulesTypes: true,
    packageJsonPath: packageJson?.relPath,
    tsconfigPath,
    workspaceGlobs,
  };

  const conn = await getLadybugConn();
  const existingRepo = await ladybugDb.getRepo(conn, repoId);

  await withWriteConn(async (wConn) => {
    await ladybugDb.upsertRepo(wConn, {
      repoId,
      rootPath: resolvedRoot,
      configJson: JSON.stringify(config),
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
  const { repoId, surfaceMemories, detail = "standard" } = request;

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

    // "minimal" skips health computation entirely (fastest path)
    const includeHealth = detail !== "minimal";
    const includeLiveIndex = detail === "full";

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
    const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
    const filesIndexed = await ladybugDb.getFileCount(conn, repoId);
    const symbolsIndexed = await ladybugDb.getSymbolCount(conn, repoId);
    const lastIndexedAt = await ladybugDb.getLastIndexedAt(conn, repoId);
    const healthResult = includeHealth
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
    const watcherHealth = includeHealth ? getWatcherHealth(repoId) : null;
    const prefetchStats = includeHealth ? getPrefetchStats(repoId) : null;
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
        stale: watcherHealth.stale,
        errors: watcherHealth.errors,
        queueDepth: watcherHealth.queueDepth,
        eventsReceived: watcherHealth.eventsReceived,
        eventsProcessed: watcherHealth.eventsProcessed,
      });
    }
    if (prefetchStats) {
      logPrefetchTelemetry({
        repoId,
        hitRate: prefetchStats.hitRate,
        wasteRate: prefetchStats.wasteRate,
        avgLatencyReductionMs: prefetchStats.avgLatencyReductionMs,
        queueDepth: prefetchStats.queueDepth,
      });
    }

    // Derived-state freshness (clusters/processes/algorithms/summaries/
    // embeddings). Surfaces dirty flags so callers can tell that an
    // incremental run deferred downstream work; cheap single-row lookup.
    let derivedState: Awaited<
      ReturnType<
        typeof import("../../db/ladybug-derived-state.js").getDerivedStateSummary
      >
    > | null = null;
    try {
      const { getDerivedStateSummary } =
        await import("../../db/ladybug-derived-state.js");
      derivedState = await getDerivedStateSummary(repoId);
    } catch (err) {
      logger.debug("derivedState lookup failed (non-critical)", {
        repoId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Surface relevant memories if enabled (default: false) and config allows it
    const memCaps = getMemoryCapabilities(loadConfig(), repoId);
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
      lastIndexedAt,
      healthScore: health.score,
      healthComponents: health.components,
      healthAvailable: health.available,
      ...(!health.available
        ? {
            healthNote:
              "Health computation timed out or is pending. Run sdl.index.refresh (incremental) to populate, or retry — a cached result may become available shortly.",
          }
        : healthIsStale
          ? {
              healthNote:
                "Health data may be stale (last known result). Fresh computation failed — retry or run sdl.index.refresh.",
            }
          : {}),
      watcherHealth,
      watcherNote:
        watcherHealth === null
          ? "Watcher not active. Run 'sdl-mcp serve' or call sdl.index.refresh after edits."
          : undefined,
      prefetchStats: prefetchStats ?? undefined,
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

  // Post-refresh cache invalidation. SCIP auto-ingest used to live here
  // wrapped in `withRepoWriteHeavyLock` + `waitForDerivedRefreshIdle` +
  // `flushStaleFinalizers`. It now runs INSIDE `indexRepoImpl` between
  // pass 1 and pass 2, so every consumer (CLI, MCP, watcher) gets the
  // same exact-edge-aware embeddings on the first index pass — see
  // `runScipIngestInsideIndex` in src/scip/ingestion.ts.
  const runPostRefresh = async (_conn: Connection): Promise<void> => {
    clearSliceCache();
    clearOverviewCache();
    symbolCardCache.clear();
    invalidateGraphSnapshot(repoId);
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
