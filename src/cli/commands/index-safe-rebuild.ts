import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Connection } from "kuzu";
import { resolveSemanticEmbeddingModelPlan } from "../../config/semantic-embedding-model-plan.js";
import type { AppConfig } from "../../config/types.js";
import {
  closeAndPublishSafeRebuildLadybugDb,
  closeLadybugDb,
  closeSafeRebuildBeforeReopen,
  getLadybugConn,
  getLadybugDbPath,
  withWriteConn,
  type SafeRebuildLadybugSession,
} from "../../db/ladybug.js";
import {
  initSafeRebuildGraphDb,
  reopenSafeRebuildGraphDb,
} from "../../db/initGraphDb.js";
import { getLadybugLineageMarkerPath } from "../../db/ladybug-lineage.js";
import { execCheckpoint, queryStoredProcAll } from "../../db/ladybug-core.js";
import { withExclusiveLadybugOperation } from "../../db/ladybug-operation-gate.js";
import {
  getDerivedStateFromConnection,
  graphIntegrityIsVerifiedForVersion,
  type EmbeddingLifecycleState,
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
  queryVectorIndexProbe,
  showIndexesStrict,
} from "../../retrieval/index-lifecycle.js";
import {
  assessRepositorySymbolVectorHealth,
  listRepositorySymbolVectorTableNames,
  type SymbolVectorHealthSnapshot,
} from "../../retrieval/health.js";
import {
  getRepoSymbolVectorProbe,
  resolveSymbolVectorPhysicalIdentity,
} from "../../db/ladybug-symbol-embeddings.js";
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

export interface SafeRebuildRepositoryModelValidation {
  repoId: string;
  model: string;
  mode: "none" | "exact" | "hnsw";
  completeVectorCount: number;
  tableName: string;
  indexName?: string;
}

export interface SafeRebuildCandidateValidation {
  repoIds: string[];
  physicalSymbolTotal: number;
  distinctSymbolTotal: number;
  sampledSymbolIds: string[];
  repositoryVectorTables: string[];
  repositoryVectors: SafeRebuildRepositoryModelValidation[];
  ftsIndexName?: string;
}

export interface SafeRebuildCandidatePlan {
  readonly config: AppConfig;
  readonly repoIds: readonly string[];
  readonly symbolEmbeddingModels: readonly string[];
  readonly repositoryModels: readonly {
    readonly repoId: string;
    readonly models: readonly string[];
  }[];
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
  /** @internal deterministic target-appearance seam after preflight. */
  _beforeCandidateInitForTesting?: () => void;
  /** @internal deterministic failure seam after a purpose-specific open. */
  _afterCandidateOpenForTesting?: (
    phase: "initial" | "reopen",
  ) => void | Promise<void>;
  /** @internal deterministic replacement seam before receipt publication. */
  _beforeLineagePublicationForTesting?: () => void;
  /** @internal deterministic candidate-validation replacement seam. */
  _validateCandidateForTesting?: (
    plan: SafeRebuildCandidatePlan,
  ) => Promise<SafeRebuildCandidateValidation>;
  /** @internal deterministic per-repository storage failure seam. */
  _validateStorageAfterRepoForTesting?: (
    repoId: string,
  ) => Promise<void>;
  /** @internal observes successful per-repository storage validation. */
  _afterRepoStorageValidationForTesting?: (
    repoId: string,
  ) => void | Promise<void>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Capture configuration and the deterministic repository/model cross-product
 * once. Build and both validation passes consume this immutable snapshot.
 */
export function freezeSafeRebuildCandidatePlan(
  config: AppConfig,
): SafeRebuildCandidatePlan {
  const frozenConfig = structuredClone(config);
  const repoIds = frozenConfig.repos
    .map((repo) => repo.repoId)
    .sort((left, right) => left.localeCompare(right));
  if (new Set(repoIds).size !== repoIds.length) {
    throw new Error("--safe-rebuild requires unique configured repository IDs");
  }
  const symbolEmbeddingModels =
    frozenConfig.semantic?.enabled === false
      ? []
      : resolveSemanticEmbeddingModelPlan(frozenConfig.semantic)
          .symbolEmbeddingModels;
  const repositoryModels = repoIds.map((repoId) => ({
    repoId,
    models: [...symbolEmbeddingModels],
  }));
  return deepFreeze({
    config: frozenConfig,
    repoIds,
    symbolEmbeddingModels: [...symbolEmbeddingModels],
    repositoryModels,
  });
}

function isSafeRebuildCandidatePlan(
  value: AppConfig | SafeRebuildCandidatePlan,
): value is SafeRebuildCandidatePlan {
  return (
    Object.hasOwn(value, "config") &&
    Object.hasOwn(value, "repoIds") &&
    Object.hasOwn(value, "repositoryModels")
  );
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
    getLadybugLineageMarkerPath(targetGraphDbPath),
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

interface ValidatedSafeRebuildRepoState {
  versionId: string | null;
  lifecycleState: EmbeddingLifecycleState;
}

async function validateConfiguredRepo(
  conn: Connection,
  repoId: string,
): Promise<ValidatedSafeRebuildRepoState> {
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
  const lifecycleState = state?.embeddingLifecycleState ?? "steady";

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
    return { versionId: latestVersion.versionId, lifecycleState };
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
  return {
    versionId: latestVersion?.versionId ?? null,
    lifecycleState,
  };
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

function checkpointSafeRebuild(): Promise<void> {
  // Operation admission must precede the write limiter.
  return withExclusiveLadybugOperation(() =>
    withWriteConn((conn) => execCheckpoint(conn)),
  );
}

async function validateSafeRebuildStorageAfterRepo(
  repoId: string,
): Promise<void> {
  // Force the just-written node columns through LadybugDB's durable checkpoint
  // path before accepting this repository. Revalidate every earlier manifest
  // because a later repository write can expose damage in an older table page.
  await checkpointSafeRebuild();
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

function vectorValidationDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertFrozenModels(
  repoId: string,
  expectedModels: readonly string[],
  snapshots: readonly SymbolVectorHealthSnapshot[],
): void {
  if (
    snapshots.length !== expectedModels.length ||
    snapshots.some((snapshot, index) => snapshot.model !== expectedModels[index])
  ) {
    failCandidateValidation(
      `repository ${repoId} vector assessment models ${JSON.stringify(
        snapshots.map((snapshot) => snapshot.model),
      )} do not match frozen models ${JSON.stringify(expectedModels)}`,
    );
  }
}

async function validateRepositoryVectors(
  conn: Connection,
  plan: SafeRebuildCandidatePlan,
  repoStates: ReadonlyMap<string, ValidatedSafeRebuildRepoState>,
): Promise<{
  repositoryVectorTables: string[];
  repositoryVectors: SafeRebuildRepositoryModelValidation[];
}> {
  const indexes = await showIndexesStrict(conn);
  const expectedTables = new Set<string>();
  const repositoryVectors: SafeRebuildRepositoryModelValidation[] = [];

  for (const repository of plan.repositoryModels) {
    const state = repoStates.get(repository.repoId);
    if (!state) {
      failCandidateValidation(
        `repository ${repository.repoId} has no validated durable state`,
      );
    }

    let snapshots: SymbolVectorHealthSnapshot[];
    try {
      snapshots = await assessRepositorySymbolVectorHealth(conn, {
        repoId: repository.repoId,
        versionId: state.versionId,
        generation: 0,
        lifecycleState: state.lifecycleState,
        semanticConfig: plan.config.semantic,
        indexes,
      });
    } catch (error) {
      failCandidateValidation(
        `repository ${repository.repoId} vector assessment failed: ${vectorValidationDetail(error)}`,
      );
    }
    assertFrozenModels(repository.repoId, repository.models, snapshots);

    for (const snapshot of snapshots) {
      const identity = resolveSymbolVectorPhysicalIdentity(
        repository.repoId,
        snapshot.model,
        plan.config.semantic,
      );
      if (
        snapshot.expectedIndexIdentity.tableName !== identity.tableName ||
        snapshot.expectedIndexIdentity.name !== identity.indexName ||
        snapshot.expectedIndexIdentity.property !== identity.propertyName
      ) {
        failCandidateValidation(
          `repository ${repository.repoId} model ${snapshot.model} resolved an inconsistent vector identity`,
        );
      }
      if (snapshot.completeVectorCount > 0) {
        expectedTables.add(identity.tableName);
      }
      if (snapshot.mode === "degraded") {
        failCandidateValidation(
          `repository ${repository.repoId} model ${snapshot.model} is degraded: ${snapshot.reason ?? "unknown durable health failure"}`,
        );
      }

      if (snapshot.mode !== "none") {
        let probe;
        try {
          probe = await getRepoSymbolVectorProbe(
            conn,
            identity,
            repository.repoId,
            snapshot.model,
          );
        } catch (error) {
          failCandidateValidation(
            `repository ${repository.repoId} model ${snapshot.model} exact probe failed: ${vectorValidationDetail(error)}`,
          );
        }
        if (!probe) {
          failCandidateValidation(
            `repository ${repository.repoId} model ${snapshot.model} has no complete exact probe row`,
          );
        }
        if (!probe.vectorArray.every((value) => Number.isFinite(value))) {
          failCandidateValidation(
            `repository ${repository.repoId} model ${snapshot.model} exact probe contains a non-finite vector value`,
          );
        }
        if (snapshot.mode === "hnsw") {
          let resultCount: number;
          try {
            resultCount = await queryVectorIndexProbe(
              conn,
              identity,
              repository.repoId,
              snapshot.model,
              probe.vectorArray,
            );
          } catch (error) {
            failCandidateValidation(
              `repository ${repository.repoId} model ${snapshot.model} ANN probe failed: ${vectorValidationDetail(error)}`,
            );
          }
          if (resultCount === 0) {
            failCandidateValidation(
              `repository ${repository.repoId} model ${snapshot.model} ANN probe returned no rows`,
            );
          }
        }
      }

      repositoryVectors.push({
        repoId: repository.repoId,
        model: snapshot.model,
        mode: snapshot.mode,
        completeVectorCount: snapshot.completeVectorCount,
        tableName: identity.tableName,
        ...(snapshot.mode === "hnsw"
          ? { indexName: identity.indexName }
          : {}),
      });
    }
  }

  const repositoryVectorTables = await listRepositorySymbolVectorTableNames(conn);
  const expectedRepositoryVectorTables = [...expectedTables].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    repositoryVectorTables.length !== expectedRepositoryVectorTables.length ||
    repositoryVectorTables.some(
      (tableName, index) =>
        tableName !== expectedRepositoryVectorTables[index],
    )
  ) {
    failCandidateValidation(
      `repository vector tables ${JSON.stringify(
        repositoryVectorTables,
      )} do not match expected tables ${JSON.stringify(
        expectedRepositoryVectorTables,
      )}`,
    );
  }

  return { repositoryVectorTables, repositoryVectors };
}

/**
 * Validate a candidate through the currently open pool. The same frozen plan
 * is assessed before checkpoint and again after the single durability reopen.
 */
export async function validateSafeRebuildCandidate(
  configOrPlan: AppConfig | SafeRebuildCandidatePlan,
): Promise<SafeRebuildCandidateValidation> {
  const plan = isSafeRebuildCandidatePlan(configOrPlan)
    ? configOrPlan
    : freezeSafeRebuildCandidatePlan(configOrPlan);
  const conn = await getLadybugConn();
  const uniqueness = await ladybugDb.assertPhysicalSymbolUniqueness(conn);
  const storedRepoIds = (await ladybugDb.listRepos(conn, 10_000))
    .map((repo) => repo.repoId)
    .sort((left, right) => left.localeCompare(right));
  if (
    plan.repoIds.length !== storedRepoIds.length ||
    plan.repoIds.some((repoId, index) => repoId !== storedRepoIds[index])
  ) {
    failCandidateValidation(
      `configured repositories ${JSON.stringify(plan.repoIds)} do not match stored repositories ${JSON.stringify(storedRepoIds)}`,
    );
  }

  const repoStates = new Map<string, ValidatedSafeRebuildRepoState>();
  for (const repoId of plan.repoIds) {
    repoStates.set(repoId, await validateConfiguredRepo(conn, repoId));
  }
  const sampledSymbolIds = await validatePointLookups(conn);
  await validateSafeRebuildCanonicalStrings(conn);
  await validateDependencyEndpoints(conn);
  const ftsIndexName = await validateFts(conn, plan.config);
  const vectorValidation = await validateRepositoryVectors(
    conn,
    plan,
    repoStates,
  );
  return {
    repoIds: [...plan.repoIds],
    physicalSymbolTotal: uniqueness.physicalTotal,
    distinctSymbolTotal: uniqueness.distinctTotal,
    sampledSymbolIds,
    ...vectorValidation,
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
  const plan = freezeSafeRebuildCandidatePlan(params.config);
  if (plan.config.repos.length === 0) {
    throw new Error("--safe-rebuild requires at least one configured repository");
  }
  if (getLadybugDbPath()) {
    throw new Error(
      "--safe-rebuild must run in a fresh CLI process with no database already open",
    );
  }

  params._beforeCandidateInitForTesting?.();
  const savedEnvironment = setCandidateGraphPath(request.targetGraphDbPath);
  const indexRepoImpl = params._indexRepoForTesting ?? indexRepo;
  const validateCandidate =
    params._validateCandidateForTesting ?? validateSafeRebuildCandidate;
  const validateStorageAfterRepo =
    params._validateStorageAfterRepoForTesting ??
    validateSafeRebuildStorageAfterRepo;
  const repoResults: SafeRebuildResult["repoResults"] = [];
  let candidateOpen = false;
  let safeRebuildSession: SafeRebuildLadybugSession | null = null;
  let completed = false;
  let primaryFailure: unknown;
  disableDerivedRefreshQueue();
  try {
    // Own cleanup before initialization starts: LadybugDB can expose a pool
    // before later schema/extension work rejects.
    candidateOpen = true;
    const safeRebuildHandle = await initSafeRebuildGraphDb(
      plan.config,
      params.configPath,
    );
    safeRebuildSession = safeRebuildHandle.session;
    await params._afterCandidateOpenForTesting?.("initial");
    params.onLifecycleEvent?.("candidate:opened");
    await loadConfiguredAdapterPlugins(
      plan.config,
      params.configPath,
      (message) => console.log(message),
    );

    for (const repo of plan.config.repos) {
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

    await requireVerifiedCurrentVersions(plan.config);
    await shutdownDerivedRefreshQueue();
    const validationBeforeClose = await validateCandidate(plan);
    params.onLifecycleEvent?.("candidate:verified-before-close");
    await checkpointSafeRebuild();
    params.onLifecycleEvent?.("candidate:checkpointed");
    if (!safeRebuildSession) {
      throw new Error("Safe rebuild family lease is unavailable before reopen");
    }
    await closeSafeRebuildBeforeReopen(safeRebuildSession);
    candidateOpen = false;
    params.onLifecycleEvent?.("candidate:closed-before-reopen");

    candidateOpen = true;
    await reopenSafeRebuildGraphDb(
      plan.config,
      params.configPath,
      safeRebuildSession,
    );
    await params._afterCandidateOpenForTesting?.("reopen");
    params.onLifecycleEvent?.("candidate:reopened");
    const validation = await validateCandidate(plan);
    if (
      JSON.stringify(validation) !== JSON.stringify(validationBeforeClose)
    ) {
      failCandidateValidation(
        "candidate facts changed between pre-close and post-reopen validation",
      );
    }
    params.onLifecycleEvent?.("candidate:validated");
    if (!safeRebuildSession) {
      throw new Error("Safe rebuild family lease is unavailable after validation");
    }
    await closeAndPublishSafeRebuildLadybugDb(
      safeRebuildSession,
      params._beforeLineagePublicationForTesting,
    );
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
    if (!completed && (candidateOpen || safeRebuildSession)) {
      try {
        await closeLadybugDb({ strict: true });
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
