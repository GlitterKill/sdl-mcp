import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { executeWorkflow } from "../../dist/code-mode/workflow-executor.js";
import type { ParsedWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";
import type { CodeModeConfig } from "../../dist/config/types.js";
import type { ToolContext } from "../../dist/server.js";
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

function createTestToolContext(sessionId: string): ToolContext {
  return {
    sendNotification: async () => {},
    signal: new AbortController().signal,
    sessionId,
  };
}

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
        code: z.string().min(1).describe("Required code value."),
      }),
      handler: async () => ({ ok: true }),
    },
    "runtime.execute": {
      schema: RuntimeExecuteRequestSchema,
      handler: async () => ({ ok: true }),
    },
    "test.results": {
      schema: z.object({}).passthrough(),
      handler: async () => ({
        results: Array.from({ length: 12 }, (_, index) => ({
          symbolId: `sym-${index}`,
          name: `name-${index}`,
          file: `src/file-${index}.ts`,
          kind: "function",
          summary: "long result payload ".repeat(12),
        })),
      }),
    },
    "test.fail": {
      schema: z.object({}).passthrough(),
      handler: async () => {
        throw new Error("Intentional test failure");
      },
    },
    "test.richFail": {
      schema: z.object({}).passthrough(),
      handler: async () => {
        throw Object.assign(new Error("Rich failure"), {
          classification: "ambiguous_input",
          fallbackTools: ["test.echo"],
          candidates: [
            {
              symbolId: "sym-1",
              kind: "function",
              file: "src/a.ts",
              nextCall: { tool: "symbol.getCard", args: { symbolId: "sym-1" } },
            },
          ],
        });
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
    assert.strictEqual(
      result.trace?.steps[0]?.tokens,
      result.results[0].tokens,
    );
    assert.strictEqual(result.trace?.totals.tokens, result.totalTokens);
  });


  it("uses workflow token budget as the default per-step response cap", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [{ fn: "testLarge", action: "test.large", args: {} }],
      budget: { maxTokens: 300 },
      onError: "continue",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );

    assert.strictEqual(result.results[0].status, "ok");
    assert.ok(result.results[0].truncatedResponse);
    assert.ok(result.totalTokens <= 300);
    assert.ok(result.results[0].truncatedResponse.continuationHandle);
  });

  it("treats workflow budget maxTokens as a maxTotalTokens alias", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testLarge", action: "test.large", args: {} },
        { fn: "testEcho", action: "test.echo", args: { message: "after" } },
      ],
      defaultMaxResponseTokens: 25,
      budget: { maxTokens: 20 },
      onError: "continue",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );

    assert.strictEqual(result.results[0].status, "ok");
    assert.strictEqual(result.results[1].status, "budget_exceeded");
    assert.match(result.results[1].error ?? "", /token budget exhausted/);
    assert.match(result.results[1].error ?? "", /budget\.maxTotalTokens/);
    assert.match(result.results[1].error ?? "", /budget\.maxTokens/);
  });

  it("requests JSON output for packed-capable steps referenced later", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        {
          fn: "symbolSearch",
          action: "symbol.search",
          args: { query: "target" },
        },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { message: "$0.results[0].symbolId" },
        },
      ],
      onError: "continue",
    };

    const actionMap = createMockActionMap();
    actionMap["symbol.search"].handler = async (args: unknown) => {
      const { wireFormat } = args as { wireFormat?: string };
      if (wireFormat !== "json") {
        return { results: "#PACKED/1 fake" };
      }
      return { results: [{ symbolId: "sym-target" }] };
    };

    const result = await executeWorkflow(request, actionMap, testConfig);

    assert.strictEqual(result.results[0].status, "ok");
    assert.strictEqual(result.results[1].status, "ok");
    assert.strictEqual(
      (result.results[1].result as { message?: unknown }).message,
      "sym-target",
    );
  });

  it("reuses etags automatically across workflows in the same session", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        {
          fn: "symbolGetCard",
          action: "symbol.getCard",
          args: { symbolId: "sym-cache" },
        },
      ],
      onError: "continue",
    };
    const actionMap = createMockActionMap();
    const seenArgs: Array<Record<string, unknown>> = [];
    actionMap["symbol.getCard"].handler = async (args: unknown) => {
      seenArgs.push({ ...(args as Record<string, unknown>) });
      return {
        card: { symbolId: "sym-cache", name: "sym-cache", kind: "function" },
        etag: "etag-sym-cache",
      };
    };
    const context = createTestToolContext("workflow-etag-session");

    const first = await executeWorkflow(request, actionMap, testConfig, context);
    const second = await executeWorkflow(request, actionMap, testConfig, context);

    assert.strictEqual(first.results[0].status, "ok");
    assert.strictEqual(second.results[0].status, "ok");
    assert.strictEqual(seenArgs[0].ifNoneMatch, undefined);
    assert.strictEqual(seenArgs[1].ifNoneMatch, "etag-sym-cache");
    assert.strictEqual(
      (first as unknown as Record<string, unknown>).etagCache,
      undefined,
    );
    assert.strictEqual(
      (second as unknown as Record<string, unknown>).etagCache,
      undefined,
    );
  });

  it("hides etag fields from verbose trace previews", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        {
          fn: "testEcho",
          action: "test.echo",
          args: { message: "trace" },
        },
      ],
      onError: "continue",
    };
    const actionMap = createMockActionMap();
    actionMap["test.echo"].handler = async () => ({
      ok: true,
      etag: "trace-etag",
      etagCache: { step: "cache-etag" },
      sliceEtag: "slice-etag",
      nested: { etag: "nested-etag" },
    });

    const result = await executeWorkflow(
      request,
      actionMap,
      testConfig,
      undefined,
      { level: "verbose", includeResolvedArgs: true },
    );

    const preview = result.trace?.steps[0]?.resultPreview ?? "";
    assert.doesNotMatch(preview, /etag|etagCache|sliceEtag|trace-etag|cache-etag|slice-etag|nested-etag/i);
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
    assert.strictEqual(
      result.trace?.steps[0]?.tokens,
      result.results[1].tokens,
    );
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

  it("onError=stop halts chain when a gateway action returns failure", async () => {
    const actionMap = createMockActionMap();
    (actionMap["runtime.execute"] as { handler: () => Promise<unknown> }).handler =
      async () => ({
        status: "failure",
        exitCode: 1,
        durationMs: 1,
        artifactHandle: "runtime-test-failure",
        stdoutSummary: "",
        stderrSummary: "boom",
      });

    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        {
          fn: "runtimeExecute",
          action: "runtime.execute",
          args: { runtime: "node", code: "throw new Error('boom')" },
        },
        { fn: "testEcho", action: "test.echo", args: { message: "ok" } },
      ],
      onError: "stop",
    };

    const result = await executeWorkflow(request, actionMap, testConfig);

    assert.strictEqual(result.results[0].status, "error");
    assert.match(result.results[0].error ?? "", /runtime.execute failed/);
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

  it("onError=continue skips dependent failed-reference steps but keeps independent siblings", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testFail", action: "test.fail", args: {} },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { message: "$0.missing" },
        },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { message: "independent" },
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
    assert.strictEqual(result.results[1].status, "skipped");
    assert.strictEqual(result.results[2].status, "ok");
    assert.strictEqual((result.results[1] as any).blockedByStep, 0);
    assert.strictEqual((result.results[1] as any).blockedByFn, "testFail");
    assert.match((result.results[1] as any).blockedByError, /Intentional test failure/);
    assert.match((result.results[1] as any).failureTrace?.message, /depends on failed step/);
    assert.match((result.results[0] as any).failureTrace?.message, /Intentional test failure/);
  });

  it("preserves structured gateway error details in failure traces", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [{ fn: "testRichFail", action: "test.richFail", args: {} }],
      onError: "continueAll",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );

    const trace = (result.results[0] as any).failureTrace;
    assert.deepStrictEqual(trace?.fallbackTools, ["test.echo"]);
    assert.strictEqual(trace?.details?.classification, "ambiguous_input");
    assert.deepStrictEqual(trace?.details?.candidates, [
      {
        symbolId: "sym-1",
        kind: "function",
        file: "src/a.ts",
        nextCall: { tool: "symbol.getCard", args: { symbolId: "sym-1" } },
      },
    ]);
  });

  it("onError=continueAll preserves legacy dependent ref-resolution errors", async () => {
    const request = {
      repoId: "test",
      steps: [
        { fn: "testFail", action: "test.fail", args: {} },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { message: "$0.missing" },
        },
      ],
      onError: "continueAll",
    } as ParsedWorkflowRequest;

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );

    assert.strictEqual(result.results[0].status, "error");
    assert.strictEqual(result.results[1].status, "error");
    assert.match(result.results[1].error ?? "", /Cannot navigate|Expected object|Field/);
  });

  it("dryRun validates static args and marks ref-backed schemas pending", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testAdd", action: "test.add", args: { a: 1 } },
        { fn: "testEcho", action: "test.echo", args: { message: "$0.sum" } },
      ],
      onError: "continue",
      dryRun: true,
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );
    const dryRun = result.dryRun as any;

    assert.strictEqual(dryRun.valid, false);
    assert.match(dryRun.validation[0].issues.join("\n"), /b|number|required/i);
    assert.match(dryRun.validation[0].fixHint, /sdl\.manual/);
    assert.strictEqual(dryRun.validation[1].pendingSchemaValidation, true);
  });

  it("workflowContinuationGet can page a structured path for later transforms", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testResults", action: "test.results", args: {}, maxResponseTokens: 50 },
        {
          fn: "workflowContinuationGet",
          action: "workflowContinuationGet",
          internal: true,
          args: {
            handle: "$0.truncatedResponse.continuationHandle",
            path: "results",
            offset: 2,
            limit: 3,
          },
        },
        {
          fn: "dataMap",
          action: "dataMap",
          internal: true,
          args: { input: "$1.data", fields: { name: "name" } },
        },
      ],
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
    assert.strictEqual((result.results[1].result as any).data.length, 3);
    assert.strictEqual((result.results[1].result as any).data[0].name, "name-2");
    assert.strictEqual(result.results[2].status, "ok");
    assert.deepStrictEqual(result.results[2].result, [
      { name: "name-2" },
      { name: "name-3" },
      { name: "name-4" },
    ]);
  });

});
