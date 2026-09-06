import { normalizePath } from "../util/paths.js";
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

export type ReconcileInput =
  | { kind: "saved"; content: string; sourceHash: string }
  | { kind: "disk-change" }
  | { kind: "removed" };
export type ReconcileOutcome = "success" | "blocked" | "transient";
export interface ReconcileFile {
  readonly filePath: string;
  readonly generation: number;
  readonly input: Readonly<ReconcileInput>;
}
export interface ReconcileClaim {
  readonly repoId: string;
  readonly frontier: DependencyFrontier;
  readonly files: readonly ReconcileFile[];
  readonly enqueuedAt: string | null;
  readonly inventoryNeeded: boolean;
  readonly inventoryGeneration: number;
}
type FileState = ReconcileFile & {
  pending: boolean;
  blocked: Exclude<ReconcileOutcome, "success"> | null;
};
type RepoQueueState = {
  files: Map<string, FileState>;
  touchedSymbolIds: Set<string>;
  invalidations: Set<"metrics" | "clusters" | "processes">;
  enqueuedAt: string | null;
  lastSuccessfulReconcileAt: string | null;
  lastFailedReconcileAt: string | null;
  lastError: string | null;
  claimed: {
    work: ReconcileClaim;
    settled: Set<string>;
    failed: boolean;
  } | null;
  metadataBlocked: boolean;
  inventoryNeeded: boolean;
  inventoryBlocked: boolean;
  inventoryGeneration: number;
};
const MAX_QUEUE_ENTRIES = 10_000;

export class ReconcileQueue {
  private readonly repos = new Map<string, RepoQueueState>();
  // Survives repository/file retirement so delayed results cannot match reopened work.
  private generation = 0;

  /**
   * Returns false if an overflowing saved snapshot was not retained: callers
   * must not acknowledge that save as pending unless its content is durable.
   * Disk events remain recoverable through the coalesced inventory marker.
   */
  enqueue(
    repoId: string,
    frontier: DependencyFrontier,
    enqueuedAt: string,
    inputs: Readonly<Record<string, ReconcileInput>> = {},
  ): boolean {
    const state = this.getRepo(repoId);
    let savedSnapshotsRetained = true;
    const normalizedInputs = new Map(
      Object.entries(inputs).map(([filePath, input]) => [
        normalizePath(filePath),
        input,
      ]),
    );
    const paths = new Set([
      ...frontier.dependentFilePaths.map(normalizePath),
      ...frontier.importedFilePaths.map(normalizePath),
      ...normalizedInputs.keys(),
    ]);
    for (const filePath of paths) {
      const existing = state.files.get(filePath);
      const supplied = normalizedInputs.get(filePath);
      if (
        supplied?.kind === "saved" &&
        existing?.input.kind === "saved" &&
        supplied.sourceHash === existing.input.sourceHash
      )
        continue;
      if (!existing && state.files.size >= MAX_QUEUE_ENTRIES) {
        if (supplied?.kind === "saved") savedSnapshotsRetained = false;
        this.requireInventory(state);
        continue;
      }
      // A dependency frontier forces new preparation even when source is unchanged.
      state.files.set(filePath, {
        filePath,
        generation: ++this.generation,
        input: { ...(supplied ?? existing?.input ?? { kind: "disk-change" }) },
        pending: true,
        blocked: null,
      });
    }
    for (const symbolId of frontier.touchedSymbolIds) {
      if (state.touchedSymbolIds.size < MAX_QUEUE_ENTRIES)
        state.touchedSymbolIds.add(symbolId);
      else this.requireInventory(state);
    }
    for (const invalidation of frontier.invalidations)
      state.invalidations.add(invalidation);
    if (frontier.touchedSymbolIds.length || frontier.invalidations.length)
      state.metadataBlocked = false;
    if (!state.enqueuedAt || enqueuedAt < state.enqueuedAt)
      state.enqueuedAt = enqueuedAt;
    return savedSnapshotsRetained;
  }

  claimNext(): ReconcileClaim | null {
    const next = [...this.repos.entries()]
      .filter(([, state]) => this.ready(state))
      .sort((a, b) =>
        (a[1].enqueuedAt ?? "").localeCompare(b[1].enqueuedAt ?? ""),
      )[0];
    if (!next) return null;
    const [repoId, state] = next;
    const files = [...state.files.values()]
      .filter((file) => file.pending && !file.blocked)
      .sort((a, b) => a.filePath.localeCompare(b.filePath))
      .map(({ filePath, generation, input }) => ({
        filePath,
        generation,
        input,
      }));
    const work: ReconcileClaim = {
      repoId,
      files,
      frontier: {
        touchedSymbolIds: state.metadataBlocked
          ? []
          : [...state.touchedSymbolIds].sort(),
        dependentSymbolIds: [],
        dependentFilePaths: files.map((file) => file.filePath),
        importedFilePaths: [],
        invalidations: state.metadataBlocked
          ? []
          : [...state.invalidations].sort(),
      },
      enqueuedAt: state.enqueuedAt,
      inventoryNeeded: state.inventoryNeeded && !state.inventoryBlocked,
      inventoryGeneration: state.inventoryGeneration,
    };
    for (const file of files) state.files.get(file.filePath)!.pending = false;
    if (!state.metadataBlocked) {
      state.touchedSymbolIds.clear();
      state.invalidations.clear();
    }
    if (work.inventoryNeeded) state.inventoryNeeded = false;
    state.claimed = { work, settled: new Set(), failed: false };
    return work;
  }

  /** Validate every captured dependency immediately before publishing prepared work. */
  isCurrent(claim: ReconcileClaim): boolean {
    const state = this.repos.get(claim.repoId);
    return (
      state?.claimed?.work === claim &&
      state.inventoryGeneration === claim.inventoryGeneration &&
      claim.files.every(
        (file) =>
          state.files.get(file.filePath)?.generation === file.generation,
      )
    );
  }

  /** Record a file outcome without releasing the batch or acknowledging its siblings. */
  settleFile(
    claim: ReconcileClaim,
    filePath: string,
    outcome: ReconcileOutcome,
    error?: string,
  ): void {
    const state = this.repos.get(claim.repoId);
    const active = state?.claimed;
    const path = normalizePath(filePath);
    if (!state || active?.work !== claim || active.settled.has(path)) return;
    const owned = claim.files.find((file) => file.filePath === path);
    if (!owned) return;
    this.settleOwned(state, owned, this.isCurrent(claim), outcome, error);
  }

  complete(claim: ReconcileClaim, completedAt: string): void {
    this.finish(claim, completedAt, "success");
  }

  fail(
    claim: ReconcileClaim,
    failedAt: string,
    error: string,
    outcome: "blocked" | "transient" = "blocked",
  ): void {
    this.finish(claim, failedAt, outcome, error);
  }

  /** Explicit event-driven retry after a prerequisite changes; never wakes inflight work. */
  wake(repoId: string, filePath?: string): void {
    const state = this.repos.get(repoId);
    if (!state || state.claimed) return;
    const path = filePath === undefined ? undefined : normalizePath(filePath);
    for (const file of state.files.values()) {
      if (path === undefined || file.filePath === path) file.blocked = null;
    }
    if (path === undefined) {
      state.inventoryBlocked = false;
      state.metadataBlocked = false;
    }
  }

  getStatus(repoId: string): ReconcileQueueStatus {
    const state = this.getRepo(repoId);
    return {
      repoId,
      queueDepth:
        [...state.files.values()].filter((file) => file.pending).length +
        state.touchedSymbolIds.size +
        state.invalidations.size +
        Number(state.inventoryNeeded),
      oldestQueuedAt: state.enqueuedAt,
      lastSuccessfulReconcileAt: state.lastSuccessfulReconcileAt,
      lastFailedReconcileAt: state.lastFailedReconcileAt,
      lastError: state.lastError,
      inflight: state.claimed !== null,
    };
  }

  peekNext(): boolean {
    return [...this.repos.values()].some((state) => this.ready(state));
  }

  clear(): void {
    this.repos.clear();
  }
  clearRepo(repoId: string): void {
    this.repos.delete(repoId);
  }

  private finish(
    claim: ReconcileClaim,
    at: string,
    outcome: ReconcileOutcome,
    error?: string,
  ): void {
    const state = this.repos.get(claim.repoId);
    if (!state || state.claimed?.work !== claim) return;
    const current = this.isCurrent(claim);
    for (const file of claim.files)
      this.settleOwned(state, file, current, outcome, error);
    const failed = state.claimed.failed || (current && outcome !== "success");
    if (!current || failed) {
      for (const id of claim.frontier.touchedSymbolIds) {
        if (state.touchedSymbolIds.size < MAX_QUEUE_ENTRIES)
          state.touchedSymbolIds.add(id);
        else this.requireInventory(state);
      }
      for (const invalidation of claim.frontier.invalidations)
        state.invalidations.add(invalidation);
      state.metadataBlocked = current && failed;
      if (claim.inventoryNeeded) {
        state.inventoryNeeded = true;
        state.inventoryBlocked = current && failed;
      }
    }
    if (failed) {
      state.lastFailedReconcileAt = at;
      if (error) state.lastError = error;
    } else if (current) {
      state.lastSuccessfulReconcileAt = at;
      // Unrelated successful siblings do not erase a retained failure.
      if (
        !state.metadataBlocked &&
        !state.inventoryBlocked &&
        ![...state.files.values()].some((file) => file.blocked)
      )
        state.lastError = null;
    }
    state.claimed = null;
    // Keep source/generation only while pending or while results are outstanding.
    for (const [path, file] of state.files)
      if (!file.pending) state.files.delete(path);
    if (
      !state.files.size &&
      !state.touchedSymbolIds.size &&
      !state.invalidations.size &&
      !state.inventoryNeeded
    )
      state.enqueuedAt = null;
  }

  private ready(state: RepoQueueState): boolean {
    return (
      !state.claimed &&
      ([...state.files.values()].some(
        (file) => file.pending && !file.blocked,
      ) ||
        (!state.metadataBlocked &&
          (state.touchedSymbolIds.size > 0 || state.invalidations.size > 0)) ||
        (state.inventoryNeeded && !state.inventoryBlocked))
    );
  }

  private settleOwned(
    state: RepoQueueState,
    owned: ReconcileFile,
    current: boolean,
    outcome: ReconcileOutcome,
    error?: string,
  ): void {
    const active = state.claimed!;
    if (active.settled.has(owned.filePath)) return;
    active.settled.add(owned.filePath);
    const file = state.files.get(owned.filePath);
    if (file?.generation !== owned.generation) return;
    if (!current) file.pending = true;
    else if (outcome !== "success") {
      file.pending = true;
      file.blocked = outcome;
      active.failed = true;
      state.lastError = error ?? outcome;
    }
  }

  private requireInventory(state: RepoQueueState): void {
    state.inventoryNeeded = true;
    state.inventoryBlocked = false;
    state.inventoryGeneration = ++this.generation;
  }

  private getRepo(repoId: string): RepoQueueState {
    let state = this.repos.get(repoId);
    if (!state) {
      state = {
        files: new Map(),
        touchedSymbolIds: new Set(),
        invalidations: new Set(),
        enqueuedAt: null,
        lastSuccessfulReconcileAt: null,
        lastFailedReconcileAt: null,
        lastError: null,
        claimed: null,
        metadataBlocked: false,
        inventoryNeeded: false,
        inventoryBlocked: false,
        inventoryGeneration: 0,
      };
      this.repos.set(repoId, state);
    }
    return state;
  }
}
