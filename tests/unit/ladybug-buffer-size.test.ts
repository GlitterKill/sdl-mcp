import assert from "node:assert";
import { describe, it } from "node:test";

import { resolveLadybugBufferManagerSizeBytes } from "../../src/db/ladybug.js";

const ONE_GB = 1024 * 1024 * 1024;

describe("resolveLadybugBufferManagerSizeBytes", () => {
  it("auto-sizes to 50% of system memory within bounds", () => {
    assert.strictEqual(resolveLadybugBufferManagerSizeBytes(2 * ONE_GB, undefined), ONE_GB);
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(8 * ONE_GB, undefined),
      4 * ONE_GB,
    );
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(12 * ONE_GB, undefined),
      6 * ONE_GB,
    );
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(32 * ONE_GB, undefined),
      8 * ONE_GB,
    );
  });

  it("honors an explicit environment override at or above 1GB", () => {
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(8 * ONE_GB, String(3 * ONE_GB)),
      3 * ONE_GB,
    );
  });

  it("falls back to auto-sizing for invalid or undersized overrides", () => {
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(8 * ONE_GB, "not-a-number"),
      4 * ONE_GB,
    );
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(8 * ONE_GB, String(512 * 1024 * 1024)),
      4 * ONE_GB,
    );
  });
});
