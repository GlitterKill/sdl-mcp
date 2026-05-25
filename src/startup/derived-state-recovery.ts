import type { AppConfig } from "../config/types.js";
import {
  getDerivedStateSummary,
  type DerivedStateSummary,
} from "../db/ladybug-derived-state.js";
import { enqueueDerivedRefresh } from "../indexer/derived-refresh-queue.js";
import { logger } from "../util/logger.js";

export interface DerivedStateStartupRecoveryResult {
  checked: number;
  queued: number;
  skipped: number;
  failed: number;
}

export interface DerivedStateStartupRecoveryDeps {
  getDerivedStateSummary?: typeof getDerivedStateSummary;
  enqueueDerivedRefresh?: typeof enqueueDerivedRefresh;
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

  const summary = `Derived-state recovery: checked ${result.checked} repo(s), queued ${result.queued} stale repo(s), skipped ${result.skipped}, failed ${result.failed}.`;
  log(summary);
  logInfo("derived-state startup recovery complete", { ...result });

  return result;
}
