import assert from "node:assert";
import { describe, it } from "node:test";

import { configurePool, getPoolStats } from "../../dist/db/ladybug.js";

describe("ladybug connection pool configuration", () => {
  it("configurePool accepts readPoolSize values within 1-8", () => {
    for (const size of [1, 4, 8]) {
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
      /readPoolSize must be between 1 and 8, got 0/,
    );
    assert.throws(
      () => configurePool({ readPoolSize: 9 }),
      /readPoolSize must be between 1 and 8, got 9/,
    );
    assert.throws(
      () => configurePool({ readPoolSize: -1 }),
      /readPoolSize must be between 1 and 8, got -1/,
    );
  });

  it("getPoolStats returns expected shape before initialization", () => {
    const stats = getPoolStats();

    assert.deepStrictEqual(Object.keys(stats).sort(), [
      "readPoolInitialized",
      "readPoolSize",
      "writeActive",
      "writeQueued",
    ]);

    assert.strictEqual(typeof stats.readPoolInitialized, "number");
    assert.strictEqual(typeof stats.readPoolSize, "number");
    assert.strictEqual(typeof stats.writeQueued, "number");
    assert.strictEqual(typeof stats.writeActive, "number");

    assert.strictEqual(stats.readPoolInitialized, 0);
    assert.strictEqual(stats.writeQueued, 0);
    assert.strictEqual(stats.writeActive, 0);
  });
});
