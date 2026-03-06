import assert from "node:assert";
import { describe, it } from "node:test";

import { resolveKuzuBufferManagerSizeBytes } from "../../src/db/kuzu.js";

const ONE_GB = 1024 * 1024 * 1024;

describe("resolveKuzuBufferManagerSizeBytes", () => {
  it("auto-sizes to 25% of system memory within bounds", () => {
    assert.strictEqual(resolveKuzuBufferManagerSizeBytes(2 * ONE_GB, undefined), ONE_GB);
    assert.strictEqual(
      resolveKuzuBufferManagerSizeBytes(8 * ONE_GB, undefined),
      2 * ONE_GB,
    );
    assert.strictEqual(
      resolveKuzuBufferManagerSizeBytes(32 * ONE_GB, undefined),
      4 * ONE_GB,
    );
  });

  it("honors an explicit environment override at or above 1GB", () => {
    assert.strictEqual(
      resolveKuzuBufferManagerSizeBytes(8 * ONE_GB, String(3 * ONE_GB)),
      3 * ONE_GB,
    );
  });

  it("falls back to auto-sizing for invalid or undersized overrides", () => {
    assert.strictEqual(
      resolveKuzuBufferManagerSizeBytes(8 * ONE_GB, "not-a-number"),
      2 * ONE_GB,
    );
    assert.strictEqual(
      resolveKuzuBufferManagerSizeBytes(8 * ONE_GB, String(512 * 1024 * 1024)),
      2 * ONE_GB,
    );
  });
});
