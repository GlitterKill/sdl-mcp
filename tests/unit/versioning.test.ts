import { describe, it } from "node:test";
import assert from "node:assert";
import { computeVersionHash } from "../../src/delta/versioning.js";

describe("computeVersionHash", () => {
  it("returns a hex string", () => {
    const hash = computeVersionHash("prev", [
      { symbolId: "s1", astFingerprint: "fp1" },
    ]);
    assert.ok(/^[0-9a-f]+$/.test(hash), `expected hex, got: ${hash}`);
  });

  it("is deterministic — same inputs produce same output", () => {
    const versions = [
      { symbolId: "s1", astFingerprint: "fp1" },
      { symbolId: "s2", astFingerprint: "fp2" },
    ];
    const a = computeVersionHash("prev", versions);
    const b = computeVersionHash("prev", versions);
    assert.strictEqual(a, b);
  });

  it("changes when prevVersionHash changes", () => {
    const versions = [{ symbolId: "s1", astFingerprint: "fp1" }];
    const a = computeVersionHash("prev-a", versions);
    const b = computeVersionHash("prev-b", versions);
    assert.notStrictEqual(a, b);
  });

  it("handles null prevVersionHash", () => {
    const hash = computeVersionHash(null, [
      { symbolId: "s1", astFingerprint: "fp1" },
    ]);
    assert.ok(/^[0-9a-f]+$/.test(hash));
  });

  it("changes when symbol fingerprints change", () => {
    const a = computeVersionHash("prev", [
      { symbolId: "s1", astFingerprint: "fp1" },
    ]);
    const b = computeVersionHash("prev", [
      { symbolId: "s1", astFingerprint: "fp2" },
    ]);
    assert.notStrictEqual(a, b);
  });

  it("sorts by symbolId — order of input does not matter", () => {
    const a = computeVersionHash("prev", [
      { symbolId: "s2", astFingerprint: "fp2" },
      { symbolId: "s1", astFingerprint: "fp1" },
    ]);
    const b = computeVersionHash("prev", [
      { symbolId: "s1", astFingerprint: "fp1" },
      { symbolId: "s2", astFingerprint: "fp2" },
    ]);
    assert.strictEqual(a, b);
  });

  it("handles empty array", () => {
    const hash = computeVersionHash("prev", []);
    assert.ok(/^[0-9a-f]+$/.test(hash));
  });

  it("different symbol sets produce different hashes", () => {
    const a = computeVersionHash("prev", [
      { symbolId: "s1", astFingerprint: "fp1" },
    ]);
    const b = computeVersionHash("prev", [
      { symbolId: "s1", astFingerprint: "fp1" },
      { symbolId: "s2", astFingerprint: "fp2" },
    ]);
    assert.notStrictEqual(a, b);
  });
});
