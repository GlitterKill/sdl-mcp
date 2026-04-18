/**
 * Global indexing gate — tracks whether an `indexRepo` is currently running
 * and temporarily narrows tool-dispatch concurrency while it is.
 *
 * Why this exists
 * ----------------
 * Per-connection mutexes in `ladybug-core.ts` prevent native LadybugDB
 * execution from interleaving on a single connection, but they do NOT stop
 * heavy indexing (up to `indexing.concurrency` parallel parse+write tasks)
 * from competing with tool-dispatch callers for the same read-pool
 * connections. Under sustained pressure, LadybugDB 0.15.2 has intermittently
 * crashed at the native layer (no JS exception, silent process exit).
 *
 * Mitigation: while an indexer is running, narrow the tool-dispatch limiter
 * to `INDEXING_DISPATCH_CAP` so indexing sees a quieter DB. Indexing speed is
 * unaffected — tool callers just queue behind indexing when both are hot.
 *
 * The gate is a simple reference counter (nested indexRepo calls are fine).
 * A listener callback is notified whenever the count transitions 0↔n so the
 * dispatch limiter can reshape itself.
 */

/** Max tool-dispatch concurrency while indexing is active. */
export const INDEXING_DISPATCH_CAP = 4;

let activeIndexers = 0;
let listener: ((indexing: boolean) => void) | null = null;

/**
 * Register the callback that reshapes the dispatch limiter. Called once at
 * server start — wiring lives in `dispatch-limiter.ts`.
 */
export function setIndexingStateListener(
  fn: ((indexing: boolean) => void) | null,
): void {
  listener = fn;
}

/** True while at least one indexRepo call is in flight. */
export function isIndexingActive(): boolean {
  return activeIndexers > 0;
}

export function getActiveIndexerCount(): number {
  return activeIndexers;
}

/**
 * Bracket an indexing operation. Increments the counter on entry, decrements
 * on exit. The listener is fired only on 0→1 and n→0 transitions so the
 * dispatch limiter is reshaped at most twice per indexing run.
 */
export async function withIndexingGate<T>(fn: () => Promise<T>): Promise<T> {
  const wasIdle = activeIndexers === 0;
  activeIndexers++;
  if (wasIdle && listener) {
    try {
      listener(true);
    } catch {
      // Listener must never block or fail an indexing run.
    }
  }
  try {
    return await fn();
  } finally {
    activeIndexers--;
    if (activeIndexers === 0 && listener) {
      try {
        listener(false);
      } catch {
        // Listener must never block or fail an indexing run.
      }
    }
  }
}

/** Test-only: reset internal state. */
export function resetIndexingGateForTests(): void {
  activeIndexers = 0;
  listener = null;
}
