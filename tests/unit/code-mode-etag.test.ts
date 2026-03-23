import { describe, it } from "node:test";
import assert from "node:assert";
import { ChainEtagCache } from "../../dist/code-mode/etag-cache.js";

describe("code-mode etag cache", () => {
  it("extractEtags captures etag from symbolGetCard result", () => {
    const cache = new ChainEtagCache();
    cache.extractEtags("symbol.getCard", {
      card: { symbolId: "sym1", name: "test" },
      etag: "etag-abc",
    });
    assert.strictEqual(cache.getCache()["sym1"], "etag-abc");
  });

  it("injectEtags adds ifNoneMatch for known symbolId", () => {
    const cache = new ChainEtagCache();
    cache.extractEtags("symbol.getCard", {
      card: { symbolId: "sym1", name: "test" },
      etag: "etag-abc",
    });
    const args: Record<string, unknown> = { symbolId: "sym1" };
    cache.injectEtags("symbol.getCard", args);
    assert.strictEqual(args.ifNoneMatch, "etag-abc");
  });

  it("pre-existing ifNoneMatch is NOT overwritten", () => {
    const cache = new ChainEtagCache();
    cache.extractEtags("symbol.getCard", {
      card: { symbolId: "sym1", name: "test" },
      etag: "etag-abc",
    });
    const args: Record<string, unknown> = {
      symbolId: "sym1",
      ifNoneMatch: "existing",
    };
    cache.injectEtags("symbol.getCard", args);
    assert.strictEqual(args.ifNoneMatch, "existing");
  });

  it("getCache returns all accumulated pairs", () => {
    const cache = new ChainEtagCache();
    cache.extractEtags("symbol.getCard", {
      card: { symbolId: "sym1" },
      etag: "e1",
    });
    cache.extractEtags("symbol.getCard", {
      card: { symbolId: "sym2" },
      etag: "e2",
    });
    const state = cache.getCache();
    assert.strictEqual(Object.keys(state).length, 2);
    assert.strictEqual(state["sym1"], "e1");
    assert.strictEqual(state["sym2"], "e2");
  });

  it("seed() pre-populates cache from prior chain", () => {
    const cache = new ChainEtagCache();
    cache.seed({ sym1: "e1", sym2: "e2" });
    const args: Record<string, unknown> = { symbolId: "sym1" };
    cache.injectEtags("symbol.getCard", args);
    assert.strictEqual(args.ifNoneMatch, "e1");
  });

  it("non-card actions are ignored", () => {
    const cache = new ChainEtagCache();
    cache.extractEtags("slice.build", { handle: "h1", cards: [] });
    assert.deepStrictEqual(cache.getCache(), {});
    const args: Record<string, unknown> = { symbolId: "sym1" };
    cache.injectEtags("slice.build", args);
    assert.strictEqual(args.ifNoneMatch, undefined);
  });

  it("symbolGetCards batch: multiple ETags extracted", () => {
    const cache = new ChainEtagCache();
    cache.extractEtags("symbol.getCards", {
      cards: [
        { card: { symbolId: "sym1" }, etag: "e1" },
        { card: { symbolId: "sym2" }, etag: "e2" },
      ],
    });
    assert.strictEqual(cache.getCache()["sym1"], "e1");
    assert.strictEqual(cache.getCache()["sym2"], "e2");
  });

  it("symbolGetCards batch: knownEtags built from cache", () => {
    const cache = new ChainEtagCache();
    cache.seed({ sym1: "e1", sym3: "e3" });
    const args: Record<string, unknown> = {
      symbolIds: ["sym1", "sym2", "sym3"],
    };
    cache.injectEtags("symbol.getCards", args);
    assert.deepStrictEqual(args.knownEtags, { sym1: "e1", sym3: "e3" });
  });
});
