import { logger } from "../util/logger.js";
import { OverlayStore } from "./overlay-store.js";
import type { CheckpointRequest, CheckpointResult } from "./types.js";

export const DEFAULT_IDLE_CHECKPOINT_INTERVAL_MS = 5_000;
export const DEFAULT_IDLE_CHECKPOINT_QUIET_PERIOD_MS = 15_000;

interface IdleMonitorOptions {
  overlayStore: OverlayStore;
  checkpointRepo: (request: CheckpointRequest) => Promise<CheckpointResult>;
  intervalMs?: number;
  quietPeriodMs?: number;
  now?: () => number;
}

export class IdleMonitor {
  private readonly intervalMs: number;
  private readonly quietPeriodMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private stopped = false;
  private scanComplete: Promise<void> | null = null;

  constructor(private readonly options: IdleMonitorOptions) {
    this.intervalMs =
      options.intervalMs ?? DEFAULT_IDLE_CHECKPOINT_INTERVAL_MS;
    this.quietPeriodMs =
      options.quietPeriodMs ?? DEFAULT_IDLE_CHECKPOINT_QUIET_PERIOD_MS;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.stopped = false;
    this.timer = setInterval(() => {
      this.scanOnce().catch((error) => {
        logger.error(`[IdleMonitor] Scan failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.scanComplete;
  }

  async scanOnce(): Promise<string[]> {
    if (this.stopped || this.scanning) {
      return [];
    }
    this.scanning = true;
    let resolveScan!: () => void;
    this.scanComplete = new Promise<void>((resolve) => {
      resolveScan = resolve;
    });

    try {
      const triggered: string[] = [];
      const nowMs = this.now();

      for (const repoId of this.options.overlayStore.listRepoIds()) {
        const stats = this.options.overlayStore.getRepoStats(repoId);
        if (!stats.lastBufferEventAt) {
          continue;
        }
        const eventTime = Date.parse(stats.lastBufferEventAt);
        if (Number.isNaN(eventTime)) continue;
        if (
          nowMs - eventTime < this.quietPeriodMs
        ) {
          continue;
        }
        if (
          this.options.overlayStore.listCheckpointCandidates(repoId).length === 0
        ) {
          continue;
        }

        try {
          await this.options.checkpointRepo({ repoId, reason: "idle" });
          triggered.push(repoId);
        } catch (err) {
          logger.warn("[IdleMonitor] checkpointRepo failed for " + repoId + ": " + (err instanceof Error ? err.message : String(err)));
        }
      }

      return triggered;
    } finally {
      this.scanning = false;
      this.scanComplete = null;
      resolveScan();
    }
  }
}
