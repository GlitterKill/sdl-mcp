import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Connection } from "kuzu";
import type { AppConfig } from "../../config/types.js";
import {
  closeLadybugDb,
  getLadybugConn,
  getLadybugDbPath,
  withWriteConn,
} from "../../db/ladybug.js";
import { initGraphDb } from "../../db/initGraphDb.js";
import { execDdl, queryStoredProcAll } from "../../db/ladybug-core.js";
import {
  getDerivedStateFromConnection,
  graphIntegrityIsVerifiedForVersion,
} from "../../db/ladybug-derived-state.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import {
  countInvalidSafeRebuildDependencyEndpoints,
  readSafeRebuildRepoMembershipCounts,
  readSafeRebuildSymbolPointLookupSample,
  validateSafeRebuildCanonicalStrings,
} from "../../db/ladybug-safe-rebuild.js";
import { SafeRebuildValidationError } from "../../domain/errors.js";
import {
  disableDerivedRefreshQueue,
  enableDerivedRefreshQueue,
  shutdownDerivedRefreshQueue,
} from "../../indexer/derived-refresh-queue.js";
import {
  indexRepo,
  type IndexProgress,
  type IndexResult,
} from "../../indexer/indexer.js";
import {
  waitForGraphIntegrityVerifier,
} from "../../indexer/provider-first/background-graph-integrity-verifier.js";
import {
  capturePersistedGraphIntegrity,
  compareGraphIntegrityExpectations,
  createGraphIntegrityExpectationFromManifest,
} from "../../indexer/provider-first/persisted-graph-integrity.js";
import {
  indexExistsForTable,
  showIndexesStrict,
} from "../../retrieval/index-lifecycle.js";
import { buildFtsStoredProcQuery } from "../../retrieval/orchestrator.js";
import { loadConfiguredAdapterPlugins } from "../../startup/plugins.js";
import { getCurrentTimestamp } from "../../util/time.js";
import type { IndexOptions } from "../types.js";
import {
  findExistingProcess,
  type PidfileData,
} from "../../util/pidfile.js";
import { normalizePath } from "../../util/paths.js";

const EXTERNAL_OWNER_WARNING =
  "Precondition: no unsupported external LadybugDB owner may have the active database open; only SDL-MCP pidfile owners can be detected automatically.";

export interface SafeRebuildRequest {
  options: IndexOptions;
  activeGraphDbPath: string;
  findOwner?: (graphDbPath: string) => PidfileData | null;
  pathExists?: (path: string) => boolean;
}

export interface ValidatedSafeRebuildRequest {
  targetGraphDbPath: string;
  externalOwnerWarning: string;
}

export interface SafeRebuildCandidateValidation {
  repoIds: string[];
  physicalSymbolTotal: number;
  distinctSymbolTotal: number;
  sampledSymbolIds: string[];
  ftsIndexName?: string;
}

export interface SafeRebuildResult {
  targetGraphDbPath: string;
  repoResults: Array<{ repoId: string; stats: IndexResult }>;
  validation: SafeRebuildCandidateValidation;
}

export type SafeRebuildLifecycleEvent =
  | "candidate:opened"
  | "candidate:indexed"
  | "candidate:verified-before-close"
  | "candidate:checkpointed"
  | "candidate:closed-before-reopen"
  | "candidate:reopened"
  | "candidate:validated"
  | "candidate:closed-after-validation"
  | "candidate:closed-after-failure";

export interface RunSafeRebuildParams {
  options: IndexOptions;
  config: AppConfig;
  configPath: string;
  activeGraphDbPath: string;
  onRepoStart?: (repoId: string, rootPath: string) => void;
  onProgress?: (repoId: string, progress: IndexProgress) => void;
  onRepoComplete?: (repoId: string, stats: IndexResult) => void;
  onLifecycleEvent?: (event: SafeRebuildLifecycleEvent) => void;
  /** @internal deterministic failure seam for disk-backed lifecycle tests. */
  _indexRepoForTesting?: typeof indexRepo;
  /** @internal deterministic partial-initialization seam. */
  _initGraphDbForTesting?: typeof initGraphDb;
  /** @internal deterministic post-reopen failure seam. */
  _validateCandidateForTesting?: typeof validateSafeRebuildCandidate;
  /** @internal deterministic per-repository storage failure seam. */
  _validateStorageAfterRepoForTesting?: (
    repoId: string,
  ) => Promise<void>;
  /** @internal observes successful per-repository storage validation. */
  _afterRepoStorageValidationForTesting?: (
    repoId: string,
  ) => void | Promise<void>;
}

function comparablePath(path: string): string {
  const normalized = normalizePath(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Validate every recovery precondition before opening either graph database.
 * The candidate family must be new so a failed rebuild cannot overwrite
 * recoverable operator data or inherit a stale WAL sidecar.
 */
export function validateSafeRebuildRequest(
  request: SafeRebuildRequest,
): ValidatedSafeRebuildRequest {
  const targetInput = request.options.safeRebuildPath;
  if (!targetInput) {
    throw new Error("--safe-rebuild requires a target path");
  }
  if (!request.options.force) {
    throw new Error("--safe-rebuild requires --force");
  }
  if (request.options.watch) {
    throw new Error("--safe-rebuild cannot be combined with --watch");
  }
  if (request.options.repoId) {
    throw new Error("--safe-rebuild cannot be combined with --repo-id");
  }
  if (!isAbsolute(targetInput)) {
    throw new Error("--safe-rebuild requires an absolute path");
  }

  const targetGraphDbPath = resolve(targetInput);
  if (
    comparablePath(targetGraphDbPath) ===
    comparablePath(request.activeGraphDbPath)
  ) {
    throw new Error(
      "--safe-rebuild target must be different from the active graph database",
    );
  }

  const pathExists = request.pathExists ?? existsSync;
  const candidateFamily = [
    targetGraphDbPath,
    `${targetGraphDbPath}.wal`,
    `${targetGraphDbPath}.wal.checkpoint`,
  ];
  const existingCandidateEntry = candidateFamily.find(pathExists);
  if (existingCandidateEntry) {
    throw new Error(
      `--safe-rebuild target already exists: ${normalizePath(existingCandidateEntry)}`,
    );
  }

  const owner = (request.findOwner ?? findExistingProcess)(
    request.activeGraphDbPath,
  );
  if (owner) {
    throw new Error(
      `SDL-MCP PID ${owner.pid} owns the active graph database; stop it before --safe-rebuild`,
    );
  }

  return {
    targetGraphDbPath,
    externalOwnerWarning: EXTERNAL_OWNER_WARNING,
  };
}

function failCandidateValidation(message: string): never {
  throw new SafeRebuildValidationError(
    `Safe rebuild candidate validation failed: ${message}`,
  );
}

function configuredFtsIndexName(config: AppConfig): string | undefined {
  if (!config.semantic?.enabled || !config.semantic.retrieval) return undefined;
  if (config.semantic.retrieval.fts?.enabled === false) return undefined;
  return config.semantic.retrieval.fts?.indexName ?? "symbol_search_text_v1";
}

async function validatePersistedGraphIntegrityManifest(
  conn: Connection,
  repoId: string,
): Promise<void> {
  const expected = createGraphIntegrityExpectationFromManifest(
    await ladybugDb.listGraphIntegrityFileStates(conn, repoId),
    await ladybugDb.listGraphIntegrityFilelessStates(conn, repoId),
  );
  const actual = await capturePersistedGraphIntegrity(conn, repoId);
  const mismatch = compareGraphIntegrityExpectations(expected, actual);
  if (mismatch) {
    failCandidateValidation(
      `repository ${repoId} persisted graph does not match its integrity manifest: ${JSON.stringify(mismatch)}`,
    );
  }
}

async function validateConfiguredRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  const fileCount = await ladybugDb.getFileCount(conn, repoId);
  const edgeCount = await ladybugDb.getEdgeCount(conn, repoId);
  const membership = await readSafeRebuildRepoMembershipCounts(conn, repoId);
  if (membership.physicalTotal !== membership.distinctTotal) {
    failCandidateValidation(
      `repository ${repoId} has ${membership.physicalTotal} Symbol memberships but only ${membership.distinctTotal} distinct symbolId values`,
    );
  }

  const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
  const state = await getDerivedStateFromConnection(conn, repoId);
  if (fileCount > 0) {
    if (!latestVersion) {
      failCandidateValidation(
        `non-empty repository ${repoId} has no current Version`,
      );
    }
    if (
      !graphIntegrityIsVerifiedForVersion(state, latestVersion.versionId)
    ) {
      failCandidateValidation(
        `non-empty repository ${repoId} does not have verified graph integrity for its current Version`,
      );
    }
    await validatePersistedGraphIntegrityManifest(conn, repoId);
    return;
  }

  if (membership.physicalTotal !== 0 || edgeCount !== 0) {
    failCandidateValidation(
      `empty repository ${repoId} has contradictory graph state`,
    );
  }
  if (
    latestVersion &&
    !graphIntegrityIsVerifiedForVersion(state, latestVersion.versionId)
  ) {
    failCandidateValidation(
      `empty repository ${repoId} has an unverified current Version`,
    );
  }
  if (!latestVersion && state?.graphIntegrityState !== "unknown" && state) {
    failCandidateValidation(
      `empty repository ${repoId} has integrity state without a Version`,
    );
  }
  if (
    latestVersion &&
    graphIntegrityIsVerifiedForVersion(state, latestVersion.versionId)
  ) {
    await validatePersistedGraphIntegrityManifest(conn, repoId);
  }
}

async function validatePointLookups(
  conn: Connection,
): Promise<string[]> {
  const sample = await readSafeRebuildSymbolPointLookupSample(conn);
  if (sample.mismatchTotal > 0) {
    const details = sample.mismatches
      .map(
        (mismatch) =>
          `${mismatch.symbolId} [${mismatch.fields.join(", ")}]`,
      )
      .join("; ");
    failCandidateValidation(
      `Symbol scalar primary-key projection disagrees with the label scan for ${sample.mismatchTotal} row(s): ${details}`,
    );
  }
  return sample.symbolIds;
}

async function validateDependencyEndpoints(
  conn: Connection,
): Promise<void> {
  if ((await countInvalidSafeRebuildDependencyEndpoints(conn)) !== 0) {
    failCandidateValidation("DEPENDS_ON contains an empty Symbol endpoint");
  }
}

async function validateSafeRebuildStorageAfterRepo(
  repoId: string,
): Promise<void> {
  // Force the just-written node columns through LadybugDB's durable checkpoint
  // path before accepting this repository. Revalidate every earlier manifest
  // because a later repository write can expose damage in an older table page.
  await withWriteConn((conn) => execDdl(conn, "CHECKPOINT"));
  const conn = await getLadybugConn();
  try {
    await ladybugDb.assertPhysicalSymbolUniqueness(conn);
    await validateSafeRebuildCanonicalStrings(conn);
    await validatePointLookups(conn);
    await validateDependencyEndpoints(conn);
    const storedRepos = await ladybugDb.listRepos(conn, 10_000);
    for (const storedRepo of storedRepos) {
      await validateConfiguredRepo(conn, storedRepo.repoId);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failCandidateValidation(`after repository ${repoId}: ${detail}`);
  }
}

async function validateFts(
  conn: Connection,
  config: AppConfig,
): Promise<string | undefined> {
  const indexName = configuredFtsIndexName(config);
  if (!indexName) return undefined;
  const indexes = await showIndexesStrict(conn);
  if (!indexExistsForTable(indexes, "Symbol", indexName, "fts")) {
    failCandidateValidation(
      `required Symbol FTS index ${indexName} is absent`,
    );
  }
  await queryStoredProcAll<Record<string, unknown>>(
    conn,
    buildFtsStoredProcQuery(
      "Symbol",
      indexName,
      "__sdl_safe_rebuild_probe__",
      1,
      false,
    ),
  );
  return indexName;
}

/**
 * Validate a candidate through the currently open, freshly reopened pool.
 * Callers must close the build pool before invoking this function.
 */
export async function validateSafeRebuildCandidate(
  config: AppConfig,
): Promise<SafeRebuildCandidateValidation> {
  const conn = await getLadybugConn();
  const uniqueness = await ladybugDb.assertPhysicalSymbolUniqueness(conn);
  const configuredRepoIds = config.repos
    .map((repo) => repo.repoId)
    .sort((a, b) => a.localeCompare(b));
  const storedRepoIds = (await ladybugDb.listRepos(conn, 10_000))
    .map((repo) => repo.repoId)
    .sort((a, b) => a.localeCompare(b));
  if (
    configuredRepoIds.length !== storedRepoIds.length ||
    configuredRepoIds.some((repoId, index) => repoId !== storedRepoIds[index])
  ) {
    failCandidateValidation(
      `configured repositories ${JSON.stringify(configuredRepoIds)} do not match stored repositories ${JSON.stringify(storedRepoIds)}`,
    );
  }

  for (const repoId of configuredRepoIds) {
    await validateConfiguredRepo(conn, repoId);
  }
  const sampledSymbolIds = await validatePointLookups(conn);
  await validateSafeRebuildCanonicalStrings(conn);
  await validateDependencyEndpoints(conn);
  const ftsIndexName = await validateFts(conn, config);
  return {
    repoIds: configuredRepoIds,
    physicalSymbolTotal: uniqueness.physicalTotal,
    distinctSymbolTotal: uniqueness.distinctTotal,
    sampledSymbolIds,
    ...(ftsIndexName ? { ftsIndexName } : {}),
  };
}

async function requireVerifiedCurrentVersions(
  config: AppConfig,
): Promise<void> {
  const conn = await getLadybugConn();
  for (const repo of config.repos) {
    await waitForGraphIntegrityVerifier(repo.repoId);
    await validateConfiguredRepo(conn, repo.repoId);
  }
}

interface SavedGraphPathEnvironment {
  SDL_GRAPH_DB_DIR: string | undefined;
  SDL_GRAPH_DB_PATH: string | undefined;
  SDL_DB_PATH: string | undefined;
}

function setCandidateGraphPath(
  targetGraphDbPath: string,
): SavedGraphPathEnvironment {
  const saved: SavedGraphPathEnvironment = {
    SDL_GRAPH_DB_DIR: process.env.SDL_GRAPH_DB_DIR,
    SDL_GRAPH_DB_PATH: process.env.SDL_GRAPH_DB_PATH,
    SDL_DB_PATH: process.env.SDL_DB_PATH,
  };
  delete process.env.SDL_GRAPH_DB_DIR;
  process.env.SDL_GRAPH_DB_PATH = targetGraphDbPath;
  delete process.env.SDL_DB_PATH;
  return saved;
}

function restoreGraphPathEnvironment(saved: SavedGraphPathEnvironment): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * Build all configured repositories in a fresh database, then validate the
 * durable candidate after checkpoint, close, and reopen. The active database
 * path is never opened or mutated by this lifecycle.
 */
export async function runSafeRebuild(
  params: RunSafeRebuildParams,
): Promise<SafeRebuildResult> {
  const request = validateSafeRebuildRequest({
    options: params.options,
    activeGraphDbPath: params.activeGraphDbPath,
  });
  if (params.config.repos.length === 0) {
    throw new Error("--safe-rebuild requires at least one configured repository");
  }
  if (getLadybugDbPath()) {
    throw new Error(
      "--safe-rebuild must run in a fresh CLI process with no database already open",
    );
  }

  const savedEnvironment = setCandidateGraphPath(request.targetGraphDbPath);
  const indexRepoImpl = params._indexRepoForTesting ?? indexRepo;
  const initCandidate = params._initGraphDbForTesting ?? initGraphDb;
  const validateCandidate =
    params._validateCandidateForTesting ?? validateSafeRebuildCandidate;
  const validateStorageAfterRepo =
    params._validateStorageAfterRepoForTesting ??
    validateSafeRebuildStorageAfterRepo;
  const repoResults: SafeRebuildResult["repoResults"] = [];
  let candidateOpen = false;
  let completed = false;
  let primaryFailure: unknown;
  disableDerivedRefreshQueue();
  try {
    // Own cleanup before initialization starts: LadybugDB can expose a pool
    // before later schema/extension work rejects.
    candidateOpen = true;
    await initCandidate(params.config, params.configPath);
    params.onLifecycleEvent?.("candidate:opened");
    await loadConfiguredAdapterPlugins(
      params.config,
      params.configPath,
      (message) => console.log(message),
    );

    for (const repo of params.config.repos) {
      params.onRepoStart?.(repo.repoId, repo.rootPath);
      await withWriteConn(async (conn) => {
        await ladybugDb.upsertRepo(conn, {
          repoId: repo.repoId,
          rootPath: repo.rootPath,
          configJson: JSON.stringify(repo),
          createdAt: getCurrentTimestamp(),
        });
      });
      const stats = await indexRepoImpl(
        repo.repoId,
        "full",
        (progress) => params.onProgress?.(repo.repoId, progress),
        undefined,
        {
          includeTimings: Boolean(params.options.diagnostics),
          isolatedRebuild: true,
        },
      );
      // A COPY-built LadybugDB 0.18.1 Symbol table can lose earlier STRING
      // values when a later repository appends nodes and a checkpoint runs.
      // The gate checkpoints and revalidates all prior manifests so recovery
      // stops at the repository that exposes the damage.
      await validateStorageAfterRepo(repo.repoId);
      await params._afterRepoStorageValidationForTesting?.(repo.repoId);
      repoResults.push({ repoId: repo.repoId, stats });
      params.onRepoComplete?.(repo.repoId, stats);
    }
    params.onLifecycleEvent?.("candidate:indexed");

    await requireVerifiedCurrentVersions(params.config);
    params.onLifecycleEvent?.("candidate:verified-before-close");
    await shutdownDerivedRefreshQueue();
    await withWriteConn((conn) => execDdl(conn, "CHECKPOINT"));
    params.onLifecycleEvent?.("candidate:checkpointed");
    await closeLadybugDb({ preserveCloseHooks: true });
    candidateOpen = false;
    params.onLifecycleEvent?.("candidate:closed-before-reopen");

    candidateOpen = true;
    await initCandidate(params.config, params.configPath);
    params.onLifecycleEvent?.("candidate:reopened");
    const validation = await validateCandidate(params.config);
    params.onLifecycleEvent?.("candidate:validated");
    await closeLadybugDb();
    candidateOpen = false;
    params.onLifecycleEvent?.("candidate:closed-after-validation");
    completed = true;
    return {
      targetGraphDbPath: request.targetGraphDbPath,
      repoResults,
      validation,
    };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    let teardownFailure: unknown;
    if (candidateOpen) {
      try {
        await closeLadybugDb();
        if (!completed) {
          params.onLifecycleEvent?.("candidate:closed-after-failure");
        }
      } catch (error) {
        teardownFailure = error;
      }
    }
    restoreGraphPathEnvironment(savedEnvironment);
    enableDerivedRefreshQueue();
    if (teardownFailure) {
      if (primaryFailure) {
        throw new AggregateError(
          [primaryFailure, teardownFailure],
          "Safe rebuild failed and the candidate database did not close cleanly",
        );
      }
      throw teardownFailure;
    }
  }
}
