import assert from "node:assert";
import { describe, it } from "node:test";

import { resolveLadybugBufferManagerSizeBytes } from "../../dist/db/ladybug.js";

const ONE_GB = 1024 * 1024 * 1024;

describe("resolveLadybugBufferManagerSizeBytes", () => {
  it("auto-sizes to 25% of system memory within bounds", () => {
    // 2GB system → 0.5GB → clamped to 1GB floor
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(2 * ONE_GB, undefined),
      ONE_GB,
    );
    // 8GB system → 2GB
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(8 * ONE_GB, undefined),
      2 * ONE_GB,
    );
    // 12GB system → 3GB
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(12 * ONE_GB, undefined),
      3 * ONE_GB,
    );
    // 32GB system → 8GB → clamped to 4GB cap
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(32 * ONE_GB, undefined),
      4 * ONE_GB,
    );
  });

  it("honors an explicit environment override at or above 1GB", () => {
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(8 * ONE_GB, String(3 * ONE_GB)),
      3 * ONE_GB,
    );
  });

  it("honors a configured override when no env override is present", () => {
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(8 * ONE_GB, "", 3 * ONE_GB),
      3 * ONE_GB,
    );
  });

  it("prefers env override over configured override", () => {
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(
        8 * ONE_GB,
        String(4 * ONE_GB),
        3 * ONE_GB,
      ),
      4 * ONE_GB,
    );
  });

  it("falls back to auto-sizing for invalid or undersized overrides", () => {
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(8 * ONE_GB, "not-a-number"),
      2 * ONE_GB,
    );
    assert.strictEqual(
      resolveLadybugBufferManagerSizeBytes(
        8 * ONE_GB,
        String(512 * 1024 * 1024),
      ),
      2 * ONE_GB,
    );
  });
});
