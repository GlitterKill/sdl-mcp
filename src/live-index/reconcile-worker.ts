import { logger } from "../util/logger.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { computeAndStoreClustersAndProcesses } from "../indexer/cluster-orchestrator.js";
import { withIndexingGate } from "../mcp/indexing-gate.js";
import { createDebouncedJobScheduler } from "./debounce.js";
import type { DependencyFrontier } from "./dependency-frontier.js";
import { patchSavedFile } from "./file-patcher.js";
import { planReconcileWork } from "./reconcile-planner.js";
import { ReconcileQueue } from "./reconcile-queue.js";

const MAX_DRAIN_ITERATIONS = 500;

export class ReconcileWorker {
  private draining = false;
  private pendingDrain: Promise<void> | null = null;
  private idleWaiters: Array<() => void> = [];
  private readonly clusterScheduler: {
    schedule(repoId: string, delay?: number | undefined): Promise<void> | void;
    waitForIdle(): Promise<void>;
  };
  private readonly planReconcileWorkFn: typeof planReconcileWork;
  private readonly patchSavedFileFn: typeof patchSavedFile;

  constructor(
    private readonly queue: ReconcileQueue,
    deps: {
      clusterScheduler?: {
        schedule(
          repoId: string,
          delay?: number | undefined,
        ): Promise<void> | void;
        waitForIdle(): Promise<void>;
      };
      planReconcileWork?: typeof planReconcileWork;
      patchSavedFile?: typeof patchSavedFile;
    } = {},
  ) {
    this.clusterScheduler =
      deps.clusterScheduler ??
      createDebouncedJobScheduler({
        delayMs: 5000,
        run: async (repoId) => {
          // Gate cluster/process recomputation through the indexing gate so
          // tool-dispatch throttles while these writes run, avoiding the
          // LadybugDB 0.15.2 native-concurrency abort.
          await withIndexingGate(async () => {
            const conn = await getLadybugConn();
            const latestVersion = await ladybugDb.getLatestVersion(
              conn,
              repoId,
            );
            await computeAndStoreClustersAndProcesses({
              conn,
              repoId,
              versionId: latestVersion?.versionId ?? "live-reconcile",
            });
          });
        },
      });
    this.planReconcileWorkFn = deps.planReconcileWork ?? planReconcileWork;
    this.patchSavedFileFn = deps.patchSavedFile ?? patchSavedFile;
  }

  enqueue(
    repoId: string,
    frontier: DependencyFrontier,
    enqueuedAt = new Date().toISOString(),
  ): void {
    this.queue.enqueue(repoId, frontier, enqueuedAt);
    this.ensureDraining();
  }

  private ensureDraining(): void {
    if (!this.pendingDrain) {
      this.pendingDrain = this.drain().finally(() => {
        this.pendingDrain = null;
        // Check if new items were enqueued between drain teardown and
        // pendingDrain being cleared — restart the drain if needed.
        if (this.queue.peekNext()) {
          this.ensureDraining();
        }
      });
    }
  }

  async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pendingDrain) {
      if (Date.now() > deadline) {
        logger.warn("waitForIdle timed out waiting for pendingDrain", {
          timeoutMs,
        });
        return;
      }
      await this.pendingDrain;
    }
    if (this.draining) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            const idx = this.idleWaiters.indexOf(resolve);
            if (idx !== -1) this.idleWaiters.splice(idx, 1);
            logger.warn("waitForIdle timed out waiting for drain completion", {
              timeoutMs,
            });
            resolve();
          },
          Math.max(0, deadline - Date.now()),
        );
        this.idleWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
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
      let iterations = 0;

      while (this.draining) {
        if (iterations >= MAX_DRAIN_ITERATIONS) {
          logger.error(
            `[ReconcileWorker] Reached MAX_DRAIN_ITERATIONS (${MAX_DRAIN_ITERATIONS}). Possible infinite loop in dependency frontier expansion.`,
          );
          break;
        }

        const claimed = this.queue.claimNext();
        if (!claimed) {
          break;
        }

        try {
          const plan = this.planReconcileWorkFn({
            repoId: claimed.repoId,
            frontier: claimed.frontier,
          });
          const seenFiles = new Set<string>();

          for (const filePath of plan.filePaths) {
            const fileKey = `${claimed.repoId}:${filePath}`;
            if (seenFiles.has(fileKey)) {
              continue;
            }
            seenFiles.add(fileKey);
            iterations++;

            try {
              // Gate each file patch through the indexing gate: live-index
              // writes mutex against tool dispatch the same way indexRepo
              // does, narrowing native-concurrency risk during the WAL
              // abort window in LadybugDB 0.15.2.
              const patched = await withIndexingGate(() =>
                this.patchSavedFileFn({
                  repoId: claimed.repoId,
                  filePath,
                }),
              );
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
            } catch (fileError) {
              logger.warn(
                "[ReconcileWorker] Failed to patch file " +
                  filePath +
                  " in " +
                  claimed.repoId +
                  ": " +
                  (fileError instanceof Error
                    ? fileError.message
                    : String(fileError)),
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
