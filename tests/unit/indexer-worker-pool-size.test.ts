import assert from "node:assert";
import { describe, it } from "node:test";

import { resolveParserWorkerPoolSize } from "../../src/indexer/indexer.ts";

describe("resolveParserWorkerPoolSize", () => {
  it("caps default pool size by concurrency and file count", () => {
    const poolSize = resolveParserWorkerPoolSize({
      concurrency: 4,
      fileCount: 2,
      cpuCount: 32,
    });

    assert.strictEqual(poolSize, 2);
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

  it("caps explicit workerPoolSize by concurrency", () => {
    const poolSize = resolveParserWorkerPoolSize({
      configuredWorkerPoolSize: 12,
      concurrency: 3,
      fileCount: 20,
      cpuCount: 32,
    });

    assert.strictEqual(poolSize, 3);
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
