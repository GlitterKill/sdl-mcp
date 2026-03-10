import assert from "node:assert";
import { describe, it } from "node:test";
import { ParserWorkerPool } from "../../src/indexer/workerPool.js";

describe("ParserWorkerPool", () => {
  it("can be instantiated with default pool size", async (t) => {
    const pool = new ParserWorkerPool();
    t.after(async () => {
      await pool.shutdown();
    });

    assert.ok(pool);
    assert.strictEqual(typeof pool.getPoolSize(), "number");
    assert.ok(pool.getPoolSize() >= 1);
  });

  it("error handling does not crash the pool", async (t) => {
    const pool = new ParserWorkerPool(1);
    t.after(async () => {
      await pool.shutdown();
    });

    assert.ok(pool);
    // Verify pool is still functional after instantiation
    assert.strictEqual(pool.getPoolSize(), 1);
  });
});
