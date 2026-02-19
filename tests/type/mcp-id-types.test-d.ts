import type { RepoId, SymbolId, VersionId } from "../../dist/mcp/ids.js";
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

import { describe, it } from "node:test";
import assert from "node:assert";

type AssertEqual<T, Expected> = T extends Expected
  ? Expected extends T
    ? true
    : false
  : false;
const assertType = <T, Expected>(_value: AssertEqual<T, Expected>): void => {};

describe("Branded ID Types - Type Tests", () => {
  it("type tests", () => {
    const repoId: RepoId = asRepoId("test-repo");
    const symbolId: SymbolId = asSymbolId("symbol");
    const versionId: VersionId = asVersionId("v1");

    assertType<RepoId, typeof repoId>(true);
    assertType<SymbolId, typeof symbolId>(true);
    assertType<VersionId, typeof versionId>(true);

    const rawRepo: string = toRawRepoId(repoId);
    const rawSymbol: string = toRawSymbolId(symbolId);
    const rawVersion: string = toRawVersionId(versionId);

    assertType<string, typeof rawRepo>(true);
    assertType<string, typeof rawSymbol>(true);
    assertType<string, typeof rawVersion>(true);

    const uncheckedRepo: RepoId = uncheckedAsRepoId("anything");
    const uncheckedSymbol: SymbolId = uncheckedAsSymbolId("anything");
    const uncheckedVersion: VersionId = uncheckedAsVersionId("anything");

    assertType<RepoId, typeof uncheckedRepo>(true);
    assertType<SymbolId, typeof uncheckedSymbol>(true);
    assertType<VersionId, typeof uncheckedVersion>(true);

    const isRepo: boolean = isRepoId("test");
    const isSymbol: boolean = isSymbolId("sym");
    const isVersion: boolean = isVersionId("v1");

    assertType<boolean, typeof isRepo>(true);
    assertType<boolean, typeof isSymbol>(true);
    assertType<boolean, typeof isVersion>(true);
  });

  describe("Runtime validation", () => {
    it("asRepoId validates correct format", () => {
      assert.strictEqual(asRepoId("my-repo"), "my-repo");
      assert.strictEqual(asRepoId("my_repo"), "my_repo");
      assert.strictEqual(asRepoId("repo123"), "repo123");
    });

    it("asRepoId rejects invalid format", () => {
      assert.throws(() => asRepoId(""), TypeError);
      assert.throws(() => asRepoId("repo with spaces"), TypeError);
      assert.throws(() => asRepoId("repo/slash"), TypeError);
    });

    it("asSymbolId validates correct format", () => {
      assert.strictEqual(asSymbolId("src/main.ts::func"), "src/main.ts::func");
      assert.strictEqual(asSymbolId("symbol_name"), "symbol_name");
      assert.strictEqual(asSymbolId("ClassName.method"), "ClassName.method");
      assert.strictEqual(asSymbolId("id#hash"), "id#hash");
    });

    it("asSymbolId rejects invalid format", () => {
      assert.throws(() => asSymbolId(""), TypeError);
    });

    it("asVersionId validates correct format", () => {
      assert.strictEqual(asVersionId("v12345"), "v12345");
      assert.strictEqual(asVersionId("12345"), "12345");
    });

    it("asVersionId rejects invalid format", () => {
      assert.throws(() => asVersionId(""), TypeError);
      assert.throws(() => asVersionId("vabc"), TypeError);
      assert.throws(() => asVersionId("invalid"), TypeError);
    });

    it("unchecked casts do not validate", () => {
      assert.strictEqual(uncheckedAsRepoId("anything"), "anything");
      assert.strictEqual(uncheckedAsSymbolId("anything"), "anything");
      assert.strictEqual(uncheckedAsVersionId("anything"), "anything");
    });

    it("type guards work correctly", () => {
      assert.strictEqual(isRepoId("valid-repo"), true);
      assert.strictEqual(isRepoId("invalid repo"), false);
      assert.strictEqual(isSymbolId("valid:symbol"), true);
      assert.strictEqual(isVersionId("v123"), true);
      assert.strictEqual(isVersionId("invalid"), false);
    });

    it("toRaw functions strip branding", () => {
      const repoId = asRepoId("my-repo");
      const raw = toRawRepoId(repoId);
      assert.strictEqual(typeof raw, "string");
      assert.strictEqual(raw, "my-repo");
    });
  });
});
