import { describe, it } from "node:test";
import assert from "node:assert";
import {
  asRepoId,
  asSymbolId,
  asVersionId,
  uncheckedAsRepoId,
  uncheckedAsSymbolId,
  uncheckedAsVersionId,
  isRepoId,
  isSymbolId,
  isVersionId,
  toRawRepoId,
  toRawSymbolId,
  toRawVersionId,
} from "../../dist/mcp/ids.js";
import type { RepoId, SymbolId, VersionId } from "../../dist/mcp/ids.js";

describe("Branded ID Utilities", () => {
  describe("asRepoId", () => {
    it("accepts valid repo IDs", () => {
      assert.strictEqual(asRepoId("my-repo"), "my-repo");
      assert.strictEqual(asRepoId("my_repo"), "my_repo");
      assert.strictEqual(asRepoId("repo123"), "repo123");
      assert.strictEqual(asRepoId("a"), "a");
    });

    it("rejects empty strings", () => {
      assert.throws(() => asRepoId(""), TypeError);
    });

    it("rejects strings with spaces", () => {
      assert.throws(() => asRepoId("repo with spaces"), TypeError);
    });

    it("rejects strings with special characters", () => {
      assert.throws(() => asRepoId("repo/slash"), TypeError);
      assert.throws(() => asRepoId("repo.dot"), TypeError);
      assert.throws(() => asRepoId("repo@symbol"), TypeError);
    });

    it("rejects overly long strings", () => {
      const longId = "a".repeat(129);
      assert.throws(() => asRepoId(longId), TypeError);
    });
  });

  describe("asSymbolId", () => {
    it("accepts valid symbol IDs", () => {
      assert.strictEqual(asSymbolId("symbol"), "symbol");
      assert.strictEqual(asSymbolId("src/main.ts::func"), "src/main.ts::func");
      assert.strictEqual(asSymbolId("ClassName.method"), "ClassName.method");
      assert.strictEqual(asSymbolId("id#hash"), "id#hash");
    });

    it("rejects empty strings", () => {
      assert.throws(() => asSymbolId(""), TypeError);
    });

    it("rejects overly long strings", () => {
      const longId = "a".repeat(513);
      assert.throws(() => asSymbolId(longId), TypeError);
    });
  });

  describe("asVersionId", () => {
    it("accepts valid version IDs", () => {
      assert.strictEqual(asVersionId("v12345"), "v12345");
      assert.strictEqual(asVersionId("12345"), "12345");
      assert.strictEqual(asVersionId("v1"), "v1");
    });

    it("rejects empty strings", () => {
      assert.throws(() => asVersionId(""), TypeError);
    });

    it("rejects non-numeric versions", () => {
      assert.throws(() => asVersionId("vabc"), TypeError);
      assert.throws(() => asVersionId("invalid"), TypeError);
    });

    it("rejects overly long strings", () => {
      const longId = "v" + "1".repeat(64);
      assert.throws(() => asVersionId(longId), TypeError);
    });
  });

  describe("unchecked casts", () => {
    it("do not validate but still type correctly", () => {
      const repoId: RepoId = uncheckedAsRepoId("anything goes");
      const symbolId: SymbolId = uncheckedAsSymbolId("also anything");
      const versionId: VersionId = uncheckedAsVersionId("whatever");

      assert.strictEqual(repoId, "anything goes");
      assert.strictEqual(symbolId, "also anything");
      assert.strictEqual(versionId, "whatever");
    });
  });

  describe("type guards", () => {
    it("isRepoId works correctly", () => {
      assert.strictEqual(isRepoId("valid-repo"), true);
      assert.strictEqual(isRepoId("valid_repo"), true);
      assert.strictEqual(isRepoId("invalid repo"), false);
      assert.strictEqual(isRepoId(""), false);
    });

    it("isSymbolId works correctly", () => {
      assert.strictEqual(isSymbolId("valid:symbol"), true);
      assert.strictEqual(isSymbolId("invalid symbol"), false);
      assert.strictEqual(isSymbolId(""), false);
    });

    it("isVersionId works correctly", () => {
      assert.strictEqual(isVersionId("v123"), true);
      assert.strictEqual(isVersionId("123"), true);
      assert.strictEqual(isVersionId("invalid"), false);
      assert.strictEqual(isVersionId(""), false);
    });
  });

  describe("toRaw functions", () => {
    it("convert branded IDs back to strings", () => {
      const repoId = asRepoId("my-repo");
      const symbolId = asSymbolId("my-symbol");
      const versionId = asVersionId("v123");

      assert.strictEqual(toRawRepoId(repoId), "my-repo");
      assert.strictEqual(toRawSymbolId(symbolId), "my-symbol");
      assert.strictEqual(toRawVersionId(versionId), "v123");

      assert.strictEqual(typeof toRawRepoId(repoId), "string");
      assert.strictEqual(typeof toRawSymbolId(symbolId), "string");
      assert.strictEqual(typeof toRawVersionId(versionId), "string");
    });
  });

  describe("round-trip conversion", () => {
    it("preserves values through conversion cycle", () => {
      const originalRepo = "test-repo";
      const repoId = asRepoId(originalRepo);
      const rawRepo = toRawRepoId(repoId);
      assert.strictEqual(rawRepo, originalRepo);

      const originalSymbol = "src/file.ts::func";
      const symbolId = asSymbolId(originalSymbol);
      const rawSymbol = toRawSymbolId(symbolId);
      assert.strictEqual(rawSymbol, originalSymbol);

      const originalVersion = "v12345";
      const versionId = asVersionId(originalVersion);
      const rawVersion = toRawVersionId(versionId);
      assert.strictEqual(rawVersion, originalVersion);
    });
  });
});
