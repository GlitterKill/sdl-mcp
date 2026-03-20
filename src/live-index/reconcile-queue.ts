import type { DependencyFrontier } from "./dependency-frontier.js";

export interface ReconcileQueueStatus {
  repoId: string;
  queueDepth: number;
  oldestQueuedAt: string | null;
  lastSuccessfulReconcileAt: string | null;
  lastFailedReconcileAt: string | null;
  lastError: string | null;
  inflight: boolean;
}

type RepoQueueState = {
  repoId: string;
  filePaths: Set<string>;
  touchedSymbolIds: Set<string>;
  invalidations: Set<"metrics" | "clusters" | "processes">;
  enqueuedAt: string | null;
  lastSuccessfulReconcileAt: string | null;
  lastFailedReconcileAt: string | null;
  lastError: string | null;
  inflight: boolean;
};

function createRepoState(repoId: string): RepoQueueState {
  return {
    repoId,
    filePaths: new Set(),
    touchedSymbolIds: new Set(),
    invalidations: new Set(),
    enqueuedAt: null,
    lastSuccessfulReconcileAt: null,
    lastFailedReconcileAt: null,
    lastError: null,
    inflight: false,
  };
}

const MAX_QUEUE_ENTRIES = 10_000;

export class ReconcileQueue {
  private readonly repos = new Map<string, RepoQueueState>();

  enqueue(repoId: string, frontier: DependencyFrontier, enqueuedAt: string): void {
    const state = this.getRepo(repoId);
    for (const filePath of frontier.dependentFilePaths) {
      if (state.filePaths.size < MAX_QUEUE_ENTRIES) {
        state.filePaths.add(filePath);
      }
    }
    for (const filePath of frontier.importedFilePaths) {
      if (state.filePaths.size < MAX_QUEUE_ENTRIES) {
        state.filePaths.add(filePath);
      }
    }
    for (const symbolId of frontier.touchedSymbolIds) {
      if (state.touchedSymbolIds.size < MAX_QUEUE_ENTRIES) {
        state.touchedSymbolIds.add(symbolId);
      }
    }
    for (const invalidation of frontier.invalidations) {
      state.invalidations.add(invalidation);
    }

    if (!state.enqueuedAt || enqueuedAt < state.enqueuedAt) {
      state.enqueuedAt = enqueuedAt;
    }
  }

  claimNext(): {
    repoId: string;
    frontier: DependencyFrontier;
    enqueuedAt: string | null;
  } | null {
    const candidates = Array.from(this.repos.values())
      .filter((state) => !state.inflight)
      .filter(
        (state) =>
          state.filePaths.size > 0 ||
          state.touchedSymbolIds.size > 0 ||
          state.invalidations.size > 0,
      )
      .sort((a, b) => (a.enqueuedAt ?? "").localeCompare(b.enqueuedAt ?? ""));

    const next = candidates[0];
    if (!next) {
      return null;
    }

    next.inflight = true;
    const frontier: DependencyFrontier = {
      touchedSymbolIds: Array.from(next.touchedSymbolIds).sort(),
      dependentSymbolIds: [],
      dependentFilePaths: Array.from(next.filePaths).sort(),
      importedFilePaths: [],
      invalidations: Array.from(next.invalidations).sort(),
    };

    next.filePaths.clear();
    next.touchedSymbolIds.clear();
    next.invalidations.clear();
    const enqueuedAt = next.enqueuedAt;
    next.enqueuedAt = null;

    return {
      repoId: next.repoId,
      frontier,
      enqueuedAt,
    };
  }

  complete(repoId: string, completedAt: string): void {
    const state = this.getRepo(repoId);
    state.inflight = false;
    state.lastSuccessfulReconcileAt = completedAt;
    state.lastError = null;
  }

  fail(repoId: string, failedAt: string, error: string): void {
    const state = this.getRepo(repoId);
    state.inflight = false;
    state.lastFailedReconcileAt = failedAt;
    state.lastError = error;
  }

  getStatus(repoId: string): ReconcileQueueStatus {
    const state = this.getRepo(repoId);
    return {
      repoId,
      queueDepth:
        state.filePaths.size +
        state.touchedSymbolIds.size +
        state.invalidations.size,
      oldestQueuedAt: state.enqueuedAt,
      lastSuccessfulReconcileAt: state.lastSuccessfulReconcileAt,
      lastFailedReconcileAt: state.lastFailedReconcileAt,
      lastError: state.lastError,
      inflight: state.inflight,
    };
  }

  /** Returns true if any repo has pending (non-inflight) work. */
  peekNext(): boolean {
    for (const state of this.repos.values()) {
      if (
        !state.inflight &&
        (state.filePaths.size > 0 ||
          state.touchedSymbolIds.size > 0 ||
          state.invalidations.size > 0)
      ) {
        return true;
      }
    }
    return false;
  }

  clear(): void {
    this.repos.clear();
  }

  private getRepo(repoId: string): RepoQueueState {
    const existing = this.repos.get(repoId);
    if (existing) {
      return existing;
    }
    const created = createRepoState(repoId);
    this.repos.set(repoId, created);
    return created;
  }
}
