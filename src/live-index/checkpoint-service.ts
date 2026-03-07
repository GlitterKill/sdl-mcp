import { patchSavedFile } from "./file-patcher.js";
import { OverlayStore, type DraftOverlayEntry } from "./overlay-store.js";
import type { CheckpointRequest, CheckpointResult } from "./types.js";

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
  private checkpointCounter = 0;

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
      const candidates = this.overlayStore.listCheckpointCandidates(input.repoId, {
        filePaths: options.filePaths,
      });

      let checkpointedFiles = 0;
      let failedFiles = 0;
      let lastCheckpointAt: string | null = null;
      const errors: string[] = [];

      for (const draft of candidates) {
        try {
          if (!options.skipDurablePatch) {
            await this.patchDraft(input.repoId, draft);
          }

          const checkpointedAt = this.now();
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
