import assert from "node:assert";
import { describe, it } from "node:test";

import { resolveParserWorkerPoolSize } from "../../dist/indexer/indexer.js";

describe("resolveParserWorkerPoolSize", () => {
  // Pool sizing rules (post commit 28a5d8c, which dropped the
  // concurrency-based clamp):
  //   default = cpuCount - 1
  //   resolved = min(configured ?? default, max(1, fileCount))
  //   floored at 1
  // `concurrency` is accepted for backward compatibility but ignored.

  it("caps default pool size by file count", () => {
    // default = 32 - 1 = 31, but fileCount=2 caps it to 2
    const poolSize = resolveParserWorkerPoolSize({
      concurrency: 4,
      fileCount: 2,
      cpuCount: 32,
    });
    assert.strictEqual(poolSize, 2);
  });

  it("uses cpuCount - 1 as the default pool size", () => {
    const poolSize = resolveParserWorkerPoolSize({
      concurrency: 4,
      fileCount: 1000,
      cpuCount: 8,
    });
    // default = 8 - 1 = 7, fileCount=1000 doesn't cap below default
    assert.strictEqual(poolSize, 7);
  });

  it("respects explicit workerPoolSize when smaller than limits", () => {
    const poolSize = resolveParserWorkerPoolSize({
      configuredWorkerPoolSize: 1,
      concurrency: 4,
      fileCount: 10,
      cpuCount: 32,
    });
    assert.strictEqual(poolSize, 1);
  });

  it("does NOT cap configured workerPoolSize by concurrency", () => {
    // The previous behaviour capped at `concurrency` (3); commit 28a5d8c
    // dropped that clamp because pass-1 dispatch is throughput-bound by
    // file count, not concurrency. With configured=12 and ample files
    // the resolved pool is 12.
    const poolSize = resolveParserWorkerPoolSize({
      configuredWorkerPoolSize: 12,
      concurrency: 3,
      fileCount: 20,
      cpuCount: 32,
    });
    assert.strictEqual(poolSize, 12);
  });

  it("caps configured workerPoolSize by file count", () => {
    const poolSize = resolveParserWorkerPoolSize({
      configuredWorkerPoolSize: 100,
      concurrency: 4,
      fileCount: 5,
      cpuCount: 32,
    });
    assert.strictEqual(poolSize, 5);
  });

  it("returns at least one worker when file count is empty", () => {
    const poolSize = resolveParserWorkerPoolSize({
      concurrency: 4,
      fileCount: 0,
      cpuCount: 32,
    });
    assert.strictEqual(poolSize, 1);
  });
});
