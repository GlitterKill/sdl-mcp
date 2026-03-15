import { describe, it } from "node:test";
import assert from "node:assert";
import {
  generateSymbolId,
  clearFingerprintCollisionLog,
} from "../../src/indexer/fingerprints.js";

describe("generateSymbolId", () => {
  it("returns a hex string", () => {
    const id = generateSymbolId(
      "repo1",
      "src/foo.ts",
      "function",
      "bar",
      "fp1",
    );
    assert.ok(/^[0-9a-f]+$/.test(id), `expected hex, got: ${id}`);
  });

  it("is deterministic — same inputs produce same output", () => {
    const a = generateSymbolId("repo1", "src/foo.ts", "function", "bar", "fp1");
    const b = generateSymbolId("repo1", "src/foo.ts", "function", "bar", "fp1");
    assert.strictEqual(a, b);
  });

  it("different repoId produces different ID", () => {
    const a = generateSymbolId("repo1", "src/foo.ts", "function", "bar", "fp1");
    const b = generateSymbolId("repo2", "src/foo.ts", "function", "bar", "fp1");
    assert.notStrictEqual(a, b);
  });

  it("different relPath produces different ID", () => {
    const a = generateSymbolId("repo1", "src/foo.ts", "function", "bar", "fp1");
    const b = generateSymbolId("repo1", "src/baz.ts", "function", "bar", "fp1");
    assert.notStrictEqual(a, b);
  });

  it("different kind produces different ID", () => {
    const a = generateSymbolId("repo1", "src/foo.ts", "function", "bar", "fp1");
    const b = generateSymbolId("repo1", "src/foo.ts", "class", "bar", "fp1");
    assert.notStrictEqual(a, b);
  });

  it("different name produces different ID", () => {
    const a = generateSymbolId("repo1", "src/foo.ts", "function", "bar", "fp1");
    const b = generateSymbolId("repo1", "src/foo.ts", "function", "baz", "fp1");
    assert.notStrictEqual(a, b);
  });

  it("different astFingerprint produces different ID", () => {
    const a = generateSymbolId("repo1", "src/foo.ts", "function", "bar", "fp1");
    const b = generateSymbolId("repo1", "src/foo.ts", "function", "bar", "fp2");
    assert.notStrictEqual(a, b);
  });
});

describe("clearFingerprintCollisionLog", () => {
  it("does not throw", () => {
    assert.doesNotThrow(() => clearFingerprintCollisionLog());
  });
});
