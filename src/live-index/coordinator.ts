import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { createDebouncedJobScheduler } from "./debounce.js";
import { parseDraftFile } from "./draft-parser.js";
import { CheckpointService } from "./checkpoint-service.js";
import { patchSavedFile } from "./file-patcher.js";
import { OverlayStore } from "./overlay-store.js";
import { ReconcileQueue } from "./reconcile-queue.js";
import { ReconcileWorker } from "./reconcile-worker.js";
import {
  type BufferUpdateInput,
  type BufferUpdateResult,
  type CheckpointRequest,
  type CheckpointResult,
  type LiveIndexCoordinator,
  type LiveStatus,
} from "./types.js";
import { IndexError } from "../domain/errors.js";
import { getOverlayEmbeddingCache } from "./overlay-embedding-cache.js";

export interface InMemoryLiveIndexCoordinatorOptions {
  enabled?: boolean;
  debounceMs?: number;
  maxDraftFiles?: number;
}

export class InMemoryLiveIndexCoordinator implements LiveIndexCoordinator {
  private readonly enabled: boolean;
  private readonly maxDraftFiles: number;
  private readonly overlayStore = new OverlayStore();
  private readonly checkpointService = new CheckpointService(this.overlayStore);
  private readonly reconcileQueue = new ReconcileQueue();
  private readonly reconcileWorker = new ReconcileWorker(this.reconcileQueue);
  private readonly parseScheduler;
  private readonly repoRootCache = new Map<string, string>();

  constructor(options: InMemoryLiveIndexCoordinatorOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.maxDraftFiles = options.maxDraftFiles ?? 200;
    this.parseScheduler = createDebouncedJobScheduler<BufferUpdateInput>({
      delayMs: options.debounceMs ?? 75,
      run: async (_key, payload) => {
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
    });
  }

  async pushBufferUpdate(
    input: BufferUpdateInput,
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
    if (input.eventType === "close" && !input.dirty) {
      if (existing && input.version !== existing.version) {
        warnings.push(`Close event version ${input.version} does not match draft version ${existing.version}.`);
      }
      this.overlayStore.removeDraft(input.repoId, input.filePath);
      return {
        accepted: true,
        repoId: input.repoId,
        overlayVersion: input.version,
        parseScheduled: false,
        checkpointScheduled: false,
        warnings,
      };
    }

    if (existing && input.version <= existing.version) {
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
      const prevDraft = this.overlayStore.getDraft(input.repoId, input.filePath);
      if (prevDraft?.parseResult) {
        const staleIds = prevDraft.parseResult.symbols.map((s) => s.symbolId);
        getOverlayEmbeddingCache().invalidateMany(staleIds);
      }
    }
    this.overlayStore.upsertDraft(input);
    if (input.eventType === "save" && !input.dirty) {
      const patched = await patchSavedFile({
        repoId: input.repoId,
        filePath: input.filePath,
        content: input.content,
        language: input.language,
        version: input.version,
        parseResult:
          existing?.version === input.version ? existing.parseResult : null,
      }).catch((error) => {
        warnings.push(
          `Durable patch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
      if (patched) {
        this.overlayStore.setParseResult(
          input.repoId,
          input.filePath,
          input.version,
          patched.parseResult,
          input.timestamp,
        );
        this.reconcileWorker.enqueue(
          input.repoId,
          patched.frontier,
          input.timestamp,
        );
      }
      this.overlayStore.markSaved(
        input.repoId,
        input.filePath,
        input.timestamp,
        input.version,
      );
      if (patched) {
        await this.checkpointService.checkpointRepo(
          {
            repoId: input.repoId,
            reason: "save",
          },
          {
            filePaths: [input.filePath],
            skipDurablePatch: true,
          },
        );
      }
    }
    if (input.eventType !== "close") {
      void this.parseScheduler.schedule(
        `${input.repoId}:${input.filePath}`,
        input,
      );
    }

    return {
      accepted: true,
      repoId: input.repoId,
      overlayVersion: input.version,
      parseScheduled: input.eventType !== "close",
      checkpointScheduled: input.eventType === "save" && !input.dirty,
      warnings,
    };
  }

  async checkpointRepo(input: CheckpointRequest): Promise<CheckpointResult> {
    if (!this.enabled) {
      return {
        repoId: input.repoId,
        requested: false,
        checkpointId: "ckpt-disabled",
        pendingBuffers: 0,
        checkpointedFiles: 0,
        failedFiles: 0,
        lastCheckpointAt: null,
      };
    }

    await this.parseScheduler.waitForIdle();
    await this.reconcileWorker.waitForIdle();
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

  getOverlayStore(): OverlayStore {
    return this.overlayStore;
  }

  async waitForIdle(): Promise<void> {
    await this.parseScheduler.waitForIdle();
    await this.reconcileWorker.waitForIdle();
  }

  reset(): void {
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

export function resetDefaultLiveIndexCoordinator(): void {
  defaultLiveIndexCoordinator.reset();
}
