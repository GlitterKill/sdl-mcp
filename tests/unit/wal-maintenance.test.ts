import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WalCheckpointMaintenance } from "../../dist/db/wal-maintenance.js";

describe("WalCheckpointMaintenance", () => {
  it("checkpoints a quiet WAL once it crosses the size threshold", async () => {
    let nowMs = 1_000_000;
    const calls: Array<{ phase: string; timeoutMs: number }> = [];
    const maintenance = new WalCheckpointMaintenance({
      walPath: "test.lbug.wal",
      intervalMs: 60_000,
      quietPeriodMs: 10_000,
      minCheckpointIntervalMs: 60_000,
      sizeThresholdBytes: 32,
      maxAgeMs: 15 * 60_000,
      checkpointTimeoutMs: 2_500,
      now: () => nowMs,
      statFile: async () => ({
        size: 64,
        mtimeMs: nowMs - 20_000,
      }),
      checkpoint: async (phase, timeoutMs) => {
        calls.push({ phase, timeoutMs });
        return true;
      },
    });

    const first = await maintenance.scanOnce("test");
    nowMs += 30_000;
    const second = await maintenance.scanOnce("test");

    assert.equal(first.checkpointed, true);
    assert.equal(first.reason, "size-threshold");
    assert.equal(second.checkpointed, false);
    assert.equal(second.reason, "recently-attempted");
    assert.deepEqual(calls, [
      {
        phase: "wal-maintenance:test:size-threshold",
        timeoutMs: 2_500,
      },
    ]);
  });

  it("waits for WAL quiet time before checkpointing active writes", async () => {
    const nowMs = 1_000_000;
    let checkpointCalls = 0;
    const maintenance = new WalCheckpointMaintenance({
      walPath: "test.lbug.wal",
      quietPeriodMs: 10_000,
      sizeThresholdBytes: 32,
      now: () => nowMs,
      statFile: async () => ({
        size: 64,
        mtimeMs: nowMs - 1_000,
      }),
      checkpoint: async () => {
        checkpointCalls++;
        return true;
      },
    });

    const result = await maintenance.scanOnce("test");

    assert.equal(result.checkpointed, false);
    assert.equal(result.reason, "wal-active");
    assert.equal(checkpointCalls, 0);
  });

  it("skips checkpoints while indexing is active", async () => {
    let statCalls = 0;
    const maintenance = new WalCheckpointMaintenance({
      walPath: "test.lbug.wal",
      isIndexingActive: () => true,
      statFile: async () => {
        statCalls++;
        return {
          size: 64,
          mtimeMs: 0,
        };
      },
      checkpoint: async () => true,
    });

    const result = await maintenance.scanOnce("test");

    assert.equal(result.checkpointed, false);
    assert.equal(result.reason, "indexing-active");
    assert.equal(statCalls, 0);
  });

  it("checkpoints a quiet non-empty WAL after the max age even below size threshold", async () => {
    const nowMs = 1_000_000;
    let checkpointCalls = 0;
    const maintenance = new WalCheckpointMaintenance({
      walPath: "test.lbug.wal",
      quietPeriodMs: 10_000,
      sizeThresholdBytes: 1024,
      maxAgeMs: 60_000,
      now: () => nowMs,
      statFile: async () => ({
        size: 128,
        mtimeMs: nowMs - 120_000,
      }),
      checkpoint: async () => {
        checkpointCalls++;
        return true;
      },
    });

    const result = await maintenance.scanOnce("test");

    assert.equal(result.checkpointed, true);
    assert.equal(result.reason, "age-threshold");
    assert.equal(checkpointCalls, 1);
  });
});
