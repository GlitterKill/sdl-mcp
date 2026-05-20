import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { executeWorkflow } from "../../dist/code-mode/workflow-executor.js";
import type { ParsedWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";
import type { CodeModeConfig } from "../../dist/config/types.js";
import { RuntimeExecuteRequestSchema } from "../../dist/mcp/tools.js";
import { tokenAccumulator } from "../../dist/mcp/token-accumulator.js";
import { z } from "zod";

const originalSdlConfig = process.env.SDL_CONFIG;
const workflowTestConfigPath = resolve("config/sdlmcp.config.json");

before(() => {
  process.env.SDL_CONFIG = workflowTestConfigPath;
});

after(() => {
  if (originalSdlConfig === undefined) {
    delete process.env.SDL_CONFIG;
  } else {
    process.env.SDL_CONFIG = originalSdlConfig;
  }
});

// Default test config
const testConfig: CodeModeConfig = {
  enabled: true,
  exclusive: false,
  maxWorkflowSteps: 20,
  maxWorkflowTokens: 50000,
  maxWorkflowDurationMs: 60000,
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
    "test.periodicValidation": {
      schema: z.object({
        code: z
          .string()
          .min(1)
          .describe("Required code value."),
      }),
      handler: async () => ({ ok: true }),
    },
    "runtime.execute": {
      schema: RuntimeExecuteRequestSchema,
      handler: async () => ({ ok: true }),
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
    "test.large": {
      schema: z.object({}).passthrough(),
      handler: async () => ({ body: "x".repeat(5_000) }),
    },
    "test.largeString": {
      schema: z.object({}).passthrough(),
      handler: async () => "x".repeat(5_000),
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

describe("code-mode workflow executor", () => {
  it("single-step chain returns one result with status ok", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: { message: "hello" } },
      ],
      onError: "continue",
    };
    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].status, "ok");
  });

  it("multi-step chain with $N refs resolves correctly", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testAdd", action: "test.add", args: { a: 2, b: 3 } },
        { fn: "testEcho", action: "test.echo", args: { message: "$0" } },
      ],
      onError: "continue",
    };
    const result = await executeWorkflow(
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

  it("exposes a truncated step's continuation handle to later steps", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testLarge", action: "test.large", args: {} },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { message: "$0.truncatedResponse.continuationHandle" },
        },
      ],
      defaultMaxResponseTokens: 50,
      onError: "continue",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );

    assert.strictEqual(result.results[0].status, "ok");
    assert.ok(result.results[0].truncatedResponse?.continuationHandle);
    assert.strictEqual(result.results[1].status, "ok");
    assert.strictEqual(
      (result.results[1].result as { message?: unknown }).message,
      result.results[0].truncatedResponse?.continuationHandle,
    );
  });

  it("charges truncated response tokens against workflow budgets", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testLarge", action: "test.large", args: {} },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { message: "after truncation" },
        },
      ],
      defaultMaxResponseTokens: 25,
      budget: { maxTotalTokens: 100 },
      onError: "continue",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
      undefined,
      { level: "summary" },
    );

    assert.strictEqual(result.results[0].status, "ok");
    assert.ok(result.results[0].truncatedResponse);
    assert.strictEqual(result.results[1].status, "ok");
    assert.strictEqual(
      result.totalTokens,
      result.results.reduce((sum, step) => sum + step.tokens, 0),
    );
    assert.ok(result.totalTokens < 100);
    assert.strictEqual(result.trace?.steps[0]?.tokens, result.results[0].tokens);
    assert.strictEqual(result.trace?.totals.tokens, result.totalTokens);
  });


  it("records truncated response tokens in session usage", async () => {
    tokenAccumulator.reset();
    try {
      const request: ParsedWorkflowRequest = {
        repoId: "test",
        steps: [{ fn: "testLarge", action: "test.large", args: {} }],
        defaultMaxResponseTokens: 25,
        onError: "continue",
      };

      const result = await executeWorkflow(
        request,
        createMockActionMap(),
        testConfig,
      );
      const snapshot = tokenAccumulator.getSnapshot();

      assert.strictEqual(result.results[0].status, "ok");
      assert.ok(result.results[0].truncatedResponse);
      assert.strictEqual(snapshot.totalSdlTokens, result.totalTokens);
      assert.strictEqual(
        snapshot.toolBreakdown.find((entry) => entry.tool === "testLarge")
          ?.sdlTokens,
        result.results[0].tokens,
      );
    } finally {
      tokenAccumulator.reset();
    }
  });
  it("keeps trace total tokens aligned with onlyFinalResult suppression", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testLarge", action: "test.large", args: {} },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { message: "final response" },
        },
      ],
      defaultMaxResponseTokens: 25,
      onlyFinalResult: true,
      onError: "continue",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
      undefined,
      { level: "verbose" },
    );

    assert.strictEqual(result.intermediateResultsSuppressed, 1);
    assert.strictEqual(result.totalTokens, result.results[1].tokens);
    assert.strictEqual(result.trace?.steps[0]?.tokens, 0);
    assert.strictEqual(result.trace?.steps[0]?.resultPreview, undefined);
    assert.strictEqual(
      result.trace?.steps.reduce((sum, step) => sum + step.tokens, 0),
      result.totalTokens,
    );
    assert.strictEqual(result.trace?.totals.tokens, result.totalTokens);
  });

  it("keeps final trace entry when onlyFinalResult follows a soft skip", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        {
          fn: "memoryQuery",
          action: "memory.query",
          args: { query: "auth" },
          internal: false,
          skip: true,
          skipReason: "disabled function 'memory.query'",
        },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { message: "final response" },
        },
      ],
      onlyFinalResult: true,
      onError: "continue",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
      undefined,
      { level: "verbose" },
    );

    assert.strictEqual(result.intermediateResultsSuppressed, 1);
    assert.strictEqual(result.results[0].tokens, 0);
    assert.strictEqual(result.results[1].status, "ok");
    assert.strictEqual(result.trace?.steps.length, 1);
    assert.strictEqual(result.trace?.steps[0]?.stepIndex, 1);
    assert.strictEqual(result.trace?.steps[0]?.tokens, result.results[1].tokens);
    assert.doesNotMatch(
      result.trace?.steps[0]?.summary ?? "",
      /suppressed by onlyFinalResult/,
    );
    assert.strictEqual(result.trace?.totals.tokens, result.totalTokens);
  });
  it("exposes a truncated primitive step's continuation handle to later steps", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testLargeString", action: "test.largeString", args: {} },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { message: "$0.truncatedResponse.continuationHandle" },
        },
      ],
      defaultMaxResponseTokens: 50,
      onError: "continue",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );

    assert.strictEqual(result.results[0].status, "ok");
    assert.ok(result.results[0].truncatedResponse?.continuationHandle);
    assert.strictEqual(result.results[1].status, "ok");
    assert.strictEqual(
      (result.results[1].result as { message?: unknown }).message,
      result.results[0].truncatedResponse?.continuationHandle,
    );
  });

  it("budget token limit truncates remaining steps as budget_exceeded", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: { message: "a" } },
        { fn: "testEcho", action: "test.echo", args: { message: "b" } },
        { fn: "testEcho", action: "test.echo", args: { message: "c" } },
      ],
      budget: { maxTotalTokens: 1 }, // Very low budget — first step exhausts it
      onError: "continue",
    };
    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.truncated, true);
    assert.ok(result.results.some((r) => r.status === "budget_exceeded"));
  });

  it("budget step limit truncates remaining steps", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: {} },
        { fn: "testEcho", action: "test.echo", args: {} },
        { fn: "testEcho", action: "test.echo", args: {} },
      ],
      budget: { maxSteps: 1 },
      onError: "continue",
    };
    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results[0].status, "ok");
    assert.strictEqual(result.results[1].status, "budget_exceeded");
    assert.strictEqual(result.results[2].status, "budget_exceeded");
    assert.strictEqual(result.truncated, true);
  });

  it("does not report truncated when maxSteps exactly matches executed steps", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: { message: "a" } },
        { fn: "testEcho", action: "test.echo", args: { message: "b" } },
      ],
      budget: { maxSteps: 2 },
      onError: "continue",
    };
    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results.length, 2);
    assert.ok(result.results.every((step) => step.status === "ok"));
    assert.strictEqual(result.truncated, false);
  });

  it("error with onError=continue marks step as error and continues", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testFail", action: "test.fail", args: {} },
        { fn: "testEcho", action: "test.echo", args: { message: "ok" } },
      ],
      onError: "continue",
    };
    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results[0].status, "error");
    assert.strictEqual(result.results[1].status, "ok");
  });

  it("does not double punctuate validation guidance", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        {
          fn: "runtimeExecute",
          action: "runtime.execute",
          args: { runtime: "shell", args: ["node", "--version"] },
        },
      ],
      onError: "continue",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );

    assert.strictEqual(result.results[0].status, "error");
    assert.doesNotMatch(result.results[0].error ?? "", /\.\. Use sdl\.manual/);
  });

  it("error with onError=stop halts chain", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testFail", action: "test.fail", args: {} },
        { fn: "testEcho", action: "test.echo", args: { message: "ok" } },
      ],
      onError: "stop",
    };
    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results[0].status, "error");
    assert.strictEqual(result.results[1].status, "skipped");
  });

  it("results array length matches input steps length", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: {} },
        { fn: "testEcho", action: "test.echo", args: {} },
      ],
      onError: "continue",
    };
    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results.length, 2);
  });

  it("totalTokens accumulates across steps", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: { message: "hello" } },
        { fn: "testEcho", action: "test.echo", args: { message: "world" } },
      ],
      onError: "continue",
    };
    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.ok(result.totalTokens > 0, "totalTokens should be positive");
  });

  it("durationMs reflects wall-clock time", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [{ fn: "testSlow", action: "test.slow", args: {} }],
      onError: "continue",
    };
    const result = await executeWorkflow(
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
