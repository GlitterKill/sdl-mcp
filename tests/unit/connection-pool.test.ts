import assert from "node:assert";
import { describe, it } from "node:test";

import { configurePool, getPoolStats } from "../../dist/db/ladybug.js";

describe("ladybug connection pool configuration", () => {
  it("configurePool accepts readPoolSize values within 1-16", () => {
    for (const size of [1, 4, 8, 16]) {
      assert.doesNotThrow(() => {
        configurePool({ readPoolSize: size });
      });

      const stats = getPoolStats();
      assert.strictEqual(stats.readPoolSize, size);
    }
  });

  it("configurePool rejects invalid readPoolSize values", () => {
    assert.throws(
      () => configurePool({ readPoolSize: 0 }),
      /readPoolSize must be between 1 and 16, got 0/,
    );
    assert.throws(
      () => configurePool({ readPoolSize: 17 }),
      /readPoolSize must be between 1 and 16, got 17/,
    );
    assert.throws(
      () => configurePool({ readPoolSize: -1 }),
      /readPoolSize must be between 1 and 16, got -1/,
    );
  });

  it("getPoolStats returns expected shape before initialization", () => {
    const stats = getPoolStats();

    // The shape was extended by the observability dashboard work:
    // beyond the original `read*` / `write{Initialized,Queued,Active}`
    // fields, the writeLimiter now exposes cumulative + peak counters
    // for the dashboard's bottleneck panel.
    assert.deepStrictEqual(Object.keys(stats).sort(), [
      "readPoolInitialized",
      "readPoolSize",
      "writeActive",
      "writeInitialized",
      "writePeakActive",
      "writePeakQueued",
      "writeQueued",
      "writeTotalActiveMs",
      "writeTotalQueueMs",
      "writeTotalRuns",
    ]);

    // Original fields keep their original types and zero-init invariants.
    assert.strictEqual(typeof stats.readPoolInitialized, "number");
    assert.strictEqual(typeof stats.readPoolSize, "number");
    assert.strictEqual(typeof stats.writeQueued, "number");
    assert.strictEqual(typeof stats.writeActive, "number");
    assert.strictEqual(typeof stats.writeInitialized, "boolean");
    assert.strictEqual(stats.readPoolInitialized, 0);
    assert.strictEqual(stats.writeQueued, 0);
    assert.strictEqual(stats.writeActive, 0);

    // The writeLimiter telemetry counters are also numeric and start at 0.
    assert.strictEqual(typeof stats.writeTotalActiveMs, "number");
    assert.strictEqual(typeof stats.writeTotalQueueMs, "number");
    assert.strictEqual(typeof stats.writeTotalRuns, "number");
    assert.strictEqual(typeof stats.writePeakQueued, "number");
    assert.strictEqual(typeof stats.writePeakActive, "number");
    assert.strictEqual(stats.writeTotalActiveMs, 0);
    assert.strictEqual(stats.writeTotalQueueMs, 0);
    assert.strictEqual(stats.writeTotalRuns, 0);
    assert.strictEqual(stats.writePeakQueued, 0);
    assert.strictEqual(stats.writePeakActive, 0);
  });
});
