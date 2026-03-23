import { describe, it } from "node:test";
import assert from "node:assert";
import { validateLadder } from "../../dist/code-mode/ladder-validator.js";
import type { ParsedChainStep } from "../../dist/code-mode/chain-parser.js";

describe("code-mode ladder validator", () => {
  it("correct order produces no warnings", () => {
    const steps: ParsedChainStep[] = [
      { fn: "symbolSearch", action: "symbol.search", args: { query: "test" } },
      {
        fn: "symbolGetCard",
        action: "symbol.getCard",
        args: { symbolId: "sym1" },
      },
      {
        fn: "codeSkeleton",
        action: "code.getSkeleton",
        args: { symbolId: "sym1" },
      },
      {
        fn: "codeHotPath",
        action: "code.getHotPath",
        args: { symbolId: "sym1", identifiersToFind: ["x"] },
      },
    ];
    const warnings = validateLadder(steps, [null, null, null, null], "warn");
    assert.deepStrictEqual(warnings, []);
  });

  it("skip card to needWindow produces warning", () => {
    const steps: ParsedChainStep[] = [
      {
        fn: "symbolGetCard",
        action: "symbol.getCard",
        args: { symbolId: "sym1" },
      },
      {
        fn: "codeNeedWindow",
        action: "code.needWindow",
        args: { symbolId: "sym1", reason: "test" },
      },
    ];
    // Rung 1 → rung 4, skipping rungs 2 and 3
    const warnings = validateLadder(steps, [null, null], "warn");
    assert.ok(warnings.length > 0);
    assert.ok(warnings[0].includes("sym1"));
  });

  it("two symbols tracked independently", () => {
    const steps: ParsedChainStep[] = [
      {
        fn: "symbolGetCard",
        action: "symbol.getCard",
        args: { symbolId: "sym1" },
      },
      {
        fn: "codeSkeleton",
        action: "code.getSkeleton",
        args: { symbolId: "sym2" },
      },
    ];
    // sym1 at rung 1, sym2 at rung 2 — but sym2 has no prior rung, so no warning
    const warnings = validateLadder(steps, [null, null], "warn");
    assert.deepStrictEqual(warnings, []);
  });

  it("non-ladder actions produce no warnings", () => {
    const steps: ParsedChainStep[] = [
      {
        fn: "memoryStore",
        action: "memory.store",
        args: { type: "note", title: "test", content: "test" },
      },
      { fn: "policyGet", action: "policy.get", args: {} },
      {
        fn: "codeNeedWindow",
        action: "code.needWindow",
        args: { symbolId: "sym1", reason: "test" },
      },
    ];
    // memory.store and policy.get are neutral; codeNeedWindow for sym1 has no prior rung
    const warnings = validateLadder(steps, [null, null, null], "warn");
    assert.deepStrictEqual(warnings, []);
  });

  it("mode off returns empty array", () => {
    const steps: ParsedChainStep[] = [
      {
        fn: "codeNeedWindow",
        action: "code.needWindow",
        args: { symbolId: "sym1" },
      },
    ];
    const warnings = validateLadder(steps, [null], "off");
    assert.deepStrictEqual(warnings, []);
  });

  it("mode warn returns warning strings", () => {
    const steps: ParsedChainStep[] = [
      {
        fn: "symbolGetCard",
        action: "symbol.getCard",
        args: { symbolId: "sym1" },
      },
      {
        fn: "codeNeedWindow",
        action: "code.needWindow",
        args: { symbolId: "sym1" },
      },
    ];
    // Rung 1 → rung 4, skipping 2 and 3
    const warnings = validateLadder(steps, [null, null], "warn");
    assert.ok(warnings.length > 0);
    assert.ok(warnings[0].includes("skips to rung"));
  });

  it("search to card to needWindow skipping skeleton produces warning", () => {
    const steps: ParsedChainStep[] = [
      { fn: "symbolSearch", action: "symbol.search", args: { query: "test" } },
      {
        fn: "symbolGetCard",
        action: "symbol.getCard",
        args: { symbolId: "sym1" },
      },
      {
        fn: "codeNeedWindow",
        action: "code.needWindow",
        args: { symbolId: "sym1" },
      },
    ];
    const warnings = validateLadder(steps, [null, null, null], "warn");
    assert.ok(warnings.length > 0);
  });

  it("steps without symbolId in args are neutral", () => {
    const steps: ParsedChainStep[] = [
      { fn: "repoOverview", action: "repo.overview", args: { level: "stats" } },
    ];
    const warnings = validateLadder(steps, [null], "warn");
    assert.deepStrictEqual(warnings, []);
  });
});
