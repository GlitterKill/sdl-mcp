import { realpath, lstat } from "node:fs/promises";
import { relative, dirname, resolve, isAbsolute } from "node:path";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { createDebouncedJobScheduler } from "./debounce.js";
import { parseDraftFile } from "./draft-parser.js";
import { CheckpointService } from "./checkpoint-service.js";
import { readRepositoryFileBounded } from "../indexer/provider-first/executor.js";
import { dirtyPathMatchesScipGeneratorConfig } from "../scip/scip-io-runner.js";
import { OverlayStore } from "./overlay-store.js";
import { ReconcileQueue } from "./reconcile-queue.js";
import {
  ReconcileWorker,
  type ReconcileWorkerDependencies,
} from "./reconcile-worker.js";
import { hashContent } from "../util/hashing.js";
import {
  normalizePath,
  getAbsolutePathFromRepoRoot,
  validatePathWithinRoot,
} from "../util/paths.js";
import { RepoConfigSchema } from "../config/types.js";
import {
  type BufferUpdateInput,
  type BufferUpdateResult,
  type CheckpointRequest,
  type CheckpointResult,
  type LiveIndexCoordinator,
  type LiveStatus,
  type SavedFileMutationInput,
} from "./types.js";
import { IndexError, NotFoundError } from "../domain/errors.js";
import { getOverlayEmbeddingCache } from "./overlay-embedding-cache.js";

import { logger } from "../util/logger.js";
import {
  withRepoMutation,
  captureActiveRepoEpoch,
} from "../services/repo-lifecycle.js";

interface ScheduledParse {
  input: BufferUpdateInput;
  repoEpoch: number;
}

export interface InMemoryLiveIndexCoordinatorOptions {
  enabled?: boolean;
  debounceMs?: number;
  maxDraftFiles?: number;
  sweepIntervalMs?: number;
  reconcileDependencies?: ReconcileWorkerDependencies;
}

export class InMemoryLiveIndexCoordinator implements LiveIndexCoordinator {
  private readonly enabled: boolean;
  private readonly maxDraftFiles: number;
  private readonly overlayStore = new OverlayStore();
  private readonly checkpointService = new CheckpointService(
    this.overlayStore,
    {
      publishSavedFile: (input) => this.publishCheckpoint(input),
    },
  );
  private readonly reconcileQueue = new ReconcileQueue();
  private readonly reconcileWorker: ReconcileWorker;
  private readonly parseScheduler;
  private readonly repoRootCache = new Map<string, string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepPromise: Promise<void> | null = null;
  private accepting = true;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly savedMutationOwners = new Map<string, object>();

  private static readonly DEFAULT_SWEEP_INTERVAL_MS = 30_000;
  private static readonly STALE_DIRTY_DRAFT_MS = 120_000;

  constructor(options: InMemoryLiveIndexCoordinatorOptions = {}) {
    this.reconcileWorker = new ReconcileWorker(
      this.reconcileQueue,
      options.reconcileDependencies,
    );
    this.enabled = options.enabled ?? true;
    this.maxDraftFiles = options.maxDraftFiles ?? 200;
    this.parseScheduler = createDebouncedJobScheduler<ScheduledParse>({
      delayMs: options.debounceMs ?? 75,
      run: async (_key, scheduled) => {
        const { input: payload, repoEpoch } = scheduled;
        await withRepoMutation(
          payload.repoId,
          async () => {
            const parsedAt = new Date().toISOString();
            try {
              const repoRoot = await this.loadRepoRoot(payload.repoId);

              let derivedLanguage = "";
              if (payload.filePath.endsWith(".d.ts")) {
                derivedLanguage = "typescript";
              } else {
                const ext = payload.filePath.split(".").pop();
                if (ext) {
                  derivedLanguage = ext;
                } else {
                  // Handle extensionless files
                  if (payload.content.startsWith("#!")) {
                    if (payload.content.includes("node"))
                      derivedLanguage = "javascript";
                    else if (payload.content.includes("python"))
                      derivedLanguage = "python";
                    else if (payload.content.includes("sh"))
                      derivedLanguage = "bash";
                  }
                }
              }

              const parseResult = await parseDraftFile({
                repoId: payload.repoId,
                repoRoot,
                filePath: payload.filePath,
                content: payload.content,
                languages: derivedLanguage ? [derivedLanguage] : [],
                language: payload.language,
                version: payload.version,
              });
              this.overlayStore.setParseResult(
                payload.repoId,
                payload.filePath,
                payload.version,
                parseResult,
                parsedAt,
              );
              // Invalidate embedding cache for freshly-parsed symbols so stale
              // embeddings from the previous parse version do not persist.
              getOverlayEmbeddingCache().invalidateMany(
                parseResult.symbols.map((s) => s.symbolId),
              );
            } catch (error) {
              this.overlayStore.setParseFailure(
                payload.repoId,
                payload.filePath,
                payload.version,
                error instanceof Error ? error.message : String(error),
                parsedAt,
              );
            }
          },
          { expectedEpoch: repoEpoch },
        );
      },
    });

    const sweepMs =
      options.sweepIntervalMs ??
      InMemoryLiveIndexCoordinator.DEFAULT_SWEEP_INTERVAL_MS;
    if (this.enabled && sweepMs > 0) {
      this.sweepTimer = setInterval(() => {
        if (this.sweepPromise !== null) return;
        const sweep = this.sweepOverlay()
          .catch((error) => {
            logger.warn("Live-index sweep failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            if (this.sweepPromise === sweep) this.sweepPromise = null;
          });
        this.sweepPromise = sweep;
      }, sweepMs);
      this.sweepTimer.unref();
    }
  }

  /** Disk mutation and final saved-input admission share the publisher's short fence. */
  async runSavedFileMutation<T>(
    input: SavedFileMutationInput,
    operation: (canonicalPath: string) => Promise<T>,
  ): Promise<{ value: T; pending: boolean }> {
    if (!this.accepting) throw new IndexError("Live indexing stopped");
    return this.trackOperation(
      withRepoMutation(input.repoId, async () => {
        const repo = await ladybugDb.getRepo(
          await getLadybugConn(),
          input.repoId,
        );
        if (!repo)
          throw new NotFoundError(`Repository not found: ${input.repoId}`);
        const config = RepoConfigSchema.parse(JSON.parse(repo.configJson));
        if (
          input.content !== undefined &&
          Buffer.byteLength(input.content) > config.maxFileBytes
        )
          throw new IndexError(
            "Saved reconciliation source exceeds repository file limit",
          );
        const root = await realpath(repo.rootPath);
        const lexical = getAbsolutePathFromRepoRoot(root, input.filePath);
        const canonical = await this.resolveSavedTarget(root, lexical);
        const path = normalizePath(relative(root, canonical));
        const projectInput =
          dirtyPathMatchesScipGeneratorConfig(path) ||
          [
            config.packageJsonPath,
            config.tsconfigPath,
            config.sourceFileListPath,
          ].some(
            (configured) =>
              configured &&
              normalizePath(relative(root, resolve(root, configured))) === path,
          );
        return this.reconcileQueue.withPublicationFence(
          input.repoId,
          async () => {
            if ((await this.resolveSavedTarget(root, lexical)) !== canonical)
              throw new IndexError(
                "Saved target identity changed before mutation",
              );
            if (input.expectedOwnership && !input.expectedOwnership.isCurrent())
              throw new IndexError(
                "Cannot rollback: a newer save owns the file",
              );
            const ownerKey = JSON.stringify([input.repoId, path]);
            this.savedMutationOwners.delete(ownerKey);
            if (input.captureOwnership) {
              const token = {};
              const epoch = captureActiveRepoEpoch(input.repoId);
              this.savedMutationOwners.set(ownerKey, token);
              input.captureOwnership({
                isCurrent: () =>
                  this.savedMutationOwners.get(ownerKey) === token &&
                  captureActiveRepoEpoch(input.repoId) === epoch,
                release: () => {
                  if (this.savedMutationOwners.get(ownerKey) === token)
                    this.savedMutationOwners.delete(ownerKey);
                },
              });
            }
            let value!: T;
            let failed = false;
            let failure: unknown;
            try {
              value = await operation(canonical);
            } catch (error) {
              failed = true;
              failure = error;
            }
            let pending = false;
            try {
              // Always reconcile final disk state, including partial failure and rollback.
              if (input.reconcile !== false) {
                const source = await readRepositoryFileBounded(
                  root,
                  path,
                  config.maxFileBytes,
                );
                if (source.kind === "ok") {
                  const content = source.content.toString("utf8");
                  pending = this.enqueueSavedInput(input.repoId, path, {
                    kind: "saved",
                    sourceHash: hashContent(content),
                  });
                  if (!pending) {
                    // The saved bytes remain durable; overflow inventory can recover them.
                    pending = this.enqueueSavedInput(input.repoId, path, {
                      kind: "disk-change",
                    });
                  }
                  if (input.content !== undefined && content !== input.content)
                    throw new IndexError(
                      "Saved buffer content does not match disk",
                    );
                } else {
                  const missing = await realpath(lexical).then(
                    () => false,
                    (error: NodeJS.ErrnoException) => {
                      if (error.code === "ENOENT") return true;
                      throw error;
                    },
                  );
                  pending = this.enqueueSavedInput(input.repoId, path, {
                    kind: missing ? "removed" : "disk-change",
                  });
                  if (!missing || input.content !== undefined)
                    throw new IndexError(
                      `Saved reconciliation source unavailable (${source.kind})`,
                    );
                }
              }
              if (projectInput)
                // This known managed save already invalidated its previous owner above.
                this.reconcileWorker.requestInventory(input.repoId, true);
            } catch (error) {
              // An unreadable/retargeted final source must invalidate already prepared work.
              this.invalidateSourceContext(input.repoId);
              this.enqueueSavedInput(input.repoId, path, {
                kind: "disk-change",
              });
              if (!failed) throw error;
              logger.warn(
                "Failed to capture disk state after managed write failure",
                {
                  repoId: input.repoId,
                  filePath: path,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            }
            if (failed) throw failure;
            return { value, pending };
          },
        );
      }),
    );
  }

  private async resolveSavedTarget(
    root: string,
    path: string,
  ): Promise<string> {
    try {
      const canonical = await realpath(path);
      validatePathWithinRoot(root, canonical);
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const entry = await lstat(path).catch(
        (statError: NodeJS.ErrnoException) => {
          if (statError.code === "ENOENT") return null;
          throw statError;
        },
      );
      if (entry?.isSymbolicLink())
        throw new IndexError("Dangling symlink at saved target or ancestor");
      const parent = dirname(path);
      if (parent === path) throw error;
      const canonicalParent = await this.resolveSavedTarget(root, parent);
      const canonical = resolve(canonicalParent, relative(parent, path));
      validatePathWithinRoot(root, canonical);
      return canonical;
    }
  }

  private enqueueSavedInput(
    repoId: string,
    path: string,
    input: import("./reconcile-queue.js").ReconcileInput,
  ): boolean {
    return this.reconcileWorker.enqueue(
      repoId,
      {
        touchedSymbolIds: [],
        dependentSymbolIds: [],
        dependentFilePaths: [],
        importedFilePaths: [],
        invalidations: [],
      },
      new Date().toISOString(),
      { [path]: input },
    );
  }

  /** Shared admission also operates when draft overlays are disabled. */
  async acceptSavedFile(input: {
    repoId: string;
    filePath: string;
    content: string;
  }): Promise<boolean> {
    if (!this.accepting) return false;
    return (await this.runSavedFileMutation(input, async () => undefined))
      .pending;
  }

  private async publishCheckpoint(input: {
    repoId: string;
    filePath: string;
    content: string;
  }): Promise<void> {
    await this.reconcileWorker.waitForIdle();
    // A completed ordinary save already published these bytes. Checkpoint cleanup
    // must not start the configured providers a second time merely to evict its overlay.
    if (await this.checkpointSourceCommitted(input)) return;
    if (!(await this.acceptSavedFile(input)))
      throw new IndexError("Checkpoint source was not queued");
    await this.reconcileWorker.waitForIdle();
    if (!(await this.checkpointSourceCommitted(input)))
      throw new IndexError(
        "Checkpoint reconciliation remains pending, blocked, or superseded",
      );
  }

  private async checkpointSourceCommitted(input: {
    repoId: string;
    filePath: string;
    content: string;
  }): Promise<boolean> {
    const repoRoot = await realpath(await this.loadRepoRoot(input.repoId));
    const canonical = await realpath(
      getAbsolutePathFromRepoRoot(repoRoot, input.filePath),
    );
    validatePathWithinRoot(repoRoot, canonical);
    const path = normalizePath(relative(repoRoot, canonical));
    const generation = this.reconcileQueue.getSourceGeneration(input.repoId);
    // Pool admission and DB reads occur before the save fence, just like writer admission.
    const file = await ladybugDb.getFileByRepoPath(
      await getLadybugConn(),
      input.repoId,
      path,
    );
    return this.reconcileQueue.withPublicationFence(input.repoId, async () => {
      if (this.reconcileQueue.hasFileWork(input.repoId, path)) return false;
      const disk = await readRepositoryFileBounded(
        repoRoot,
        path,
        Buffer.byteLength(input.content) + 1,
      );
      return (
        this.reconcileQueue.getSourceGeneration(input.repoId) === generation &&
        disk.kind === "ok" &&
        disk.content.toString("utf8") === input.content &&
        file?.contentHash === hashContent(input.content)
      );
    });
  }

  invalidateSourceContext(repoId: string): void {
    if (!this.accepting) return;
    this.reconcileWorker.invalidateSourceContext(repoId);
  }

  /** Watcher admission invalidates preparation immediately; disk capture stays in the worker. */
  recordDiskChange(input: {
    repoId: string;
    filePath: string;
    removed?: boolean;
  }): boolean {
    if (!this.accepting) return false;
    const path = normalizePath(input.filePath);
    if (
      !path ||
      isAbsolute(path) ||
      path.includes("\0") ||
      path.split("/").includes("..")
    )
      throw new IndexError("Watcher source must be a repository-relative path");
    this.savedMutationOwners.delete(JSON.stringify([input.repoId, path]));
    return this.enqueueSavedInput(input.repoId, path, {
      kind: input.removed ? "removed" : "disk-change",
    });
  }

  requestReconcileInventory(
    repoId: string,
    options: { force?: boolean } = {},
  ): boolean {
    if (!this.accepting) return false;
    // Ambiguous external events may hide a newer save on any active rollback target.
    const ownerPrefix = `[${JSON.stringify(repoId)},`;
    for (const key of this.savedMutationOwners.keys())
      if (key.startsWith(ownerPrefix)) this.savedMutationOwners.delete(key);
    return this.reconcileWorker.requestInventory(repoId, options.force);
  }

  setReconciliationReadiness(
    repoId: string,
    isWriteReady: () => boolean,
  ): void {
    if (this.accepting) this.reconcileWorker.setReadiness(repoId, isWriteReady);
  }

  wakeReconciliation(repoId: string): void {
    if (this.accepting) this.reconcileWorker.wake(repoId);
  }

  async pushBufferUpdate(
    input: BufferUpdateInput,
  ): Promise<BufferUpdateResult> {
    if (!this.accepting) {
      return {
        accepted: false,
        repoId: input.repoId,
        overlayVersion: input.version,
        parseScheduled: false,
        checkpointScheduled: false,
        warnings: ["Live indexing stopped."],
      };
    }
    return this.trackOperation(
      withRepoMutation(input.repoId, ({ epoch }) =>
        this.pushBufferUpdateActive(input, epoch),
      ),
    );
  }

  private async pushBufferUpdateActive(
    input: BufferUpdateInput,
    repoEpoch: number,
  ): Promise<BufferUpdateResult> {
    if (!this.enabled) {
      return {
        accepted: false,
        repoId: input.repoId,
        overlayVersion: input.version,
        parseScheduled: false,
        checkpointScheduled: false,
        warnings: ["Live indexing disabled."],
      };
    }

    const existing = this.overlayStore.getDraft(input.repoId, input.filePath);
    const warnings: string[] = [];

    // Close events are lifecycle signals — always accept them regardless of version
    if (input.eventType === "close") {
      if (existing && input.version < existing.version) {
        warnings.push(
          `Close event version ${input.version} does not match draft version ${existing.version}.`,
        );
      }
      this.overlayStore.removeDraft(input.repoId, input.filePath);

      // Closing drops the draft overlay and queues canonical disk reconciliation.
      // Recovery prepares in the background; acceptance does not claim a graph commit.
      let diskRecoveryScheduled = false;
      try {
        await this.runSavedFileMutation(
          { repoId: input.repoId, filePath: input.filePath },
          async () => undefined,
        );
        diskRecoveryScheduled = true;
        logger.debug("Queued canonical disk reconciliation on close event", {
          repoId: input.repoId,
          filePath: input.filePath,
        });
      } catch (error) {
        logger.warn("Failed to queue disk reconciliation on close event", {
          repoId: input.repoId,
          filePath: input.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return {
        accepted: true,
        repoId: input.repoId,
        overlayVersion: input.version,
        parseScheduled: diskRecoveryScheduled,
        checkpointScheduled: false,
        warnings,
      };
    }

    const matchingSave =
      input.eventType === "save" &&
      !input.dirty &&
      existing?.version === input.version &&
      existing.content === input.content;
    if (existing && input.version <= existing.version && !matchingSave) {
      warnings.push("Ignored stale buffer update.");
      return {
        accepted: false,
        repoId: input.repoId,
        overlayVersion: existing.version,
        parseScheduled: false,
        checkpointScheduled: false,
        warnings,
      };
    }

    if (
      !existing &&
      this.overlayStore.listDrafts(input.repoId).length >= this.maxDraftFiles
    ) {
      warnings.push(
        `Live index draft limit reached (${this.maxDraftFiles} files).`,
      );
      return {
        accepted: false,
        repoId: input.repoId,
        overlayVersion: input.version,
        parseScheduled: false,
        checkpointScheduled: false,
        warnings,
      };
    }

    // Invalidate overlay embedding cache for any symbols in this file's previous draft.
    {
      const prevDraft = this.overlayStore.getDraft(
        input.repoId,
        input.filePath,
      );
      if (prevDraft?.parseResult) {
        const staleIds = prevDraft.parseResult.symbols.map((s) => s.symbolId);
        getOverlayEmbeddingCache().invalidateMany(staleIds);
      }
    }
    if (input.eventType === "save" && !input.dirty) {
      try {
        if (!(await this.acceptSavedFile(input)))
          throw new IndexError("Saved source was not queued");
        this.overlayStore.upsertDraft(input);
        this.overlayStore.markSaved(
          input.repoId,
          input.filePath,
          input.timestamp,
          input.version,
        );
      } catch (error) {
        warnings.push(
          `Saved reconciliation admission failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          accepted: false,
          repoId: input.repoId,
          overlayVersion: input.version,
          parseScheduled: false,
          checkpointScheduled: false,
          warnings,
        };
      }
    }
    const draft = this.overlayStore.upsertDraft(input);
    // Saved admission can await the publisher fence while a newer unsaved draft arrives.
    if (draft.version !== input.version || draft.content !== input.content)
      return {
        accepted: true,
        repoId: input.repoId,
        overlayVersion: draft.version,
        parseScheduled: false,
        checkpointScheduled: false,
        warnings,
      };
    void this.parseScheduler
      .schedule(`${input.repoId}:${input.filePath}`, { input, repoEpoch })
      .catch((error) => {
        logger.debug("Skipped stale live-index parse job", {
          repoId: input.repoId,
          filePath: input.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return {
      accepted: true,
      repoId: input.repoId,
      overlayVersion: input.version,
      parseScheduled: true,
      checkpointScheduled: false,
      warnings,
    };
  }

  async checkpointRepo(input: CheckpointRequest): Promise<CheckpointResult> {
    if (!this.accepting) {
      return {
        repoId: input.repoId,
        requested: false,
        pending: false,
        message: "No checkpoint-eligible buffers were pending.",
      };
    }
    return this.trackOperation(
      withRepoMutation(input.repoId, () => this.checkpointRepoActive(input)),
    );
  }

  private async checkpointRepoActive(
    input: CheckpointRequest,
  ): Promise<CheckpointResult> {
    if (!this.enabled) {
      return {
        repoId: input.repoId,
        requested: false,
        pending: false,
        message: "No checkpoint-eligible buffers were pending.",
      };
    }

    // A save may already have checkpointed and removed the last draft. Only
    // skip the idle waits when no pending draft can still become eligible.
    if (this.overlayStore.listDrafts(input.repoId).length === 0) {
      return this.checkpointService.checkpointRepo(input);
    }

    await this.parseScheduler.waitForIdle();
    return this.checkpointService.checkpointRepo(input);
  }

  async getLiveStatus(repoId: string): Promise<LiveStatus> {
    const stats = this.overlayStore.getRepoStats(repoId);
    const checkpoint = this.checkpointService.getStatus(repoId);
    const reconcile = this.reconcileQueue.getStatus(repoId);
    const checkpointCandidates =
      this.overlayStore.listCheckpointCandidates(repoId).length;

    return {
      repoId,
      enabled: this.enabled,
      pendingBuffers: stats.pendingBuffers,
      dirtyBuffers: stats.dirtyBuffers,
      parseQueueDepth: this.parseScheduler.size(),
      checkpointPending: checkpointCandidates > 0,
      lastBufferEventAt: stats.lastBufferEventAt,
      lastCheckpointAt: checkpoint.lastCheckpointAt,
      lastCheckpointAttemptAt: checkpoint.lastCheckpointAttemptAt,
      lastCheckpointResult: checkpoint.lastCheckpointResult,
      lastCheckpointError: checkpoint.lastCheckpointError,
      lastCheckpointReason: checkpoint.lastCheckpointReason,
      reconcileQueueDepth: reconcile.queueDepth,
      oldestReconcileAt: reconcile.oldestQueuedAt,
      lastReconciledAt: reconcile.lastSuccessfulReconcileAt,
      reconcileInflight: reconcile.inflight,
      reconcileLastError: reconcile.lastError,
    };
  }

  async clearRepo(repoId: string): Promise<void> {
    const drafts = this.overlayStore.listDrafts(repoId);
    const staleSymbolIds = drafts.flatMap(
      (draft) =>
        draft.parseResult?.symbols.map((symbol) => symbol.symbolId) ?? [],
    );
    getOverlayEmbeddingCache().invalidateMany(staleSymbolIds);
    for (const draft of drafts) {
      this.parseScheduler.cancel(`${repoId}:${draft.filePath}`);
    }
    this.overlayStore.clearRepo(repoId);
    this.checkpointService.clearRepo(repoId);
    this.reconcileWorker.clearRepo(repoId);
    this.repoRootCache.delete(repoId);
  }

  getOverlayStore(): OverlayStore {
    return this.overlayStore;
  }

  async waitForIdle(): Promise<void> {
    await this.parseScheduler.waitForIdle();
    await this.reconcileWorker.waitForIdle();
  }

  beginShutdown(): void {
    this.accepting = false;
    this.reconcileWorker.beginShutdown();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async close(): Promise<void> {
    this.beginShutdown();
    await this.sweepPromise;
    await Promise.allSettled(this.activeOperations);
    await this.waitForIdle();
    await this.reconcileWorker.persistPending();
  }

  async recoverPending(graphDbPath: string, isWriteReady?: () => boolean): Promise<string[]> {
    return this.trackOperation(this.reconcileWorker.recoverPending(graphDbPath, isWriteReady));
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() =>
      this.activeOperations.delete(tracked),
    );
    this.activeOperations.add(tracked);
    return tracked;
  }

  private async sweepOverlay(): Promise<void> {
    const now = Date.now();
    for (const repoId of this.overlayStore.listRepoIds()) {
      try {
        await withRepoMutation(repoId, async () => {
          const drafts = this.overlayStore.listDrafts(repoId);
          if (drafts.length === 0) return;

          // Retry non-dirty drafts left behind by failed save-event patches.
          const hasNonDirty = drafts.some((draft) => !draft.dirty);
          if (hasNonDirty) {
            await this.checkpointService
              .checkpointRepo({ repoId, reason: "sweep" })
              .catch((error) => {
                logger.warn("Sweep checkpoint failed", {
                  repoId,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          }

          // Evict stale dirty drafts orphaned by editor crash or disconnect.
          for (const draft of drafts) {
            if (!draft.dirty) continue;
            const age = now - Date.parse(draft.timestamp);
            if (age < InMemoryLiveIndexCoordinator.STALE_DIRTY_DRAFT_MS) {
              continue;
            }

            logger.debug("Sweep evicting stale dirty draft", {
              repoId,
              filePath: draft.filePath,
              ageMs: age,
            });
            try {
              await this.runSavedFileMutation(
                { repoId, filePath: draft.filePath },
                async () => undefined,
              );
              const current = this.overlayStore.getDraft(
                repoId,
                draft.filePath,
              );
              if (current && current.version === draft.version) {
                this.overlayStore.removeDraft(repoId, draft.filePath);
              }
            } catch (error) {
              logger.warn("Sweep disk recovery failed", {
                repoId,
                filePath: draft.filePath,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        });
      } catch (error) {
        if (error instanceof NotFoundError) {
          logger.debug("Skipped sweep for inactive repository", { repoId });
          continue;
        }
        throw error;
      }
    }
  }

  reset(): void {
    this.savedMutationOwners.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.parseScheduler.cancelAll();
    this.overlayStore.clearAll();
    this.checkpointService.clear();
    this.reconcileQueue.clear();
    this.repoRootCache.clear();
  }

  private async loadRepoRoot(repoId: string): Promise<string> {
    const cached = this.repoRootCache.get(repoId);
    if (cached) return cached;

    const conn = await getLadybugConn();
    const repo = await ladybugDb.getRepo(conn, repoId);
    if (!repo) {
      throw new IndexError(`Repository ${repoId} not found`);
    }
    this.repoRootCache.set(repoId, repo.rootPath);
    return repo.rootPath;
  }
}

let defaultLiveIndexCoordinator = new InMemoryLiveIndexCoordinator();

export async function configureDefaultLiveIndexCoordinator(
  options: InMemoryLiveIndexCoordinatorOptions = {},
): Promise<void> {
  await defaultLiveIndexCoordinator.waitForIdle();
  defaultLiveIndexCoordinator.reset();
  defaultLiveIndexCoordinator = new InMemoryLiveIndexCoordinator(options);
}

export function getDefaultLiveIndexCoordinator(): LiveIndexCoordinator {
  return defaultLiveIndexCoordinator;
}

export function getDefaultOverlayStore(): OverlayStore {
  return defaultLiveIndexCoordinator.getOverlayStore();
}

export async function waitForDefaultLiveIndexIdle(): Promise<void> {
  await defaultLiveIndexCoordinator.waitForIdle();
}

export function beginDefaultLiveIndexShutdown(): void {
  defaultLiveIndexCoordinator.beginShutdown();
}

export async function recoverDefaultLiveIndexPending(graphDbPath: string, isWriteReady?: () => boolean): Promise<string[]> {
  return defaultLiveIndexCoordinator.recoverPending(graphDbPath, isWriteReady);
}

export async function closeDefaultLiveIndexCoordinator(): Promise<void> {
  await defaultLiveIndexCoordinator.close();
}

export function resetDefaultLiveIndexCoordinator(): void {
  defaultLiveIndexCoordinator.reset();
}
