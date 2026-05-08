import { stat } from "node:fs/promises";

import { logger } from "../util/logger.js";
import { getLadybugDbPath, getPoolStats, runWalCheckpoint } from "./ladybug.js";
import { isPostIndexSessionActive } from "./write-session.js";

export const DEFAULT_WAL_MAINTENANCE_INTERVAL_MS = 60_000;
export const DEFAULT_WAL_MAINTENANCE_QUIET_PERIOD_MS = 30_000;
export const DEFAULT_WAL_MAINTENANCE_MIN_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_WAL_MAINTENANCE_SIZE_THRESHOLD_BYTES = 32 * 1024 * 1024;
export const DEFAULT_WAL_MAINTENANCE_MAX_AGE_MS = 15 * 60_000;
export const DEFAULT_WAL_MAINTENANCE_CHECKPOINT_TIMEOUT_MS = 2_000;

export interface WalFileStats {
  size: number;
  mtimeMs: number;
}

export type WalMaintenanceResultReason =
  | "wal-missing"
  | "wal-empty"
  | "indexing-active"
  | "post-index-active"
  | "write-pool-busy"
  | "wal-active"
  | "recently-attempted"
  | "below-threshold"
  | "size-threshold"
  | "age-threshold"
  | "checkpoint-failed";

export interface WalMaintenanceScanResult {
  checked: boolean;
  checkpointed: boolean;
  reason: WalMaintenanceResultReason;
  walPath: string;
  walBytes?: number;
  walAgeMs?: number;
}

export interface WalCheckpointMaintenanceOptions {
  graphDbPath?: string | null;
  walPath?: string;
  intervalMs?: number;
  quietPeriodMs?: number;
  minCheckpointIntervalMs?: number;
  sizeThresholdBytes?: number;
  maxAgeMs?: number;
  checkpointTimeoutMs?: number;
  now?: () => number;
  isIndexingActive?: () => boolean;
  statFile?: (path: string) => Promise<WalFileStats | null>;
  checkpoint?: (phase: string, timeoutMs: number) => Promise<boolean>;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ENOENT"
  );
}

async function statWalFile(path: string): Promise<WalFileStats | null> {
  try {
    const stats = await stat(path);
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function resolveWalPath(options: WalCheckpointMaintenanceOptions): string {
  const graphDbPath = options.graphDbPath ?? getLadybugDbPath();
  return options.walPath ?? `${graphDbPath ?? ""}.wal`;
}

export class WalCheckpointMaintenance {
  private readonly walPath: string;
  private readonly intervalMs: number;
  private readonly quietPeriodMs: number;
  private readonly minCheckpointIntervalMs: number;
  private readonly sizeThresholdBytes: number;
  private readonly maxAgeMs: number;
  private readonly checkpointTimeoutMs: number;
  private readonly now: () => number;
  private readonly statFile: (path: string) => Promise<WalFileStats | null>;
  private readonly checkpoint: (
    phase: string,
    timeoutMs: number,
  ) => Promise<boolean>;
  private readonly isIndexingActive: () => boolean;
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private lastCheckpointAttemptAt = 0;

  constructor(options: WalCheckpointMaintenanceOptions = {}) {
    this.walPath = resolveWalPath(options);
    this.intervalMs =
      options.intervalMs ?? DEFAULT_WAL_MAINTENANCE_INTERVAL_MS;
    this.quietPeriodMs =
      options.quietPeriodMs ?? DEFAULT_WAL_MAINTENANCE_QUIET_PERIOD_MS;
    this.minCheckpointIntervalMs =
      options.minCheckpointIntervalMs ??
      DEFAULT_WAL_MAINTENANCE_MIN_INTERVAL_MS;
    this.sizeThresholdBytes =
      options.sizeThresholdBytes ??
      DEFAULT_WAL_MAINTENANCE_SIZE_THRESHOLD_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_WAL_MAINTENANCE_MAX_AGE_MS;
    this.checkpointTimeoutMs =
      options.checkpointTimeoutMs ??
      DEFAULT_WAL_MAINTENANCE_CHECKPOINT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.isIndexingActive = options.isIndexingActive ?? (() => false);
    this.statFile = options.statFile ?? statWalFile;
    this.checkpoint = options.checkpoint ?? runWalCheckpoint;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.scanOnce("interval").catch((error) => {
        logger.warn("[wal-maintenance] scan failed", {
          error: error instanceof Error ? error.message : String(error),
        });
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

  async scanOnce(source = "manual"): Promise<WalMaintenanceScanResult> {
    if (this.scanning) {
      return this.skip("write-pool-busy");
    }
    this.scanning = true;

    try {
      if (this.isIndexingActive()) {
        return this.skip("indexing-active");
      }
      if (isPostIndexSessionActive()) {
        return this.skip("post-index-active");
      }

      const poolStats = getPoolStats();
      if (poolStats.writeActive > 0 || poolStats.writeQueued > 0) {
        return this.skip("write-pool-busy");
      }

      const walStats = await this.statFile(this.walPath);
      if (!walStats) {
        return this.skip("wal-missing");
      }
      if (walStats.size <= 0) {
        return this.withWal("wal-empty", walStats, false);
      }

      const nowMs = this.now();
      const walAgeMs = Math.max(0, nowMs - walStats.mtimeMs);
      if (walAgeMs < this.quietPeriodMs) {
        return this.withWal("wal-active", walStats, false, walAgeMs);
      }
      if (
        this.lastCheckpointAttemptAt > 0 &&
        nowMs - this.lastCheckpointAttemptAt < this.minCheckpointIntervalMs
      ) {
        return this.withWal("recently-attempted", walStats, false, walAgeMs);
      }

      const trigger =
        walStats.size >= this.sizeThresholdBytes
          ? "size-threshold"
          : walAgeMs >= this.maxAgeMs
            ? "age-threshold"
            : null;
      if (!trigger) {
        return this.withWal("below-threshold", walStats, false, walAgeMs);
      }

      this.lastCheckpointAttemptAt = nowMs;
      const checkpointed = await this.checkpoint(
        `wal-maintenance:${source}:${trigger}`,
        this.checkpointTimeoutMs,
      );
      if (!checkpointed) {
        return this.withWal("checkpoint-failed", walStats, false, walAgeMs);
      }

      logger.debug("[wal-maintenance] checkpoint completed", {
        walPath: this.walPath,
        walBytes: walStats.size,
        walAgeMs,
        trigger,
      });
      return this.withWal(trigger, walStats, true, walAgeMs);
    } finally {
      this.scanning = false;
    }
  }

  private skip(reason: WalMaintenanceResultReason): WalMaintenanceScanResult {
    return {
      checked: true,
      checkpointed: false,
      reason,
      walPath: this.walPath,
    };
  }

  private withWal(
    reason: WalMaintenanceResultReason,
    walStats: WalFileStats,
    checkpointed: boolean,
    walAgeMs = 0,
  ): WalMaintenanceScanResult {
    return {
      checked: true,
      checkpointed,
      reason,
      walPath: this.walPath,
      walBytes: walStats.size,
      walAgeMs,
    };
  }
}

export function createWalCheckpointMaintenance(
  options: WalCheckpointMaintenanceOptions = {},
): WalCheckpointMaintenance {
  return new WalCheckpointMaintenance(options);
}
