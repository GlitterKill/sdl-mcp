import { NotFoundError } from "../domain/errors.js";

export interface RepoMutationLease {
  repoId: string;
  epoch: number;
}

export interface RepoRemovalLease extends RepoMutationLease {
  commitTombstone(): void;
  abort(): void;
}

export interface RepoRegistrationLease extends RepoMutationLease {
  commitActive(): void;
  abort(): void;
}

interface RepoLifecycleState {
  epoch: number;
  status: "active" | "registering" | "removing" | "removed";
  activeMutations: number;
  drainWaiters: Set<() => void>;
}

const repoStates = new Map<string, RepoLifecycleState>();

function getRepoState(repoId: string): RepoLifecycleState {
  let state = repoStates.get(repoId);
  if (!state) {
    state = {
      epoch: 0,
      status: "active",
      activeMutations: 0,
      drainWaiters: new Set(),
    };
    repoStates.set(repoId, state);
  }
  return state;
}

function unavailable(repoId: string): NotFoundError {
  return new NotFoundError(`Repository is not active: ${repoId}`);
}

/** Capture the epoch used to fence a later asynchronous publication. */
export function captureActiveRepoEpoch(repoId: string): number | undefined {
  const state = getRepoState(repoId);
  return state.status === "active" ? state.epoch : undefined;
}

/** True only while the repository remains active in the captured epoch. */
export function isRepoEpochCurrent(repoId: string, epoch: number): boolean {
  const state = getRepoState(repoId);
  return state.status === "active" && state.epoch === epoch;
}

/**
 * Run repository-owned mutation work under a shared lifecycle lease.
 * Removal closes admission synchronously, then waits for admitted work to drain.
 */
export async function withRepoMutation<T>(
  repoId: string,
  operation: (lease: RepoMutationLease) => Promise<T>,
  options: { expectedEpoch?: number } = {},
): Promise<T> {
  const state = getRepoState(repoId);
  if (
    state.status !== "active" ||
    (options.expectedEpoch !== undefined &&
      options.expectedEpoch !== state.epoch)
  ) {
    throw unavailable(repoId);
  }

  const lease = { repoId, epoch: state.epoch };
  state.activeMutations += 1;
  try {
    return await operation(lease);
  } finally {
    state.activeMutations -= 1;
    if (state.activeMutations === 0) {
      const waiters = Array.from(state.drainWaiters);
      state.drainWaiters.clear();
      for (const resolve of waiters) resolve();
    }
  }
}

/**
 * Stop new mutation admission immediately and wait for accepted work to drain.
 * The caller must commit the tombstone immediately after DB deletion, or abort.
 */
export async function beginRepoRemoval(
  repoId: string,
): Promise<RepoRemovalLease> {
  const state = getRepoState(repoId);
  if (state.status !== "active") throw unavailable(repoId);

  // This transition deliberately occurs before the first await.
  state.status = "removing";
  if (state.activeMutations > 0) {
    await new Promise<void>((resolve) => state.drainWaiters.add(resolve));
  }

  let settled = false;
  const settle = (status: "active" | "removed", advanceEpoch: boolean): void => {
    if (settled) return;
    settled = true;
    if (advanceEpoch) state.epoch += 1;
    state.status = status;
  };

  return {
    repoId,
    epoch: state.epoch,
    commitTombstone: () => settle("removed", true),
    abort: () => settle("active", false),
  };
}

/** Serialize registration against removal and all admitted mutations. */
export async function beginRepoRegistration(
  repoId: string,
): Promise<RepoRegistrationLease> {
  const state = getRepoState(repoId);
  if (state.status === "removing" || state.status === "registering") {
    throw unavailable(repoId);
  }

  const previousStatus = state.status;
  // Like removal, registration closes admission before the first await.
  state.status = "registering";
  if (state.activeMutations > 0) {
    await new Promise<void>((resolve) => state.drainWaiters.add(resolve));
  }

  let settled = false;
  const settle = (status: "active" | "removed", advanceEpoch: boolean): void => {
    if (settled) return;
    settled = true;
    if (advanceEpoch) state.epoch += 1;
    state.status = status;
  };

  return {
    repoId,
    epoch: state.epoch,
    commitActive: () => settle("active", true),
    abort: () => settle(previousStatus, false),
  };
}

export function resetRepoLifecycleForTests(): void {
  repoStates.clear();
}
