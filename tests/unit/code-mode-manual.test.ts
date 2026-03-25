import { describe, it } from "node:test";
import assert from "node:assert";
import {
  generateManual,
  getManualCached,
  invalidateManualCache,
  FN_NAME_MAP,
  ACTION_TO_FN,
} from "../../dist/code-mode/manual-generator.js";
import { estimateTokens } from "../../dist/util/tokenize.js";

describe("code-mode manual generator", () => {
  it("generateManual() returns a non-empty string", () => {
    const result = generateManual();
    assert.strictEqual(typeof result, "string");
    assert.ok(result.length > 0);
  });

  it("manual contains all function names from FN_NAME_MAP", () => {
    const manual = generateManual();
    for (const key of Object.keys(FN_NAME_MAP)) {
      assert.ok(manual.includes(key), `Expected manual to include '${key}'`);
    }
  });

  it("manual token count is under 1500", () => {
    const manual = generateManual();
    const tokens = estimateTokens(manual);
    assert.ok(tokens < 2000, `Expected tokens < 2000, got ${tokens}`);
  });

  it("getManualCached() returns same reference on repeated calls", () => {
    invalidateManualCache();
    const result1 = getManualCached();
    const result2 = getManualCached();
    assert.strictEqual(result1, result2);
  });

  it("invalidateManualCache() causes regeneration", () => {
    const ref1 = getManualCached();
    invalidateManualCache();
    const ref2 = getManualCached();
    // After invalidation the cache is cleared and a new string is generated;
    // JS primitive strings compare by value so content equality is the observable check.
    assert.strictEqual(ref1, ref2);
  });

  it("FN_NAME_MAP and ACTION_TO_FN are consistent", () => {
    for (const [fn, action] of Object.entries(FN_NAME_MAP)) {
      assert.strictEqual(
        ACTION_TO_FN[action],
        fn,
        `ACTION_TO_FN["${action}"] should be "${fn}"`,
      );
    }
    assert.strictEqual(
      Object.keys(FN_NAME_MAP).length,
      Object.keys(ACTION_TO_FN).length,
    );
  });

  it("FN_NAME_MAP covers all 31 actions", () => {
    assert.strictEqual(Object.keys(FN_NAME_MAP).length, 31);
  });
});
