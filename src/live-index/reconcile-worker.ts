import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";
import { computeAndStoreClustersAndProcesses } from "../indexer/cluster-orchestrator.js";
import { createDebouncedJobScheduler } from "./debounce.js";
import type { DependencyFrontier } from "./dependency-frontier.js";
import { patchSavedFile } from "./file-patcher.js";
import { planReconcileWork } from "./reconcile-planner.js";
import { ReconcileQueue } from "./reconcile-queue.js";

const MAX_DRAIN_ITERATIONS = 500;

export class ReconcileWorker {
  private draining = false;
  private idleWaiters: Array<() => void> = [];

  private readonly clusterScheduler = createDebouncedJobScheduler({
    delayMs: 5000,
    run: async (repoId) => {
      const conn = await getKuzuConn();
      const latestVersion = await kuzuDb.getLatestVersion(conn, repoId);
      await computeAndStoreClustersAndProcesses({
        conn,
        repoId,
        versionId: latestVersion?.versionId ?? "live-reconcile",
      });
    },
  });

  constructor(private readonly queue: ReconcileQueue) {}

  enqueue(repoId: string, frontier: DependencyFrontier, enqueuedAt = new Date().toISOString()): void {
    this.queue.enqueue(repoId, frontier, enqueuedAt);
    void this.drain();
  }

  async waitForIdle(): Promise<void> {
    if (this.draining) {
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve);
      });
    }
    await this.clusterScheduler.waitForIdle();
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;

    try {
      const visitedFiles = new Set<string>();
      let iterations = 0;

      while (true) {
        if (iterations >= MAX_DRAIN_ITERATIONS) {
          console.error(`[ReconcileWorker] Reached MAX_DRAIN_ITERATIONS (${MAX_DRAIN_ITERATIONS}). Possible infinite loop in dependency frontier expansion.`);
          break;
        }

        const claimed = this.queue.claimNext();
        if (!claimed) {
          break;
        }

        try {
          const plan = planReconcileWork({
            repoId: claimed.repoId,
            frontier: claimed.frontier,
          });

          for (const filePath of plan.filePaths) {
            const fileKey = `${claimed.repoId}:${filePath}`;
            if (visitedFiles.has(fileKey)) {
              continue;
            }
            visitedFiles.add(fileKey);
            iterations++;

            const patched = await patchSavedFile({
              repoId: claimed.repoId,
              filePath,
            });
            if (
              patched.frontier.dependentFilePaths.length > 0 ||
              patched.frontier.importedFilePaths.length > 0 ||
              patched.frontier.invalidations.length > 0
            ) {
              this.queue.enqueue(
                claimed.repoId,
                patched.frontier,
                new Date().toISOString(),
              );
            }
          }

          if (plan.recomputeDerivedData) {
            void this.clusterScheduler.schedule(claimed.repoId, undefined);
          }

          this.queue.complete(claimed.repoId, new Date().toISOString());
        } catch (error) {
          this.queue.fail(
            claimed.repoId,
            new Date().toISOString(),
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      this.draining = false;
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) {
        resolve();
      }
    }
  }
}
