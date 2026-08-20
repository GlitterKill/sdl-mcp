import { closeLadybugDb } from "../db/ladybug.js";
import { shutdownDerivedRefreshQueue } from "../indexer/derived-refresh-queue.js";
import { waitForToolDispatchIdle } from "../mcp/dispatch-limiter.js";
import { waitForIndexingIdle } from "../mcp/indexing-gate.js";

const DEFAULT_DISPATCH_DRAIN_TIMEOUT_MS = 50_000;

export interface GracefulDatabaseShutdownOptions {
  dispatchTimeoutMs?: number;
  pollMs?: number;
}

/** Stop deferred writers and wait for accepted foreground work to finish. */
export async function drainLadybugWork(
  options: GracefulDatabaseShutdownOptions = {},
): Promise<void> {
  const dispatchTimeoutMs =
    options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_DRAIN_TIMEOUT_MS;
  await shutdownDerivedRefreshQueue(dispatchTimeoutMs);
  const idle = await waitForToolDispatchIdle({
    activeAllowance: 0,
    timeoutMs: dispatchTimeoutMs,
    pollMs: options.pollMs,
    label: "LadybugDB graceful shutdown",
  });
  if (!idle) {
    throw new Error(
      `Timed out after ${dispatchTimeoutMs}ms waiting for tool dispatch before LadybugDB close`,
    );
  }
  const indexingIdle = await waitForIndexingIdle({
    timeoutMs: dispatchTimeoutMs,
    pollMs: options.pollMs,
  });
  if (!indexingIdle) {
    throw new Error(
      "Timed out after " +
        dispatchTimeoutMs +
        "ms waiting for indexing before LadybugDB close",
    );
  }
}

/** Drain accepted work before closing LadybugDB connections. */
export async function closeLadybugDbAfterDrainingWork(
  options: GracefulDatabaseShutdownOptions = {},
): Promise<void> {
  await drainLadybugWork(options);
  await closeLadybugDb();
}
