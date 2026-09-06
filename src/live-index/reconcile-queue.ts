import type { ReconcileRecovery } from "./reconcile-recovery.js";
import { normalizePath } from "../util/paths.js";
import { ConcurrencyLimiter } from "../util/concurrency.js";
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
  | { kind: "saved"; sourceHash: string }
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
  readonly inventoryForce: boolean;
  readonly inventoryCursor: string | null;
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
    metadataGeneration: number;
  } | null;
  metadataBlocked: boolean;
  metadataGeneration: number;
  metadataBlockedFiles: Set<string>;
  inventoryNeeded: boolean;
  inventoryBlocked: boolean;
  inventoryGeneration: number;
  inventoryForce: boolean;
  inventoryCursor: string | null;
  sourceGeneration: number;
  sourceWakePending: boolean;
};
const MAX_QUEUE_ENTRIES = 10_000;

export class ReconcileQueue {
  private readonly repos = new Map<string, RepoQueueState>();
  // Fence identity survives queue clear/removal while admitted native work drains.
  private readonly publicationFences = new Map<string, ConcurrencyLimiter>();

  withPublicationFence<T>(
    repoId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    let fence = this.publicationFences.get(repoId);
    if (!fence) {
      fence = new ConcurrencyLimiter({ maxConcurrency: 1 });
      this.publicationFences.set(repoId, fence);
    }
    return fence.run(operation);
  }
  // Survives repository/file retirement so delayed results cannot match reopened work.
  private generation = 0;

  /**
   * Returns false if an overflowing saved identity was not retained: callers
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
    let savedIdentitiesRetained = true;
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
      if (supplied) state.sourceGeneration = ++this.generation;
      if (!existing && state.files.size >= MAX_QUEUE_ENTRIES) {
        if (supplied?.kind === "saved") savedIdentitiesRetained = false;
        this.requireInventory(state);
        continue;
      }
      if (state.metadataBlockedFiles.has(filePath)) {
        state.metadataBlocked = false;
        state.metadataBlockedFiles.clear();
      }
      // A dependency frontier forces new preparation even when source is unchanged.
      const input = supplied ?? existing?.input ?? { kind: "disk-change" };
      state.files.set(filePath, {
        filePath,
        generation: ++this.generation,
        // Saved bytes are durable and read bounded during preparation; never retain caller source strings.
        input:
          input.kind === "saved"
            ? { kind: "saved", sourceHash: input.sourceHash }
            : { kind: input.kind },
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
    if (frontier.touchedSymbolIds.length || frontier.invalidations.length) {
      state.metadataGeneration = ++this.generation;
      state.metadataBlocked = false;
      state.metadataBlockedFiles.clear();
    }
    if (!state.enqueuedAt || enqueuedAt < state.enqueuedAt)
      state.enqueuedAt = enqueuedAt;
    return savedIdentitiesRetained;
  }

  claimNext(
    maxFiles = MAX_QUEUE_ENTRIES,
    canRun: (repoId: string) => boolean = () => true,
  ): ReconcileClaim | null {
    const next = [...this.repos.entries()]
      .filter(([repoId, state]) => canRun(repoId) && this.ready(state))
      .sort((a, b) =>
        (a[1].enqueuedAt ?? "").localeCompare(b[1].enqueuedAt ?? ""),
      )[0];
    if (!next) return null;
    const [repoId, state] = next;
    const files = [...state.files.values()]
      .filter((file) => file.pending && !file.blocked)
      .sort((a, b) =>
        maxFiles < MAX_QUEUE_ENTRIES
          ? a.generation - b.generation
          : a.filePath.localeCompare(b.filePath),
      )
      .slice(0, maxFiles)
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
      // Overflow must not repeatedly supersede the files that free queue capacity.
      inventoryNeeded:
        files.length === 0 && state.inventoryNeeded && !state.inventoryBlocked,
      inventoryGeneration: state.inventoryGeneration,
      inventoryForce: state.inventoryForce,
      inventoryCursor: state.inventoryCursor,
    };
    for (const file of files) state.files.get(file.filePath)!.pending = false;
    if (!state.metadataBlocked) {
      state.touchedSymbolIds.clear();
      state.invalidations.clear();
    }
    if (work.inventoryNeeded) state.inventoryNeeded = false;
    state.claimed = {
      work,
      settled: new Set(),
      failed: false,
      metadataGeneration: state.metadataGeneration,
    };
    return work;
  }

  requestInventory(repoId: string, force = false): void {
    const state = this.getRepo(repoId);
    state.inventoryForce ||= force;
    state.inventoryCursor = null;
    this.requireInventory(state);
    state.sourceWakePending = state.claimed !== null;
    this.wake(repoId);
  }

  inventoryCapacity(repoId: string): number {
    return MAX_QUEUE_ENTRIES - this.getRepo(repoId).files.size;
  }

  /** Called under the save fence after a complete, still-current inventory. */
  completeInventory(
    claim: ReconcileClaim,
    inputs: readonly { filePath: string; input: ReconcileInput }[],
    cursor?: string,
  ): void {
    if (!claim.inventoryNeeded || !this.isCurrent(claim)) return;
    this.complete(claim, new Date().toISOString());
    const state = this.getRepo(claim.repoId);
    state.inventoryForce = cursor !== undefined && claim.inventoryForce;
    if (cursor !== undefined) this.requireInventory(state);
    state.inventoryCursor = cursor ?? null;
    this.enqueue(
      claim.repoId,
      {
        touchedSymbolIds: [],
        dependentSymbolIds: [],
        dependentFilePaths: [],
        importedFilePaths: [],
        invalidations: [],
      },
      new Date().toISOString(),
      Object.fromEntries(inputs.map((item) => [item.filePath, item.input])),
    );
  }

  /** Opaque provider inputs include source/project events outside the selected file. */
  invalidateSourceContext(repoId: string): void {
    const state = this.getRepo(repoId);
    state.sourceGeneration = ++this.generation;
    state.sourceWakePending = state.claimed !== null;
    this.wake(repoId);
  }

  getSourceGeneration(repoId: string): number {
    return this.getRepo(repoId).sourceGeneration;
  }

  retry(claim: ReconcileClaim): void {
    this.fail(
      claim,
      new Date().toISOString(),
      "Reconciliation inputs changed",
      "transient",
    );
    for (const file of claim.files) this.wake(claim.repoId, file.filePath);
    if (claim.inventoryNeeded) {
      const state = this.repos.get(claim.repoId);
      if (state) state.inventoryBlocked = false;
    }
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
    if (path === undefined || state.metadataBlockedFiles.has(path)) {
      state.metadataBlocked = false;
      state.metadataBlockedFiles.clear();
    }
    for (const file of state.files.values()) {
      if (path === undefined || file.filePath === path) file.blocked = null;
    }
    if (path === undefined) {
      state.inventoryBlocked = false;
    }
  }

  /** Includes claimed, pending, and retained blocked source ownership. */
  hasFileWork(repoId: string, filePath: string): boolean {
    return this.repos.get(repoId)?.files.has(normalizePath(filePath)) ?? false;
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

  peekNext(canRun: (repoId: string) => boolean = () => true): boolean {
    return [...this.repos.entries()].some(
      ([repoId, state]) => canRun(repoId) && this.ready(state),
    );
  }

  /** Capture retained paths, including blocked work, after active claims settle. */
  snapshotPending(): ReconcileRecovery {
    return {
      version: 1,
      repos: [...this.repos].flatMap(([repoId, state]) => {
        if (state.claimed) throw new Error("Cannot checkpoint unsettled reconciliation");
        const filePaths = [...state.files.keys()];
        if (!filePaths.length && !state.inventoryNeeded &&
            !state.touchedSymbolIds.size && !state.invalidations.size) return [];
        return [{
          repoId,
          filePaths,
          touchedSymbolIds: [...state.touchedSymbolIds],
          invalidations: [...state.invalidations],
          inventoryNeeded: state.inventoryNeeded,
          inventoryForce: state.inventoryForce,
        }];
      }),
    };
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
      // Only the metadata captured by this claim may inherit its failure.
      // Later metadata is independently ready and does not invalidate source work.
      if (
        (claim.frontier.touchedSymbolIds.length ||
          claim.frontier.invalidations.length) &&
        state.metadataGeneration === state.claimed.metadataGeneration
      ) {
        state.metadataBlocked = current && failed;
        state.metadataBlockedFiles.clear();
        if (state.metadataBlocked) {
          for (const file of claim.files) {
            if (state.files.get(file.filePath)?.blocked)
              state.metadataBlockedFiles.add(file.filePath);
          }
        }
      }
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
    if (state.sourceWakePending) {
      state.sourceWakePending = false;
      this.wake(claim.repoId);
    }
    // Keep source/generation only while pending or while results are outstanding.
    for (const [path, file] of state.files)
      if (!file.pending) state.files.delete(path);
    // A successful retry can free capacity needed by a retained overflow inventory.
    if (current && !failed && claim.files.length && state.inventoryNeeded)
      state.inventoryBlocked = false;
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
    // A new overflow may sort before a prior bounded scan's continuation cursor.
    state.inventoryCursor = null;
    state.inventoryNeeded = true;
    state.inventoryBlocked = false;
    state.inventoryGeneration = ++this.generation;
    state.sourceGeneration = this.generation;
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
        metadataGeneration: 0,
        metadataBlockedFiles: new Set(),
        inventoryNeeded: false,
        inventoryBlocked: false,
        inventoryGeneration: 0,
        inventoryForce: false,
        inventoryCursor: null,
        sourceGeneration: ++this.generation,
        sourceWakePending: false,
      };
      this.repos.set(repoId, state);
    }
    return state;
  }
}
