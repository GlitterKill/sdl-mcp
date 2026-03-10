import { ConcurrencyLimiter } from "../util/concurrency.js";

let limiter: ConcurrencyLimiter | null = null;

/**
 * Get the singleton tool dispatch limiter.
 * Controls how many tool handler calls can execute concurrently
 * across all MCP sessions, preventing DB overload.
 */
export function getToolDispatchLimiter(): ConcurrencyLimiter {
  if (!limiter) {
    limiter = new ConcurrencyLimiter({
      maxConcurrency: 8,
      queueTimeoutMs: 30_000,
    });
  }
  return limiter;
}

/**
 * Configure the tool dispatch limiter.
 * Must be called before first tool invocation for settings to take effect.
 */
export function configureToolDispatchLimiter(opts: {
  maxConcurrency?: number;
  queueTimeoutMs?: number;
}): void {
  // Drain queued tasks from old limiter before replacing
  if (limiter) {
    limiter.clearQueue(
      new Error("Tool dispatch limiter reconfigured — queued tasks rejected"),
    );
  }
  limiter = new ConcurrencyLimiter({
    maxConcurrency: opts.maxConcurrency ?? 8,
    queueTimeoutMs: opts.queueTimeoutMs ?? 30_000,
  });
}

/**
 * Reset the limiter (for testing).
 */
export function resetToolDispatchLimiter(): void {
  if (limiter) {
    limiter.clearQueue();
  }
  limiter = null;
}
