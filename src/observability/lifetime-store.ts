import {
  acquireLifetimeLease,
  refreshLifetimeLease,
  releaseLifetimeLease,
  type LifetimeWriterLease,
} from "./lifetime-lock.js";
import {
  loadLifetimeGenerationReadOnly,
  publishLifetimeGeneration,
  recoverLifetimeGeneration,
} from "./lifetime-publication.js";
import {
  parseDurableLifetimeRoot,
  type DurableLifetimeRoot,
  type RecoveryReason,
} from "./lifetime-types.js";
import type { LifetimeFileSystemOverrides } from "./lifetime-evidence.js";

export type LifetimeFs = LifetimeFileSystemOverrides;
export type PublishOutcome = Awaited<ReturnType<typeof publishLifetimeGeneration>>;

interface LoadedStoreState {
  readonly root: DurableLifetimeRoot | null;
  readonly generation: number | null;
}

export type StoreState =
  | ({ readonly mode: "writer" } & LoadedStoreState)
  | ({ readonly mode: "readOnly" } & LoadedStoreState)
  | ({ readonly mode: "degraded" } & LoadedStoreState)
  | ({
      readonly mode: "recoveryRequired";
      readonly reason: RecoveryReason;
    } & LoadedStoreState);

export interface LifetimeStore {
  state(): StoreState;
  checkpoint(snapshot: DurableLifetimeRoot): Promise<PublishOutcome>;
  reset(snapshot: DurableLifetimeRoot): Promise<PublishOutcome>;
  refreshReadOnly(): Promise<void>;
  close(finalSnapshot?: DurableLifetimeRoot): Promise<void>;
}

interface CapturedSnapshot {
  readonly status: "valid";
  readonly root: DurableLifetimeRoot;
  readonly content: string;
}

interface CapturedInvalidSnapshot {
  readonly status: "invalid";
  readonly outcome: PublishOutcome;
}

type CapturedPublication = CapturedSnapshot | CapturedInvalidSnapshot;

interface OpenLifetimeStoreOptions {
  readonly directory: string;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly pidExists?: (pid: number) => boolean;
  readonly fs?: LifetimeFs;
}

function captureSnapshot(snapshot: DurableLifetimeRoot): CapturedPublication {
  try {
    const root = parseDurableLifetimeRoot(snapshot);
    return { status: "valid", root, content: JSON.stringify(root) };
  } catch {
    return {
      status: "invalid",
      outcome: { status: "notPublished", reason: "invalidGeneration" },
    };
  }
}

function loadedState(
  mode: "writer" | "readOnly" | "degraded",
  root: DurableLifetimeRoot | null,
  generation: number | null,
): StoreState {
  return { mode, root, generation };
}

function recoveryState(
  root: DurableLifetimeRoot | null,
  generation: number | null,
  reason: RecoveryReason,
): StoreState {
  return { mode: "recoveryRequired", root, generation, reason };
}

function copyState(state: StoreState): StoreState {
  const root = state.root === null ? null : parseDurableLifetimeRoot(state.root);
  return state.mode === "recoveryRequired"
    ? recoveryState(root, state.generation, state.reason)
    : loadedState(state.mode, root, state.generation);
}

/** Open once, then coordinate every persistence operation through one promise tail. */
export async function openLifetimeStore(
  options: OpenLifetimeStoreOptions,
): Promise<LifetimeStore> {
  const publicationOptions = { fileSystem: options.fs, now: options.now };
  const leaseResult = await acquireLifetimeLease(options.directory, {
    now: options.now,
    pid: options.pid,
    isPidAlive: options.pidExists,
    fileSystem: options.fs,
  });
  const lease: LifetimeWriterLease | null = leaseResult.mode === "writer"
    ? leaseResult.lease
    : null;
  const startup = lease
    ? await recoverLifetimeGeneration(options.directory, publicationOptions)
    : await loadLifetimeGenerationReadOnly(options.directory, { fileSystem: options.fs });

  let currentState: StoreState;
  if (startup.status === "ready") {
    currentState = loadedState(
      lease ? "writer" : "readOnly",
      parseDurableLifetimeRoot(startup.root),
      startup.generation,
    );
  } else if (startup.status === "recoveryRequired") {
    currentState = recoveryState(null, null, startup.reason);
  } else if (startup.status === "ioFailure") {
    currentState = loadedState(lease ? "degraded" : "readOnly", null, null);
  } else {
    currentState = loadedState(lease ? "writer" : "readOnly", null, null);
  }

  let committedGeneration = currentState.generation ?? -1;
  let committedContent = currentState.root === null
    ? null
    : JSON.stringify(currentState.root);
  let tail: Promise<void> = Promise.resolve();
  let closing = false;
  let closed = false;
  let leaseWritable = true;
  let closePromise: Promise<void> | null = null;

  // Both success and failure advance the tail so one rejected task cannot jam later work.
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const ensureOpen = (): void => {
    if (closing || closed) throw new Error("Lifetime store is closed");
  };

  const publish = async (capture: CapturedPublication): Promise<PublishOutcome> => {
    if (!lease) throw new Error("Lifetime store is read-only");
    if (currentState.mode === "recoveryRequired") {
      throw new Error("Lifetime store recovery required");
    }
    if (!leaseWritable) {
      currentState = loadedState("degraded", currentState.root, currentState.generation);
      return { status: "notPublished", reason: "ioFailure" };
    }
    if (capture.status === "invalid") {
      currentState = loadedState("degraded", currentState.root, currentState.generation);
      return capture.outcome;
    }
    if (capture.root.generation < committedGeneration) {
      currentState = loadedState("degraded", currentState.root, currentState.generation);
      return { status: "notPublished", reason: "staleGeneration" };
    }
    if (capture.root.generation === committedGeneration &&
        committedContent !== null && capture.content !== committedContent) {
      currentState = loadedState("degraded", currentState.root, currentState.generation);
      return { status: "notPublished", reason: "generationConflict" };
    }

    let outcome: PublishOutcome;
    try {
      outcome = await publishLifetimeGeneration(
        options.directory,
        capture.root,
        committedGeneration < 0 ? 0 : committedGeneration,
        publicationOptions,
      );
    } catch (error) {
      currentState = loadedState("degraded", currentState.root, currentState.generation);
      throw error;
    }
    if (outcome.status === "committed") {
      const root = parseDurableLifetimeRoot(outcome.root);
      committedGeneration = outcome.generation;
      committedContent = JSON.stringify(root);
      const refreshed = await refreshLifetimeLease(lease, publicationOptions).catch(() => false);
      if (!refreshed) leaseWritable = false;
      currentState = loadedState(refreshed ? "writer" : "degraded", root, outcome.generation);
    } else if (outcome.status === "notPublished") {
      currentState = loadedState("degraded", currentState.root, currentState.generation);
    } else {
      currentState = recoveryState(
        currentState.root,
        currentState.generation,
        "indeterminatePublication",
      );
    }
    return outcome;
  };

  const queuePublication = (snapshot: DurableLifetimeRoot): Promise<PublishOutcome> => {
    try {
      ensureOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    const capture = captureSnapshot(snapshot);
    return enqueue(() => publish(capture));
  };

  return {
    state(): StoreState {
      if (closed) throw new Error("Lifetime store is closed");
      return copyState(currentState);
    },

    checkpoint(snapshot: DurableLifetimeRoot): Promise<PublishOutcome> {
      return queuePublication(snapshot);
    },

    reset(snapshot: DurableLifetimeRoot): Promise<PublishOutcome> {
      return queuePublication(snapshot);
    },

    refreshReadOnly(): Promise<void> {
      try {
        ensureOpen();
      } catch (error) {
        return Promise.reject(error);
      }
      if (lease) return Promise.reject(new Error("Lifetime store is not read-only"));
      if (currentState.mode === "recoveryRequired") {
        return Promise.reject(new Error("Lifetime store recovery required"));
      }
      return enqueue(async () => {
        if (currentState.mode === "recoveryRequired") return;
        const loaded = await loadLifetimeGenerationReadOnly(
          options.directory,
          { fileSystem: options.fs },
        );
        if (loaded.status === "ready" &&
            (currentState.generation === null || loaded.generation > currentState.generation)) {
          currentState = loadedState(
            "readOnly",
            parseDurableLifetimeRoot(loaded.root),
            loaded.generation,
          );
        } else if (loaded.status === "recoveryRequired") {
          currentState = recoveryState(
            currentState.root,
            currentState.generation,
            loaded.reason,
          );
        }
      });
    },

    close(finalSnapshot?: DurableLifetimeRoot): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      const capture = finalSnapshot === undefined ? null : captureSnapshot(finalSnapshot);
      closePromise = enqueue(async () => {
        try {
          if (lease && capture && currentState.mode !== "recoveryRequired") {
            await publish(capture);
          }
        } finally {
          if (lease) {
            await releaseLifetimeLease(lease, { fileSystem: options.fs }).catch(() => false);
          }
          closed = true;
        }
      });
      return closePromise;
    },
  };
}
