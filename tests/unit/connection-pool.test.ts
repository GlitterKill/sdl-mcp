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

  it("configurePool accepts writePoolSize values within 1-8", () => {
    assert.doesNotThrow(() => configurePool({ writePoolSize: 1 }));
    assert.doesNotThrow(() => configurePool({ writePoolSize: 4 }));
    assert.doesNotThrow(() => configurePool({ writePoolSize: 8 }));
  });

  it("configurePool rejects invalid writePoolSize values", () => {
    assert.throws(
      () => configurePool({ writePoolSize: 0 }),
      /writePoolSize must be between 1 and 8, got 0/,
    );
    assert.throws(
      () => configurePool({ writePoolSize: 9 }),
      /writePoolSize must be between 1 and 8, got 9/,
    );
    assert.throws(
      () => configurePool({ writePoolSize: -1 }),
      /writePoolSize must be between 1 and 8, got -1/,
    );
  });

    it("getPoolStats returns expected shape before initialization", () => {
    const stats = getPoolStats();

    assert.deepStrictEqual(Object.keys(stats).sort(), [
      "readPoolInitialized",
      "readPoolSize",
      "writeActive",
      "writeExecActive",
      "writeExecQueued",
      "writePoolInitialized",
      "writePoolSize",
      "writeQueued",
    ]);

    assert.strictEqual(typeof stats.readPoolInitialized, "number");
    assert.strictEqual(typeof stats.readPoolSize, "number");
    assert.strictEqual(typeof stats.writeQueued, "number");
    assert.strictEqual(typeof stats.writeActive, "number");
    assert.strictEqual(typeof stats.writeExecQueued, "number");
    assert.strictEqual(typeof stats.writeExecActive, "number");
    assert.strictEqual(typeof stats.writePoolSize, "number");
    assert.strictEqual(typeof stats.writePoolInitialized, "number");

    assert.strictEqual(stats.readPoolInitialized, 0);
    assert.strictEqual(stats.writeQueued, 0);
    assert.strictEqual(stats.writeActive, 0);
  });
});
