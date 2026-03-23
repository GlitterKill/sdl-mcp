import { describe, it } from "node:test";
import assert from "node:assert";
import { executeChain } from "../../dist/code-mode/chain-executor.js";
import type { ParsedChainRequest } from "../../dist/code-mode/chain-parser.js";
import type { CodeModeConfig } from "../../dist/config/types.js";
import { z } from "zod";

// Default test config
const testConfig: CodeModeConfig = {
  enabled: true,
  exclusive: false,
  maxChainSteps: 20,
  maxChainTokens: 50000,
  maxChainDurationMs: 60000,
  ladderValidation: "warn",
  etagCaching: true,
};

// Mock action map with test actions
function createMockActionMap() {
  return {
    "test.echo": {
      // z.unknown().optional() to accept any value for message (including resolved refs)
      schema: z.object({ message: z.unknown().optional() }).passthrough(),
      handler: async (args: unknown) => args,
    },
    "test.add": {
      schema: z.object({ a: z.number(), b: z.number() }),
      handler: async (args: unknown) => {
        const { a, b } = args as { a: number; b: number };
        return { sum: a + b };
      },
    },
    "test.fail": {
      schema: z.object({}).passthrough(),
      handler: async () => {
        throw new Error("Intentional test failure");
      },
    },
    "test.slow": {
      schema: z.object({}).passthrough(),
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { delayed: true };
      },
    },
    // Real action names for the router to accept
    "symbol.search": {
      schema: z.object({ query: z.string() }).passthrough(),
      handler: async (args: unknown) => {
        const { query } = args as { query: string };
        return {
          symbols: [
            {
              symbolId: `sym-${query}`,
              name: query,
              kind: "function",
              file: "test.ts",
            },
          ],
        };
      },
    },
    "symbol.getCard": {
      schema: z.object({ symbolId: z.string() }).passthrough(),
      handler: async (args: unknown) => {
        const { symbolId } = args as { symbolId: string };
        return {
          card: {
            symbolId,
            name: symbolId,
            kind: "function",
            signature: "test()",
          },
          etag: `etag-${symbolId}`,
        };
      },
    },
    "code.getSkeleton": {
      schema: z.object({ symbolId: z.string().optional() }).passthrough(),
      handler: async () => ({ skeleton: "function test() { /* ... */ }" }),
    },
  };
}

describe("code-mode chain executor", () => {
  it("single-step chain returns one result with status ok", async () => {
    const request: ParsedChainRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: { message: "hello" } },
      ],
      onError: "continue",
    };
    const result = await executeChain(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].status, "ok");
  });

  it("multi-step chain with $N refs resolves correctly", async () => {
    const request: ParsedChainRequest = {
      repoId: "test",
      steps: [
        { fn: "testAdd", action: "test.add", args: { a: 2, b: 3 } },
        { fn: "testEcho", action: "test.echo", args: { message: "$0" } },
      ],
      onError: "continue",
    };
    const result = await executeChain(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results[0].status, "ok");
    assert.strictEqual(result.results[1].status, "ok");
    assert.deepStrictEqual(
      (result.results[0].result as Record<string, unknown>).sum,
      5,
    );
  });

  it("budget token limit truncates remaining steps as budget_exceeded", async () => {
    const request: ParsedChainRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: { message: "a" } },
        { fn: "testEcho", action: "test.echo", args: { message: "b" } },
        { fn: "testEcho", action: "test.echo", args: { message: "c" } },
      ],
      budget: { maxTotalTokens: 1 }, // Very low budget — first step exhausts it
      onError: "continue",
    };
    const result = await executeChain(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.truncated, true);
    assert.ok(result.results.some((r) => r.status === "budget_exceeded"));
  });

  it("budget step limit truncates remaining steps", async () => {
    const request: ParsedChainRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: {} },
        { fn: "testEcho", action: "test.echo", args: {} },
        { fn: "testEcho", action: "test.echo", args: {} },
      ],
      budget: { maxSteps: 1 },
      onError: "continue",
    };
    const result = await executeChain(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results[0].status, "ok");
    assert.strictEqual(result.results[1].status, "budget_exceeded");
    assert.strictEqual(result.results[2].status, "budget_exceeded");
    assert.strictEqual(result.truncated, true);
  });

  it("error with onError=continue marks step as error and continues", async () => {
    const request: ParsedChainRequest = {
      repoId: "test",
      steps: [
        { fn: "testFail", action: "test.fail", args: {} },
        { fn: "testEcho", action: "test.echo", args: { message: "ok" } },
      ],
      onError: "continue",
    };
    const result = await executeChain(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results[0].status, "error");
    assert.strictEqual(result.results[1].status, "ok");
  });

  it("error with onError=stop halts chain", async () => {
    const request: ParsedChainRequest = {
      repoId: "test",
      steps: [
        { fn: "testFail", action: "test.fail", args: {} },
        { fn: "testEcho", action: "test.echo", args: { message: "ok" } },
      ],
      onError: "stop",
    };
    const result = await executeChain(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results[0].status, "error");
    assert.strictEqual(result.results[1].status, "skipped");
  });

  it("results array length matches input steps length", async () => {
    const request: ParsedChainRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: {} },
        { fn: "testEcho", action: "test.echo", args: {} },
      ],
      onError: "continue",
    };
    const result = await executeChain(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results.length, 2);
  });

  it("totalTokens accumulates across steps", async () => {
    const request: ParsedChainRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: { message: "hello" } },
        { fn: "testEcho", action: "test.echo", args: { message: "world" } },
      ],
      onError: "continue",
    };
    const result = await executeChain(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.ok(result.totalTokens > 0, "totalTokens should be positive");
  });

  it("durationMs reflects wall-clock time", async () => {
    const request: ParsedChainRequest = {
      repoId: "test",
      steps: [{ fn: "testSlow", action: "test.slow", args: {} }],
      onError: "continue",
    };
    const result = await executeChain(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.ok(
      result.durationMs >= 50,
      "durationMs should be at least 50ms for slow step",
    );
  });
});
