import { lstat } from "node:fs/promises";
import { getLadybugConn } from "../db/ladybug.js";
import * as db from "../db/ladybug-queries.js";
import { loadConfig } from "../config/loadConfig.js";
import { RepoConfigSchema } from "../config/types.js";
import { readRepositoryFileBounded } from "../indexer/provider-first/executor.js";
import {
  prepareReconcileFiles,
  type ReconcileSourceSnapshot,
} from "../indexer/provider-first/reconcile-preparation.js";
import {
  captureActiveRepoEpoch,
  withRepoMutation,
} from "../services/repo-lifecycle.js";
import { hashContent, hashValue } from "../util/hashing.js";
import { logger } from "../util/logger.js";
import { getAbsolutePathFromRepoRoot } from "../util/paths.js";
import type { DependencyFrontier } from "./dependency-frontier.js";
import { captureReconcileDependencyInputs } from "./reconcile-planner.js";
import {
  ReconcileQueue,
  type ReconcileInput,
  type ReconcileClaim,
} from "./reconcile-queue.js";
import {
  captureReconcileGraphBaseline,
  prepareReconcilePublication,
  publishReconcile,
  ReconcilePublicationStaleError,
} from "./reconcile-publisher.js";

export interface ReconcileWorkerDependencies {
  prepareReconcileFiles?: typeof prepareReconcileFiles;
  publishReconcile?: typeof publishReconcile;
}

export class ReconcileWorker {
  private pendingDrain: Promise<void> | null = null;
  private readonly queuedEpochs = new Map<string, number>();
  private readonly prepareFiles: typeof prepareReconcileFiles;
  private readonly publish: typeof publishReconcile;

  constructor(
    private readonly queue: ReconcileQueue,
    deps: ReconcileWorkerDependencies = {},
  ) {
    this.prepareFiles = deps.prepareReconcileFiles ?? prepareReconcileFiles;
    this.publish = deps.publishReconcile ?? publishReconcile;
  }

  enqueue(
    repoId: string,
    frontier: DependencyFrontier,
    enqueuedAt = new Date().toISOString(),
    inputs: Readonly<Record<string, ReconcileInput>> = {},
  ): boolean {
    const epoch = captureActiveRepoEpoch(repoId);
    if (epoch === undefined) return false;
    this.queuedEpochs.set(repoId, epoch);
    const retained = this.queue.enqueue(repoId, frontier, enqueuedAt, inputs);
    this.ensureDraining();
    return retained;
  }

  invalidateSourceContext(repoId: string): void {
    this.queue.invalidateSourceContext(repoId);
    this.ensureDraining();
  }

  wake(repoId: string): void {
    this.queue.wake(repoId);
    this.ensureDraining();
  }

  private ensureDraining(): void {
    if (this.pendingDrain) return;
    this.pendingDrain = this.drain().finally(() => {
      this.pendingDrain = null;
      if (this.queue.peekNext()) this.ensureDraining();
    });
  }

  /** Lifecycle callers drain actual provider/native settlement, never a timer race. */
  async waitForIdle(): Promise<void> {
    while (this.pendingDrain) await this.pendingDrain;
  }

  clearRepo(repoId: string): void {
    this.queue.clearRepo(repoId);
    this.queuedEpochs.delete(repoId);
  }

  private async reconcile(claim: ReconcileClaim, epoch: number): Promise<void> {
    const sourceGeneration = this.queue.getSourceGeneration(claim.repoId);
    const conn = await getLadybugConn();
    const repo = await db.getRepo(conn, claim.repoId);
    if (!repo) throw new Error("Reconciliation repository is unavailable");
    const appConfig = loadConfig();
    const repoConfig = RepoConfigSchema.parse(JSON.parse(repo.configJson));
    const configurationHash = hashValue({ appConfig, repoConfig });
    const current = () => {
      if (
        !this.queue.isCurrent(claim) ||
        this.queue.getSourceGeneration(claim.repoId) !== sourceGeneration ||
        captureActiveRepoEpoch(claim.repoId) !== epoch
      )
        return false;
      try {
        return (
          hashValue({ appConfig: loadConfig(), repoConfig }) ===
          configurationHash
        );
      } catch {
        // Changed malformed configuration invalidates this result. Fresh preparation
        // reports and retains the configuration error without masking ownership loss.
        return false;
      }
    };
    const assertCurrent = () => {
      if (!current())
        throw new ReconcilePublicationStaleError(
          "Reconciliation source/configuration ownership changed",
        );
    };
    let capturedDependencies:
      | Awaited<ReturnType<typeof captureReconcileDependencyInputs>>
      | undefined;
    try {
      const baseline = await captureReconcileGraphBaseline(claim.repoId);
      const files: ReconcileSourceSnapshot[] = [];
      const removedPaths: string[] = [];
      for (const file of claim.files) {
        if (file.input.kind === "removed") {
          const exists = await lstat(
            getAbsolutePathFromRepoRoot(repo.rootPath, file.filePath),
          ).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false;
              throw error;
            },
          );
          if (exists)
            throw new Error(
              `Reconciliation removal was superseded on disk: ${file.filePath}`,
            );
          removedPaths.push(file.filePath);
          continue;
        }
        const disk = await readRepositoryFileBounded(
          repo.rootPath,
          file.filePath,
          repoConfig.maxFileBytes,
        );
        if (disk.kind !== "ok")
          throw new Error(
            `Reconciliation source unavailable (${disk.kind}): ${file.filePath}`,
          );
        const content = disk.content.toString("utf8");
        if (
          file.input.kind === "saved" &&
          hashContent(content) !== file.input.sourceHash
        )
          throw new Error(
            `Saved reconciliation source no longer matches disk: ${file.filePath}`,
          );
        files.push({
          path: file.filePath,
          content,
          contentHash: hashContent(content),
          size: disk.content.length,
        });
      }
      assertCurrent();
      const dependencyInputs = await captureReconcileDependencyInputs(
        repo.rootPath,
        repoConfig,
        files.map((file) => file.path),
      );
      capturedDependencies = dependencyInputs;
      const preparation = files.length
        ? await this.prepareFiles({
            repoId: claim.repoId,
            repoRoot: repo.rootPath,
            repoConfig,
            appConfig,
            files,
            dependencyInputs,
            assertCurrent,
          })
        : undefined;
      // Successful providers can still finish after a newer accepted save.
      assertCurrent();
      const prepared = await prepareReconcilePublication({
        repoId: claim.repoId,
        repoRoot: repo.rootPath,
        epoch,
        baseline,
        queue: this.queue,
        claim,
        preparation,
        removedPaths,
        assertCurrent: async () => {
          if (!current()) return false;
          const latestRepo = await db.getRepo(conn, claim.repoId);
          const latestInputs = await captureReconcileDependencyInputs(
            repo.rootPath,
            repoConfig,
            files.map((file) => file.path),
          );
          return (
            hashValue(latestInputs) === hashValue(dependencyInputs) &&
            latestRepo?.rootPath === repo.rootPath &&
            latestRepo.configJson === repo.configJson &&
            current()
          );
        },
      });
      const outcome = await this.publish(prepared);
      if (outcome.kind === "stale") {
        this.queue.retry(claim);
        return;
      }
      this.queue.complete(claim, new Date().toISOString());
      // Canonical no-op has no frontier: dependency cycles converge naturally.
      if (outcome.kind === "published")
        this.enqueue(claim.repoId, outcome.frontier);
    } catch (error) {
      if (error instanceof ReconcilePublicationStaleError || !current()) {
        this.queue.retry(claim);
        return;
      }
      const dependenciesChanged =
        capturedDependencies !== undefined &&
        hashValue(
          await captureReconcileDependencyInputs(
            repo.rootPath,
            repoConfig,
            claim.files
              .filter((file) => file.input.kind !== "removed")
              .map((file) => file.filePath),
          ),
        ) !== hashValue(capturedDependencies);
      if (dependenciesChanged) this.queue.retry(claim);
      else throw error;
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      // ponytail: one file bounds replacement; batch if provider startup dominates backlog latency.
      const claim = this.queue.claimNext(1);
      if (!claim) return;
      try {
        if (claim.inventoryNeeded)
          throw new Error(
            "Reconcile queue requires repository inventory recovery",
          );
        const epoch = this.queuedEpochs.get(claim.repoId);
        if (epoch === undefined) {
          this.queue.clearRepo(claim.repoId);
          continue;
        }
        if (!claim.files.length) {
          // Publication retains derived dirtiness; broad jobs are explicit maintenance.
          this.queue.complete(claim, new Date().toISOString());
          continue;
        }
        await withRepoMutation(
          claim.repoId,
          () => this.reconcile(claim, epoch),
          { expectedEpoch: epoch },
        );
      } catch (error) {
        if ((error as { code?: string }).code === "NOT_FOUND")
          this.clearRepo(claim.repoId);
        else {
          const message =
            error instanceof Error ? error.message : String(error);
          this.queue.fail(claim, new Date().toISOString(), message);
          logger.warn("Background reconciliation retained blocked work", {
            repoId: claim.repoId,
            error: message,
          });
        }
      }
    }
  }
}
