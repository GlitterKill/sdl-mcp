import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";
import {
  RepoRegisterRequestSchema,
  RepoRegisterResponse,
  RepoStatusRequestSchema,
  RepoStatusResponse,
  IndexRefreshRequestSchema,
  IndexRefreshResponse,
  RepoOverviewRequestSchema,
  RepoOverviewResponse,
} from "../tools.js";
import * as db from "../../db/queries.js";
import { getWatcherHealth, indexRepo } from "../../indexer/indexer.js";
import { RepoConfig } from "../../config/types.js";
import { LanguageSchema } from "../../config/types.js";
import { normalizePath } from "../../util/paths.js";
import { DatabaseError, ConfigError, ValidationError } from "../errors.js";
import { logger } from "../../util/logger.js";
import { MAX_FILE_BYTES } from "../../config/constants.js";
import { buildRepoOverview } from "../../graph/overview.js";
import { clearSliceCache } from "../../graph/sliceCache.js";
import { symbolCardCache } from "../../graph/cache.js";
import { getRepoHealthSnapshot } from "../health.js";
import {
  logPrefetchTelemetry,
  logWatcherHealthTelemetry,
} from "../telemetry.js";
import { getPrefetchStats } from "../../graph/prefetch.js";
import { recordToolTrace } from "../../graph/prefetch-model.js";
import {
  withSpan,
  SPAN_NAMES,
  isTracingEnabled,
  type SpanAttributes,
} from "../../util/tracing.js";

const SUPPORTED_LANGUAGES = [...LanguageSchema.options];

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
  const request = RepoRegisterRequestSchema.parse(args);
  const { repoId, rootPath, ignore, languages, maxFileBytes } = request;

  const normalizedRoot = normalizePath(rootPath);
  if (
    normalizedRoot.includes("/../") ||
    normalizedRoot.endsWith("/..") ||
    normalizedRoot.startsWith("..") ||
    normalizedRoot.includes("\\..\\") ||
    normalizedRoot.endsWith("\\..")
  ) {
    throw new ValidationError(`Root path contains path traversal: ${rootPath}`);
  }

  if (!existsSync(rootPath)) {
    throw new ConfigError(`Path does not exist: ${rootPath}`);
  }

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

  const existingRepo = db.getRepo(repoId);

  if (existingRepo) {
    // Update existing repo
    db.updateRepo(repoId, {
      root_path: rootPath,
      config_json: JSON.stringify(config),
    });
  } else {
    // Create new repo
    const repoRow = {
      repo_id: repoId,
      root_path: rootPath,
      config_json: JSON.stringify(config),
      created_at: new Date().toISOString(),
    };
    db.createRepo(repoRow);
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
  const request = RepoStatusRequestSchema.parse(args);
  const { repoId } = request;

  const executeStatus = async () => {
    recordToolTrace({
      repoId,
      taskType: "status",
      tool: "repo.status",
    });

    const repo = db.getRepo(repoId);
    if (!repo) {
      throw new DatabaseError(`Repository ${repoId} not found`);
    }

    const latestVersion = db.getLatestVersion(repoId);
    const files = db.getFilesByRepo(repoId);
    const symbolsIndexed = db.countSymbolsByRepo(repoId);
    const health = await getRepoHealthSnapshot(repoId);
    const watcherHealth = getWatcherHealth(repoId);
    const prefetchStats = getPrefetchStats(repoId);
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
    logPrefetchTelemetry({
      repoId,
      hitRate: prefetchStats.hitRate,
      wasteRate: prefetchStats.wasteRate,
      avgLatencyReductionMs: prefetchStats.avgLatencyReductionMs,
      queueDepth: prefetchStats.queueDepth,
    });

    const lastIndexedFile = files
      .filter((f) => f.last_indexed_at !== null)
      .sort(
        (a, b) =>
          new Date(b.last_indexed_at!).getTime() -
          new Date(a.last_indexed_at!).getTime(),
      )[0];

    return {
      repoId,
      rootPath: repo.root_path,
      latestVersionId: latestVersion?.version_id ?? null,
      filesIndexed: files.length,
      symbolsIndexed,
      lastIndexedAt: lastIndexedFile?.last_indexed_at ?? null,
      healthScore: health.score,
      healthComponents: health.components,
      healthAvailable: health.available,
      watcherHealth,
      prefetchStats,
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
): Promise<IndexRefreshResponse> {
  const request = IndexRefreshRequestSchema.parse(args);
  const { repoId, mode } = request;

  const executeRefresh = async () => {
    const repo = db.getRepo(repoId);
    if (!repo) {
      throw new DatabaseError(`Repository ${repoId} not found`);
    }

    const result = await indexRepo(repoId, mode);

    clearSliceCache();
    symbolCardCache.clear();

    return {
      ok: true,
      repoId,
      versionId: result.versionId,
      changedFiles: result.changedFiles,
    };
  };

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
  const request = RepoOverviewRequestSchema.parse(args);
  const { repoId } = request;

  const repo = db.getRepo(repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const overview = buildRepoOverview(request);

  return overview;
}
