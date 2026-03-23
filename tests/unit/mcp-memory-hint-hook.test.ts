import { describe, it } from "node:test";
import assert from "node:assert";
import { createMemoryHintHook } from "../../dist/mcp/hooks/memory-hint.js";

/**
 * Tests for src/mcp/hooks/memory-hint.ts — post-dispatch hook that
 * detects patterns worth remembering and appends _memoryHint.
 */

function makeContext(sessionId?: string) {
  return {
    sessionId: sessionId ?? "test-session",
    sendNotification: async () => {},
    signal: AbortSignal.timeout(5000),
  };
}

describe("Memory hint hook", () => {
  it("createMemoryHintHook returns a function", () => {
    const hook = createMemoryHintHook();
    assert.strictEqual(typeof hook, "function");
  });

  it("hook does not throw for basic tool call", async () => {
    const hook = createMemoryHintHook();
    const result = { symbols: [] };

    await assert.doesNotReject(
      hook("sdl.symbol.search", { query: "foo" }, result, makeContext()),
    );
  });

  it("does not add hint for first code.needWindow call", async () => {
    const hook = createMemoryHintHook();
    const result: Record<string, unknown> = { approved: true };

    await hook("sdl.code.needWindow", {}, result, makeContext("session-1w"));

    assert.strictEqual(result._memoryHint, undefined);
  });

  it("adds deep_debugging hint after 3+ code.needWindow calls", async () => {
    const hook = createMemoryHintHook();
    const ctx = makeContext("session-deep");

    // First 2 calls should not produce the hint yet
    for (let i = 0; i < 2; i++) {
      const r: Record<string, unknown> = {};
      await hook("sdl.code.needWindow", {}, r, ctx);
      assert.strictEqual(r._memoryHint, undefined, `call ${i + 1} should not hint yet`);
    }

    // 3rd call: recentCalls now has 3 entries (including this one), >= 3 triggers hint
    const result: Record<string, unknown> = {};
    await hook("sdl.code.needWindow", {}, result, ctx);

    assert.ok(result._memoryHint, "should have _memoryHint after 3 needWindow calls");
    const hint = result._memoryHint as Record<string, unknown>;
    assert.strictEqual(hint.suggestedType, "bugfix");
    assert.strictEqual(hint.pattern, "deep_debugging");
  });

  it("adds code_review hint for sdl.delta.get", async () => {
    const hook = createMemoryHintHook();
    const result: Record<string, unknown> = {};

    await hook("sdl.delta.get", {}, result, makeContext("session-review"));

    assert.ok(result._memoryHint, "should have _memoryHint for delta.get");
    const hint = result._memoryHint as Record<string, unknown>;
    assert.strictEqual(hint.suggestedType, "task_context");
    assert.strictEqual(hint.pattern, "code_review");
  });

  it("adds code_review hint for sdl.pr.risk.analyze", async () => {
    const hook = createMemoryHintHook();
    const result: Record<string, unknown> = {};

    await hook("sdl.pr.risk.analyze", {}, result, makeContext("session-pr"));

    assert.ok(result._memoryHint);
    const hint = result._memoryHint as Record<string, unknown>;
    assert.strictEqual(hint.pattern, "code_review");
  });

  it("does not repeat code_review hint in same session", async () => {
    const hook = createMemoryHintHook();
    const ctx = makeContext("session-no-repeat");

    const r1: Record<string, unknown> = {};
    await hook("sdl.delta.get", {}, r1, ctx);
    assert.ok(r1._memoryHint, "first call should produce hint");

    const r2: Record<string, unknown> = {};
    await hook("sdl.pr.risk.analyze", {}, r2, ctx);
    assert.strictEqual(
      r2._memoryHint,
      undefined,
      "second call should not repeat code_review hint",
    );
  });

  it("adds feature_complete hint for orchestrate with implement taskType", async () => {
    const hook = createMemoryHintHook();
    const result: Record<string, unknown> = {};

    await hook(
      "sdl.agent.orchestrate",
      { taskType: "implement" },
      result,
      makeContext("session-feat"),
    );

    assert.ok(result._memoryHint);
    const hint = result._memoryHint as Record<string, unknown>;
    assert.strictEqual(hint.suggestedType, "decision");
    assert.strictEqual(hint.pattern, "feature_complete");
  });

  it("does not add feature_complete hint for non-implement taskType", async () => {
    const hook = createMemoryHintHook();
    const result: Record<string, unknown> = {};

    await hook(
      "sdl.agent.orchestrate",
      { taskType: "debug" },
      result,
      makeContext("session-no-feat"),
    );

    assert.strictEqual(result._memoryHint, undefined);
  });

  it("adds missing_symbols hint for agent.feedback with missingSymbols", async () => {
    const hook = createMemoryHintHook();
    const result: Record<string, unknown> = {};

    await hook(
      "sdl.agent.feedback",
      { missingSymbols: ["sym-1", "sym-2"] },
      result,
      makeContext("session-missing"),
    );

    assert.ok(result._memoryHint);
    const hint = result._memoryHint as Record<string, unknown>;
    assert.strictEqual(hint.pattern, "missing_symbols");
    assert.strictEqual(hint.suggestedType, "bugfix");
  });

  it("does not add missing_symbols hint for empty missingSymbols array", async () => {
    const hook = createMemoryHintHook();
    const result: Record<string, unknown> = {};

    await hook(
      "sdl.agent.feedback",
      { missingSymbols: [] },
      result,
      makeContext("session-empty-missing"),
    );

    assert.strictEqual(result._memoryHint, undefined);
  });

  it("adds large_change hint for index.refresh with >10 changedFiles", async () => {
    const hook = createMemoryHintHook();
    const result: Record<string, unknown> = { changedFiles: 15 };

    await hook("sdl.index.refresh", {}, result, makeContext("session-large"));

    assert.ok(result._memoryHint);
    const hint = result._memoryHint as Record<string, unknown>;
    assert.strictEqual(hint.pattern, "large_change");
    assert.strictEqual(hint.suggestedType, "task_context");
  });

  it("does not add large_change hint for <=10 changedFiles", async () => {
    const hook = createMemoryHintHook();
    const result: Record<string, unknown> = { changedFiles: 5 };

    await hook("sdl.index.refresh", {}, result, makeContext("session-small"));

    assert.strictEqual(result._memoryHint, undefined);
  });

  it("different sessions track independently", async () => {
    const hook = createMemoryHintHook();

    const r1: Record<string, unknown> = {};
    await hook("sdl.delta.get", {}, r1, makeContext("session-A"));
    assert.ok(r1._memoryHint, "session-A should get hint");

    const r2: Record<string, unknown> = {};
    await hook("sdl.delta.get", {}, r2, makeContext("session-B"));
    assert.ok(r2._memoryHint, "session-B should also get hint independently");
  });

  it("does not add hint when result is not an object", async () => {
    const hook = createMemoryHintHook();

    // Pass null result - should not throw
    await assert.doesNotReject(
      hook("sdl.delta.get", {}, null, makeContext("session-null")),
    );
  });
});
