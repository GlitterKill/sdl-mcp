import type { AppConfig } from "../config/types.js";
import { getLadybugConn } from "../db/ladybug.js";
import { listAllRepoIds } from "../db/ladybug-repos.js";
import { getLatestVersion } from "../db/ladybug-versions.js";
import {
  getDerivedStateFromConnection,
  getDerivedStateSummary,
  type DerivedStateRow,
  type DerivedStateSummary,
} from "../db/ladybug-derived-state.js";
import { enqueueDerivedRefresh } from "../indexer/derived-refresh-queue.js";
import { startGraphIntegrityVerifierRecovery } from "../indexer/provider-first/background-graph-integrity-verifier.js";
import { logger } from "../util/logger.js";
import {
  assessRepositorySymbolVectorHealth,
  clearRepositorySymbolVectorHealth,
  createRepositorySymbolVectorDiagnostic,
  invalidateRepositorySymbolVectorHealth,
  listRepositorySymbolVectorHealthRepoIds,
  listRepositorySymbolVectorTableNames,
  publishRepositorySymbolVectorHealthBatch,
  publishRepositorySymbolVectorDiagnostics,
  type RepositorySymbolVectorDiagnostic,
  type SymbolVectorHealthSnapshot,
} from "../retrieval/health.js";
import { resolveSymbolVectorPhysicalIdentity } from "../db/ladybug-symbol-embeddings.js";

export interface DerivedStateStartupRecoveryResult {
  checked: number;
  queued: number;
  skipped: number;
  failed: number;
}

export interface DerivedStateStartupRecoveryDeps {
  getDerivedStateSummary?: typeof getDerivedStateSummary;
  enqueueDerivedRefresh?: typeof enqueueDerivedRefresh;
  startGraphIntegrityVerifierRecovery?: typeof startGraphIntegrityVerifierRecovery;
  logInfo?: typeof logger.info;
  logWarn?: typeof logger.warn;
}

function dirtyFlags(summary: DerivedStateSummary): string[] {
  return [
    summary.clustersDirty && "clusters",
    summary.processesDirty && "processes",
    summary.algorithmsDirty && "algorithms",
    summary.summariesDirty && "summaries",
    summary.embeddingsDirty && "embeddings",
  ].filter((flag): flag is string => Boolean(flag));
}

function graphDirtyFlags(summary: DerivedStateSummary): string[] {
  return [
    summary.clustersDirty && "clusters",
    summary.processesDirty && "processes",
    summary.algorithmsDirty && "algorithms",
  ].filter((flag): flag is string => Boolean(flag));
}

/**
 * Recover derived refreshes that were intentionally deferred by one-shot CLI
 * indexing. The dirty marker is persisted in LadybugDB, but the graph-derived
 * queue itself is process-local, so server startup must re-enqueue stale graph
 * targets. Semantic-only dirty state is reported but not enqueued here because
 * this queue does not refresh summaries or embeddings.
 */
export async function recoverStaleDerivedStateOnStartup(
  config: Pick<AppConfig, "repos">,
  log: (message: string) => void,
  deps: DerivedStateStartupRecoveryDeps = {},
): Promise<DerivedStateStartupRecoveryResult> {
  const readSummary = deps.getDerivedStateSummary ?? getDerivedStateSummary;
  const enqueue = deps.enqueueDerivedRefresh ?? enqueueDerivedRefresh;
  const startVerifierRecovery =
    deps.startGraphIntegrityVerifierRecovery ??
    startGraphIntegrityVerifierRecovery;
  const logInfo = deps.logInfo ?? logger.info.bind(logger);
  const logWarn = deps.logWarn ?? logger.warn.bind(logger);

  const result: DerivedStateStartupRecoveryResult = {
    checked: 0,
    queued: 0,
    skipped: 0,
    failed: 0,
  };

  for (const repo of config.repos) {
    result.checked += 1;

    try {
      const summary = await readSummary(repo.repoId);
      if (!summary?.stale) {
        result.skipped += 1;
        continue;
      }

      if (!summary.targetVersionId) {
        result.failed += 1;
        const message = `Deferred derived-state refresh for ${repo.repoId} is stale but has no target version.`;
        log(message);
        logWarn("derived-state startup recovery skipped missing target", {
          repoId: repo.repoId,
        });
        continue;
      }

      const flags = dirtyFlags(summary);
      const graphFlags = graphDirtyFlags(summary);
      if (graphFlags.length === 0) {
        result.skipped += 1;
        const message = `Semantic readiness remains deferred for ${repo.repoId} (dirty=${flags.join(", ") || "unknown"})`;
        log(message);
        logInfo("derived-state startup recovery skipped semantic-only state", {
          repoId: repo.repoId,
          dirtyFlags: flags,
          computedVersionId: summary.computedVersionId,
          targetVersionId: summary.targetVersionId,
        });
        continue;
      }

      enqueue(repo.repoId, summary.targetVersionId);
      result.queued += 1;

      const message = `Queued deferred derived-state refresh for ${repo.repoId} (target=${summary.targetVersionId}, dirty=${flags.join(", ") || "unknown"})`;
      log(message);
      logInfo("derived-state startup recovery queued", {
        repoId: repo.repoId,
        targetVersionId: summary.targetVersionId,
        dirtyFlags: flags,
        computedVersionId: summary.computedVersionId,
        lastError: summary.lastError ?? null,
      });
    } catch (error) {
      result.failed += 1;
      const message = `Failed to recover deferred derived-state refresh for ${repo.repoId}: ${error instanceof Error ? error.message : String(error)}`;
      log(message);
      logWarn("derived-state startup recovery failed", {
        repoId: repo.repoId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await startVerifierRecovery();

  const summary = `Derived-state recovery: checked ${result.checked} repo(s), queued ${result.queued} stale repo(s), skipped ${result.skipped}, failed ${result.failed}.`;
  log(summary);
  logInfo("derived-state startup recovery complete", { ...result });

  return result;
}


export interface ReassessAllRepositoryVectorHealthDeps {
  getConnection?: typeof getLadybugConn;
  listStoredRepoIds?: typeof listAllRepoIds;
  listCachedRepoIds?: typeof listRepositorySymbolVectorHealthRepoIds;
  listVectorTables?: typeof listRepositorySymbolVectorTableNames;
  publishDiagnostics?: (
    diagnostics: readonly RepositorySymbolVectorDiagnostic[],
  ) => void;
  getLatestVersion?: typeof getLatestVersion;
  getDerivedState?: typeof getDerivedStateFromConnection;
  assess?: typeof assessRepositorySymbolVectorHealth;
  clear?: typeof clearRepositorySymbolVectorHealth;
  invalidate?: typeof invalidateRepositorySymbolVectorHealth;
  publish?: typeof publishRepositorySymbolVectorHealthBatch;
}

interface RepositoryVectorReassessment {
  repoId: string;
  versionId: string | null;
  lifecycleState: "steady" | "refreshing" | "deleting";
  generation: number;
  snapshots?: SymbolVectorHealthSnapshot[];
}

function resolveReassessmentLifecycle(
  state: DerivedStateRow | null,
  latestVersionId: string | null,
): "steady" | "refreshing" | "deleting" {
  if (state?.embeddingLifecycleState === "deleting") return "deleting";
  // A clean marker for an older target cannot admit vectors for a newer graph.
  return state &&
    latestVersionId !== null &&
    state.targetVersionId === latestVersionId &&
    !state.embeddingsDirty &&
    state.embeddingLifecycleState === "steady"
    ? "steady"
    : "refreshing";
}

/**
 * Rebuild the process-local vector-health cache from durable facts after the
 * active LadybugDB family changes. This operation is observational: it issues
 * no vector-table DML or index DDL.
 */
export async function reassessAndPublishAllRepositoryVectorHealth(
  config: Pick<AppConfig, "repos" | "semantic">,
  deps: ReassessAllRepositoryVectorHealthDeps = {},
): Promise<readonly string[]> {
  const getConnection = deps.getConnection ?? getLadybugConn;
  const readStoredRepoIds = deps.listStoredRepoIds ?? listAllRepoIds;
  const readCachedRepoIds =
    deps.listCachedRepoIds ?? listRepositorySymbolVectorHealthRepoIds;
  const readVectorTables =
    deps.listVectorTables ?? listRepositorySymbolVectorTableNames;
  const publishDiagnostics =
    deps.publishDiagnostics ??
    ((diagnostics: readonly RepositorySymbolVectorDiagnostic[]) => {
      publishRepositorySymbolVectorDiagnostics(diagnostics);
      for (const diagnostic of diagnostics) {
        logger.warn(diagnostic.message, {
          code: diagnostic.code,
          ...(diagnostic.repoId ? { repoId: diagnostic.repoId } : {}),
          tableName: diagnostic.tableName,
        });
      }
    });
  const readLatestVersion = deps.getLatestVersion ?? getLatestVersion;
  const readDerivedState =
    deps.getDerivedState ?? getDerivedStateFromConnection;
  const assess = deps.assess ?? assessRepositorySymbolVectorHealth;
  const clear = deps.clear ?? clearRepositorySymbolVectorHealth;
  const invalidate = deps.invalidate ?? invalidateRepositorySymbolVectorHealth;
  const publish = deps.publish ?? publishRepositorySymbolVectorHealthBatch;

  const configuredRepoIds = config.repos.map((repo) => repo.repoId);
  let cachedRepoIds: readonly string[] = [];
  try {
    cachedRepoIds = readCachedRepoIds();
  } catch {
    // A cache inventory failure must not prevent configured repositories from
    // being synchronously fenced before the active database is inspected.
  }
  const initiallyKnownRepoIds = Object.freeze(
    [...new Set([...cachedRepoIds, ...configuredRepoIds])].sort((left, right) =>
      left.localeCompare(right),
    ),
  );
  const hardInvalidate = (
    repoId: string,
    versionId: string | null,
    lifecycleState: "steady" | "refreshing" | "deleting" = "refreshing",
  ): number | null => {
    try {
      return invalidate(
        repoId,
        versionId,
        config.semantic,
        lifecycleState === "deleting" ? "deleting" : "refreshing",
      );
    } catch {
      // The invalidator deletes the cache entry before rethrowing. Reassessment
      // remains fail-closed even when model-plan construction itself fails.
      return null;
    }
  };

  // Fence every process-local generation we can name before any fallible DB
  // access. This protects failed/unknown shadow activation reopen paths.
  for (const repoId of initiallyKnownRepoIds) {
    hardInvalidate(repoId, null);
  }

  let conn: Awaited<ReturnType<typeof getLadybugConn>>;
  let storedRepoIds: readonly string[];
  let vectorTableNames: readonly string[];
  try {
    conn = await getConnection();
    storedRepoIds = await readStoredRepoIds(conn);
    vectorTableNames = await readVectorTables(conn);
  } catch (error) {
    for (const repoId of initiallyKnownRepoIds) {
      hardInvalidate(repoId, null);
    }
    throw error;
  }

  const repoIds = Object.freeze(
    [...new Set([...storedRepoIds, ...configuredRepoIds])].sort((left, right) =>
      left.localeCompare(right),
    ),
  );
  for (const repoId of cachedRepoIds) {
    if (!repoIds.includes(repoId)) clear(repoId);
  }
  const repositories: RepositoryVectorReassessment[] = [];
  const registeredVectorTables = new Set(
    storedRepoIds.map(
      (repoId) =>
        resolveSymbolVectorPhysicalIdentity(
          repoId,
          "jina-embeddings-v2-base-code",
        ).tableName,
    ),
  );
  const diagnostics: RepositorySymbolVectorDiagnostic[] = [
    ...new Set(vectorTableNames),
  ]
    .filter((tableName) => !registeredVectorTables.has(tableName))
    .map((tableName) =>
      createRepositorySymbolVectorDiagnostic("orphan-table", tableName),
    );

  // Newly discovered stored repositories must also be fenced before their
  // durable version or lifecycle state is read.
  for (const repoId of repoIds) {
    if (!initiallyKnownRepoIds.includes(repoId)) {
      hardInvalidate(repoId, null);
    }
  }

  try {
    for (const repoId of repoIds) {
      const latestVersion = await readLatestVersion(conn, repoId);
      const derivedState = await readDerivedState(conn, repoId);
      const versionId =
        latestVersion?.versionId ?? derivedState?.targetVersionId ?? null;
      const lifecycleState = resolveReassessmentLifecycle(
        derivedState,
        latestVersion?.versionId ?? null,
      );
      const generation = hardInvalidate(repoId, versionId, lifecycleState);
      if (generation === null) {
        throw new Error(
          `Cannot publish repository vector-health degradation for ${repoId}`,
        );
      }
      repositories.push({
        repoId,
        versionId,
        lifecycleState,
        generation,
      });
      if (lifecycleState === "deleting") {
        diagnostics.push(
          createRepositorySymbolVectorDiagnostic(
            "deletion-pending",
            resolveSymbolVectorPhysicalIdentity(
              repoId,
              "jina-embeddings-v2-base-code",
            ).tableName,
            repoId,
          ),
        );
      }
    }

    publishDiagnostics(diagnostics);

    for (const repository of repositories) {
      repository.snapshots = await assess(conn, {
        repoId: repository.repoId,
        versionId: repository.versionId,
        generation: repository.generation,
        lifecycleState: repository.lifecycleState,
        semanticConfig: config.semantic,
      });
    }

    for (const repository of repositories) {
      const snapshots = repository.snapshots ?? [];
      const published = publish({
        repoId: repository.repoId,
        versionId: repository.versionId,
        capturedGeneration: repository.generation,
        enabledModels: snapshots.map((snapshot) => snapshot.model),
        snapshots,
      });
      if (!published) {
        throw new Error(
          `Repository vector-health generation changed during reassessment for ${repository.repoId}`,
        );
      }
    }
  } catch (error) {
    for (const repository of repositories) {
      hardInvalidate(
        repository.repoId,
        repository.versionId,
        repository.lifecycleState,
      );
    }
    for (const repoId of repoIds) {
      if (!repositories.some((repository) => repository.repoId === repoId)) {
        hardInvalidate(repoId, null);
      }
    }
    throw error;
  }

  return repoIds;
}
