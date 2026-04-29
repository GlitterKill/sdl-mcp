import { logger } from "../util/logger.js";
import { getObservabilityTap } from "./event-tap.js";
import { getPoolStats } from "../db/ladybug.js";
import { getActiveDrainStats } from "../indexer/parser/batch-persist.js";
import { clampInterval } from "./service.js";
import type { ObservabilityConfig } from "../config/types.js";

/**
 * Periodic runtime probes that sample DB write-pool and indexer drain-queue
 * stats and forward them through the observability tap.
 *
 * The ObservabilityService handles cpu/mem/eventLoop sampling on its own
 * tick; this module covers the pool + drain dimensions that live outside
 * the service's accounting boundary.
 *
 * Defensive contract:
 *   - All ticks are wrapped in try/catch and never throw.
 *   - Repeat calls to startRuntimeProbes() are idempotent.
 *   - timer.unref() so the host process can exit cleanly.
 */

let timer: NodeJS.Timeout | null = null;

export function startRuntimeProbes(config: ObservabilityConfig): void {
  if (!config.enabled) return;
  if (timer) return; // idempotent
  const intervalMs = clampInterval(config.sampleIntervalMs);
  timer = setInterval(() => {
    try {
      const tap = getObservabilityTap();
      if (!tap) return;
      let writeQueued = 0;
      let writeActive = 0;
      try {
        const pool = getPoolStats();
        writeQueued = pool.writeQueued;
        writeActive = pool.writeActive;
      } catch {
        // pool may not be initialized yet — skip silently
      }
      let drainQueueDepth = 0;
      let drainFailures = 0;
      try {
        const drain = getActiveDrainStats();
        drainQueueDepth = drain.queueDepth;
        drainFailures = drain.drainFailures;
      } catch {
        // ignore — drain stats are opportunistic
      }
      tap.poolSample({
        writeQueued,
        writeActive,
        drainQueueDepth,
        drainFailures,
      });
    } catch (err) {
      logger.warn("observability runtime probe tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, intervalMs);
  timer.unref(); // CRITICAL: do not keep the event loop alive
}

export function stopRuntimeProbes(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
