import { normalizePath } from "../util/paths.js";
import type { DraftParseResult } from "./draft-parser.js";
import type { BufferUpdateInput } from "./types.js";

export interface DraftOverlayEntry extends BufferUpdateInput {
  parseResult: DraftParseResult | null;
  parseError: string | null;
  lastParseAt: string | null;
  lastSaveAt: string | null;
  lastCheckpointAt: string | null;
}

type RepoOverlayState = Map<string, DraftOverlayEntry>;

function toStoreKey(filePath: string): string {
  return normalizePath(filePath);
}

export class OverlayStore {
  private readonly repos = new Map<string, RepoOverlayState>();
  private readonly repoVersions = new Map<string, number>();

  getSnapshotVersion(repoId: string): number {
    return this.repoVersions.get(repoId) ?? 0;
  }

  private bumpVersion(repoId: string): void {
    this.repoVersions.set(repoId, (this.repoVersions.get(repoId) ?? 0) + 1);
  }

  listRepoIds(): string[] {
    return Array.from(this.repos.keys()).sort();
  }

  upsertDraft(update: BufferUpdateInput): DraftOverlayEntry {
    const repo = this.getRepo(update.repoId);
    const key = toStoreKey(update.filePath);
    const existing = repo.get(key);

    if (existing && update.version <= existing.version) {
      return existing;
    }

    const entry: DraftOverlayEntry = {
      ...existing,
      ...update,
      filePath: key,
      parseResult: existing?.parseResult ?? null,
      parseError: existing?.parseError ?? null,
      lastParseAt: existing?.lastParseAt ?? null,
      lastSaveAt:
        update.eventType === "save"
          ? update.timestamp
          : (existing?.lastSaveAt ?? null),
      lastCheckpointAt: existing?.lastCheckpointAt ?? null,
    };

    repo.set(key, entry);
    this.bumpVersion(update.repoId);
    return entry;
  }

  setParseResult(
    repoId: string,
    filePath: string,
    version: number,
    parseResult: DraftParseResult,
    parsedAt: string,
  ): DraftOverlayEntry | null {
    const entry = this.getDraft(repoId, filePath);
    if (!entry || entry.version !== version) {
      return null;
    }

    const updated: DraftOverlayEntry = {
      ...entry,
      parseResult,
      parseError: null,
      lastParseAt: parsedAt,
    };
    // Re-check version right before writing to guard against concurrent upsertDraft
    const repo = this.getRepo(repoId);
    const key = toStoreKey(filePath);
    const currentEntry = repo.get(key);
    if (!currentEntry || currentEntry.version !== version) {
      return null; // Version changed since we started; abort
    }
    repo.set(key, updated);
    this.bumpVersion(repoId);
    return updated;
  }

  setParseFailure(
    repoId: string,
    filePath: string,
    version: number,
    parseError: string,
    parsedAt: string,
  ): DraftOverlayEntry | null {
    const entry = this.getDraft(repoId, filePath);
    if (!entry || entry.version !== version) {
      return null;
    }

    const updated: DraftOverlayEntry = {
      ...entry,
      parseError,
      lastParseAt: parsedAt,
    };
    // Re-check version right before writing to guard against concurrent upsertDraft
    const repo = this.getRepo(repoId);
    const key = toStoreKey(filePath);
    const currentEntry = repo.get(key);
    if (!currentEntry || currentEntry.version !== version) {
      return null; // Version changed since we started; abort
    }
    repo.set(key, updated);
    this.bumpVersion(repoId);
    return updated;
  }

  getDraft(repoId: string, filePath: string): DraftOverlayEntry | null {
    return this.repos.get(repoId)?.get(toStoreKey(filePath)) ?? null;
  }

  listDrafts(repoId: string): DraftOverlayEntry[] {
    return Array.from(this.repos.get(repoId)?.values() ?? []).sort((a, b) =>
      a.filePath.localeCompare(b.filePath),
    );
  }

  listDirtyFiles(repoId: string): string[] {
    return this.listDrafts(repoId)
      .filter((entry) => entry.dirty)
      .map((entry) => entry.filePath);
  }

  listCheckpointCandidates(
    repoId: string,
    options?: { filePaths?: string[] },
  ): DraftOverlayEntry[] {
    const allowed = options?.filePaths
      ? new Set(options.filePaths.map((filePath) => toStoreKey(filePath)))
      : null;

    return this.listDrafts(repoId).filter(
      (entry) =>
        !entry.dirty &&
        (allowed === null || allowed.has(toStoreKey(entry.filePath))),
    );
  }

  markSaved(repoId: string, filePath: string, savedAt: string, expectedVersion?: number): DraftOverlayEntry | null {
    const entry = this.getDraft(repoId, filePath);
    if (!entry) {
      return null;
    }
    if (expectedVersion !== undefined && entry.version !== expectedVersion) {
      return null;
    }

    const updated: DraftOverlayEntry = {
      ...entry,
      dirty: false,
      lastSaveAt: savedAt,
    };
    this.getRepo(repoId).set(toStoreKey(filePath), updated);
    this.bumpVersion(repoId);
    return updated;
  }

  markCheckpointed(
    repoId: string,
    filePath: string,
    checkpointedAt: string,
  ): DraftOverlayEntry | null {
    const entry = this.getDraft(repoId, filePath);
    if (!entry) {
      return null;
    }

    const updated: DraftOverlayEntry = {
      ...entry,
      lastCheckpointAt: checkpointedAt,
    };
    this.getRepo(repoId).set(toStoreKey(filePath), updated);
    this.bumpVersion(repoId);
    return updated;
  }

  removeDraft(repoId: string, filePath: string): void {
    const repo = this.repos.get(repoId);
    if (!repo) {
      return;
    }

    repo.delete(toStoreKey(filePath));
    if (repo.size === 0) {
      this.repos.delete(repoId);
      this.repoVersions.delete(repoId);
    } else {
      this.bumpVersion(repoId);
    }
  }

  clearAll(): void {
    this.repos.clear();
    this.repoVersions.clear();
  }

  getRepoStats(repoId: string): {
    pendingBuffers: number;
    dirtyBuffers: number;
    lastBufferEventAt: string | null;
    lastCheckpointAt: string | null;
  } {
    const drafts = this.listDrafts(repoId);
    let lastBufferEventAt: string | null = null;
    let lastCheckpointAt: string | null = null;

    for (const entry of drafts) {
      if (!lastBufferEventAt || entry.timestamp > lastBufferEventAt) {
        lastBufferEventAt = entry.timestamp;
      }
      if (
        entry.lastCheckpointAt &&
        (!lastCheckpointAt || entry.lastCheckpointAt > lastCheckpointAt)
      ) {
        lastCheckpointAt = entry.lastCheckpointAt;
      }
    }

    return {
      pendingBuffers: drafts.length,
      dirtyBuffers: drafts.filter((entry) => entry.dirty).length,
      lastBufferEventAt,
      lastCheckpointAt,
    };
  }

  private getRepo(repoId: string): RepoOverlayState {
    const existing = this.repos.get(repoId);
    if (existing) {
      return existing;
    }

    const created: RepoOverlayState = new Map();
    this.repos.set(repoId, created);
    return created;
  }
}
