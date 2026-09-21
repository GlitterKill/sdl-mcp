import assert from "node:assert/strict";
import { test } from "node:test";
import type { Worker } from "node:worker_threads";
import { ParserWorkerPool } from "../../dist/indexer/workerPool.js";
import { logger } from "../../dist/util/logger.js";

test("expected termination is quiet; an unexpected worker exit still recovers", async (t) => {
  const warnings = t.mock.method(logger, "warn", () => {});
  const pool = new ParserWorkerPool({
    poolSize: 1,
    configuredLanguages: ["python"],
  });
  t.after(() => pool.shutdown());
  const source = "def example():\n    return 1\n";
  const parsed = await pool.parse("example.py", source, ".py");
  assert.ok(parsed.symbols.some((symbol) => symbol.name === "example"));
  // Exercise the real exit event without adding a production-only test hook.
  const worker = (pool as unknown as { workers: Array<{ worker: Worker }> })
    .workers[0].worker;
  await worker.terminate();
  assert.equal(warnings.mock.callCount(), 1);
  assert.equal(
    warnings.mock.calls[0].arguments[0],
    "Worker crashed and was replaced",
  );
  const recovered = await pool.parse("example.py", source, ".py");
  assert.ok(recovered.symbols.some((symbol) => symbol.name === "example"));
  await pool.shutdown();
  assert.equal(
    warnings.mock.callCount(),
    1,
    "shutdown must not report a crash or replacement",
  );
  await assert.rejects(pool.parse("example.py", source, ".py"), /shut down/);
});
