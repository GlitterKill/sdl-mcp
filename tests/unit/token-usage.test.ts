import { describe, it } from "node:test";
import assert from "node:assert";
import {
  shouldAttachUsage,
  computeSavings,
  computeTokenUsage,
  stripRawContext,
  attachRawContext,
} from "../../src/mcp/token-usage.js";

describe("token-usage", () => {
  describe("shouldAttachUsage", () => {
    it("returns true for code-context tools", () => {
      assert.strictEqual(shouldAttachUsage("sdl.symbol.search"), true);
      assert.strictEqual(shouldAttachUsage("sdl.symbol.getCard"), true);
      assert.strictEqual(shouldAttachUsage("sdl.slice.build"), true);
      assert.strictEqual(shouldAttachUsage("sdl.code.needWindow"), true);
      assert.strictEqual(shouldAttachUsage("sdl.code.getSkeleton"), true);
      assert.strictEqual(shouldAttachUsage("sdl.code.getHotPath"), true);
      assert.strictEqual(shouldAttachUsage("sdl.delta.get"), true);
    });

    it("returns false for management tools", () => {
      assert.strictEqual(shouldAttachUsage("sdl.repo.register"), false);
      assert.strictEqual(shouldAttachUsage("sdl.repo.status"), false);
      assert.strictEqual(shouldAttachUsage("sdl.repo.overview"), false);
      assert.strictEqual(shouldAttachUsage("sdl.index.refresh"), false);
      assert.strictEqual(shouldAttachUsage("sdl.policy.get"), false);
      assert.strictEqual(shouldAttachUsage("sdl.policy.set"), false);
      assert.strictEqual(shouldAttachUsage("sdl.agent.feedback"), false);
      assert.strictEqual(shouldAttachUsage("sdl.agent.feedback.query"), false);
    });
  });

  describe("computeSavings", () => {
    it("computes correct savings percentage", () => {
      const result = computeSavings(135, 2400);
      assert.strictEqual(result.sdlTokens, 135);
      assert.strictEqual(result.rawEquivalent, 2400);
      assert.strictEqual(result.savingsPercent, 94);
    });

    it("returns 0 savings when rawEquivalent is 0", () => {
      const result = computeSavings(100, 0);
      assert.strictEqual(result.savingsPercent, 0);
    });

    it("returns 0 savings when sdlTokens >= rawEquivalent", () => {
      const result = computeSavings(500, 100);
      assert.strictEqual(result.savingsPercent, 0);
    });

    it("returns 0 savings when sdlTokens equal rawEquivalent", () => {
      const result = computeSavings(100, 100);
      assert.strictEqual(result.savingsPercent, 0);
    });

    it("computes 50% savings correctly", () => {
      const result = computeSavings(50, 100);
      assert.strictEqual(result.savingsPercent, 50);
    });
  });

  describe("computeTokenUsage with rawTokens hint", () => {
    it("uses rawTokens override and computes savings", async () => {
      const result = {
        data: "some content",
        _rawContext: { rawTokens: 5000 },
      };
      const usage = await computeTokenUsage(result as Record<string, unknown>);
      assert.strictEqual(usage.rawEquivalent, 5000);
      assert.ok(usage.sdlTokens > 0);
      assert.ok(usage.savingsPercent > 0);
    });

    it("returns zeros when no _rawContext", async () => {
      const result = { card: { name: "test" } };
      const usage = await computeTokenUsage(result as Record<string, unknown>);
      assert.strictEqual(usage.sdlTokens, 0);
      assert.strictEqual(usage.rawEquivalent, 0);
      assert.strictEqual(usage.savingsPercent, 0);
    });

    it("clamps savings to 0 when sdlTokens exceed rawEquivalent", async () => {
      const result = {
        data: "a".repeat(1000),
        _rawContext: { rawTokens: 1 },
      };
      const usage = await computeTokenUsage(result as Record<string, unknown>);
      assert.strictEqual(usage.savingsPercent, 0);
    });

    it("excludes _rawContext from sdlTokens estimate", async () => {
      const result = {
        card: { name: "test" },
        _rawContext: { rawTokens: 10000 },
      };
      const usage = await computeTokenUsage(result as Record<string, unknown>);
      // sdlTokens should be based on { card: { name: "test" } } only
      assert.ok(usage.sdlTokens < 50);
    });
  });

  describe("attachRawContext", () => {
    it("attaches _rawContext to objects via mutation", () => {
      const obj = { card: { name: "test" } } as Record<string, unknown>;
      const result = attachRawContext(obj, { fileIds: [1, 2] });
      assert.strictEqual(result, obj);
      assert.deepStrictEqual(obj._rawContext, { fileIds: [1, 2] });
    });

    it("handles rawTokens hint", () => {
      const obj = { data: "test" } as Record<string, unknown>;
      attachRawContext(obj, { rawTokens: 500 });
      assert.deepStrictEqual(obj._rawContext, { rawTokens: 500 });
    });

    it("is a no-op for non-objects", () => {
      assert.strictEqual(attachRawContext(null, { fileIds: [1] }), null);
    });
  });

  describe("stripRawContext", () => {
    it("removes _rawContext from objects", () => {
      const input = {
        card: { name: "test" },
        _rawContext: { fileIds: [1] },
      };
      const result = stripRawContext(input);
      assert.ok(!("_rawContext" in result));
      assert.deepStrictEqual(
        (result as Record<string, unknown>).card,
        { name: "test" },
      );
    });

    it("returns non-objects unchanged", () => {
      assert.strictEqual(stripRawContext(null), null);
      assert.strictEqual(stripRawContext(42), 42);
      assert.strictEqual(stripRawContext("hello"), "hello");
    });

    it("returns objects without _rawContext unchanged", () => {
      const input = { card: { name: "test" } };
      const result = stripRawContext(input);
      assert.deepStrictEqual(result, input);
    });
  });
});
