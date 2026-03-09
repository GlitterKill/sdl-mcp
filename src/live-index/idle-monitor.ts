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

    this.timer = setInterval(() => {
      this.scanOnce().catch((error) => {
        logger.error(`[IdleMonitor] Scan failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async scanOnce(): Promise<string[]> {
    if (this.scanning) {
      return [];
    }
    this.scanning = true;

    try {
      const triggered: string[] = [];
      const nowMs = this.now();

      for (const repoId of this.options.overlayStore.listRepoIds()) {
        const stats = this.options.overlayStore.getRepoStats(repoId);
        if (!stats.lastBufferEventAt) {
          continue;
        }
        if (
          nowMs - Date.parse(stats.lastBufferEventAt) < this.quietPeriodMs
        ) {
          continue;
        }
        if (
          this.options.overlayStore.listCheckpointCandidates(repoId).length === 0
        ) {
          continue;
        }

        await this.options.checkpointRepo({ repoId, reason: "idle" });
        triggered.push(repoId);
      }

      return triggered;
    } finally {
      this.scanning = false;
    }
  }
}
