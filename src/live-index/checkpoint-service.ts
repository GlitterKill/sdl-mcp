import { stat } from "node:fs/promises";
import { patchSavedFile } from "./file-patcher.js";
import { OverlayStore, type DraftOverlayEntry } from "./overlay-store.js";
import type { CheckpointRequest, CheckpointResult } from "./types.js";
import { getAbsolutePathFromRepoRoot } from "../util/paths.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";

export interface CheckpointStatus {
  repoId: string;
  lastCheckpointAt: string | null;
  lastCheckpointAttemptAt: string | null;
  lastCheckpointResult: "success" | "partial" | "failed" | null;
  lastCheckpointError: string | null;
  lastCheckpointReason: string | null;
}

interface CheckpointServiceOptions {
  now?: () => string;
  patchSavedFile?: typeof patchSavedFile;
}

interface CheckpointExecutionOptions {
  filePaths?: string[];
  skipDurablePatch?: boolean;
}

function createEmptyStatus(repoId: string): CheckpointStatus {
  return {
    repoId,
    lastCheckpointAt: null,
    lastCheckpointAttemptAt: null,
    lastCheckpointResult: null,
    lastCheckpointError: null,
    lastCheckpointReason: null,
  };
}

export class CheckpointService {
  private readonly now: () => string;
  private readonly patchSavedFileImpl: typeof patchSavedFile;
  private readonly statuses = new Map<string, CheckpointStatus>();
  private readonly checkpointInProgress = new Set<string>();
  private readonly repoRootCache = new Map<string, string>();
  private checkpointCounter = 0;

  /** Minimum disk file size (bytes) before content-ratio guard activates. */
  private static readonly MIN_DISK_SIZE_FOR_GUARD = 100;
  /** Draft content must be at least this fraction of disk size to proceed. */
  private static readonly MIN_CONTENT_RATIO = 0.1;

  constructor(
    private readonly overlayStore: OverlayStore,
    options: CheckpointServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.patchSavedFileImpl = options.patchSavedFile ?? patchSavedFile;
  }

  async checkpointRepo(
    input: CheckpointRequest,
    options: CheckpointExecutionOptions = {},
  ): Promise<CheckpointResult> {
    if (this.checkpointInProgress.has(input.repoId)) {
      const status = this.getStatus(input.repoId);
      return {
        repoId: input.repoId,
        requested: false,
        checkpointId: "in-progress",
        pendingBuffers: this.overlayStore.listDrafts(input.repoId).length,
        checkpointedFiles: 0,
        failedFiles: 0,
        lastCheckpointAt: status.lastCheckpointAt,
      };
    }

    this.checkpointInProgress.add(input.repoId);
    try {
      const attemptAt = this.now();
      const checkpointId = `ckpt-${Date.now()}-${this.checkpointCounter++}`;
      const candidates = this.overlayStore.listCheckpointCandidates(
        input.repoId,
        {
          filePaths: options.filePaths,
        },
      );

      let checkpointedFiles = 0;
      let failedFiles = 0;
      let lastCheckpointAt: string | null = null;
      const errors: string[] = [];

      for (const draft of candidates) {
        try {
          // Safety check: skip drafts whose content is suspiciously small
          // compared to the actual disk file. This prevents partial/garbage
          // buffer pushes from corrupting the index during idle checkpoint.
          if (!options.skipDurablePatch) {
            const skip = await this.isDraftSuspiciouslySmall(
              input.repoId,
              draft,
            );
            if (skip) {
              // Leave the draft in the overlay — do NOT remove or count it.
              // It will be re-evaluated on the next checkpoint cycle.
              // Removing it without re-indexing from disk would leave the
              // DB index stale (the exact problem this guard prevents).
              continue;
            }
            await this.patchDraft(input.repoId, draft);
          }

          const checkpointedAt = this.now();
          // Re-check dirty flag: the draft may have been dirtied by a new buffer push
          // between candidate listing and this removal
          const currentDraft = this.overlayStore.getDraft(
            input.repoId,
            draft.filePath,
          );
          if (currentDraft?.dirty) {
            continue; // Skip — a newer version arrived; do not remove
          }
          // M3 optimization: removeDraft directly, lastCheckpointAt tracked in status
          this.overlayStore.removeDraft(input.repoId, draft.filePath);
          checkpointedFiles += 1;
          lastCheckpointAt = checkpointedAt;
        } catch (error) {
          failedFiles += 1;
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }

      const result =
        failedFiles > 0
          ? checkpointedFiles > 0
            ? "partial"
            : "failed"
          : "success";
      const status = this.getMutableStatus(input.repoId);
      status.lastCheckpointAttemptAt = attemptAt;
      status.lastCheckpointResult = result;
      status.lastCheckpointError = errors[0] ?? null;
      status.lastCheckpointReason = input.reason ?? null;
      if (lastCheckpointAt) {
        status.lastCheckpointAt = lastCheckpointAt;
      }

      return {
        repoId: input.repoId,
        requested: true,
        checkpointId,
        pendingBuffers: this.overlayStore.listDrafts(input.repoId).length,
        checkpointedFiles,
        failedFiles,
        lastCheckpointAt: status.lastCheckpointAt,
      };
    } finally {
      this.checkpointInProgress.delete(input.repoId);
    }
  }

  getStatus(repoId: string): CheckpointStatus {
    const status = this.statuses.get(repoId);
    return status ? { ...status } : createEmptyStatus(repoId);
  }

  clear(): void {
    this.statuses.clear();
    this.checkpointInProgress.clear();
  }

  private async patchDraft(
    repoId: string,
    draft: DraftOverlayEntry,
  ): Promise<void> {
    await this.patchSavedFileImpl({
      repoId,
      filePath: draft.filePath,
      content: draft.content,
      language: draft.language,
      version: draft.version,
      parseResult: draft.parseError ? null : draft.parseResult,
    });
  }

  /**
   * Returns true when the draft content is likely a partial/garbage buffer
   * that would destroy the real index if checkpointed.
   *
   * Heuristic: if the disk file is > MIN_DISK_SIZE_FOR_GUARD bytes and the
   * draft content length is < MIN_CONTENT_RATIO of the disk size, the draft
   * is suspicious and should be skipped.
   */
  private async isDraftSuspiciouslySmall(
    repoId: string,
    draft: DraftOverlayEntry,
  ): Promise<boolean> {
    try {
      const repoRoot = await this.loadRepoRoot(repoId);
      if (!repoRoot) return false; // Can't validate without root

      const absPath = getAbsolutePathFromRepoRoot(repoRoot, draft.filePath);
      const diskStats = await stat(absPath);
      const diskSize = diskStats.size;

      if (diskSize <= CheckpointService.MIN_DISK_SIZE_FOR_GUARD) {
        return false; // Disk file is trivially small; no guard needed
      }

      const contentByteLength = Buffer.byteLength(draft.content, "utf-8");
      if (contentByteLength < diskSize * CheckpointService.MIN_CONTENT_RATIO) {
        logger.warn(
          "Skipping checkpoint for draft with suspiciously small content",
          {
            repoId,
            filePath: draft.filePath,
            draftBytes: contentByteLength,
            diskBytes: diskSize,
            ratio: Number((contentByteLength / diskSize).toFixed(4)),
          },
        );
        return true;
      }

      return false;
    } catch {
      // If stat fails (file deleted, permission error), allow checkpoint to proceed
      return false;
    }
  }

  private async loadRepoRoot(repoId: string): Promise<string | null> {
    const cached = this.repoRootCache.get(repoId);
    if (cached) return cached;

    try {
      const conn = await getLadybugConn();
      const repo = await ladybugDb.getRepo(conn, repoId);
      if (!repo) return null;
      this.repoRootCache.set(repoId, repo.rootPath);
      return repo.rootPath;
    } catch {
      return null;
    }
  }

  private getMutableStatus(repoId: string): CheckpointStatus {
    const existing = this.statuses.get(repoId);
    if (existing) {
      return existing;
    }

    const created = createEmptyStatus(repoId);
    this.statuses.set(repoId, created);
    return created;
  }
}
