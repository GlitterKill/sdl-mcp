import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  maybeStoreLargeResponse,
  readResponseArtifact,
} from "../../dist/runtime/response-artifacts.js";
import { executeWorkflow } from "../../dist/code-mode/workflow-executor.js";
import {
  clearContinuationStore,
  getContinuation,
  storeContinuation,
  truncateStepResult,
} from "../../dist/code-mode/workflow-truncation.js";
import * as responseProjection from "../../dist/mcp/context-response-projection.js";
import type { ParsedWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";
import type { CodeModeConfig } from "../../dist/config/types.js";
import type { ToolContext } from "../../dist/server.js";
import { RuntimeExecuteRequestSchema } from "../../dist/mcp/tools.js";
import { tokenAccumulator } from "../../dist/mcp/token-accumulator.js";
import {
  RUNTIME_REPOSITORY_INSPECTION_DISALLOWED,
  RuntimeRepositoryInspectionError,
} from "../../dist/domain/errors.js";
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
    "repo.overview": {
      schema: z.object({}).passthrough(),
      handler: async () => ({
        repoId: "test",
        generatedAt: "2026-07-18T12:00:00.000Z",
        stableRepositoryData: {
          marker: "stable-repository-data",
          body: "stable ".repeat(1_000),
        },
        durationMs: 42,
        absolutePath: "F:/Claude/projects/sdl-mcp/sdl-mcp",
        _rawContext: { timing: { totalMs: 12 } },
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
    "test.typedFail": {
      schema: z.object({}).passthrough(),
      handler: async () => {
        throw new RuntimeRepositoryInspectionError();
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
    assert.strictEqual("projectionOptions" in request.steps[0], false);
    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].status, "ok");
  });

  it("executes action.search as a workflow step via the meta handler", async () => {
    const { handleActionSearch } = await import(
      "../../dist/code-mode/index.js"
    );
    const { META_ACTION_SEARCH_SCHEMA } = await import(
      "../../dist/code-mode/action-catalog.js"
    );
    const actionMap = {
      ...createMockActionMap(),
      "action.search": {
        schema: META_ACTION_SEARCH_SCHEMA,
        handler: async (args: unknown) => handleActionSearch(args, {}),
      },
    };
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        {
          fn: "actionSearch",
          action: "action.search",
          args: { query: "runtime execute", limit: 3 },
        },
      ],
      onError: "stop",
    };
    const result = await executeWorkflow(request, actionMap, testConfig);
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].status, "ok");
    const stepResult = result.results[0].result as Record<string, unknown>;
    assert.ok(Array.isArray(stepResult.actions));
    assert.ok((stepResult.actions as unknown[]).length > 0);
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

  it("projects child results before continuation storage deterministically", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [{ fn: "repoOverview", action: "repo.overview", args: {}, maxResponseTokens: 50 }],
      onError: "stop",
    };
    const projectResult = (_fn: string, result: unknown) => {
      const { generatedAt: _generatedAt, durationMs: _durationMs, absolutePath: _absolutePath, _rawContext, ...stable } = result as Record<string, unknown>;
      return stable;
    };

    const first = await executeWorkflow(request, createMockActionMap(), testConfig, undefined, undefined, projectResult);
    const firstHandle = first.results[0].truncatedResponse?.continuationHandle;
    assert.ok(firstHandle);
    const firstJson = JSON.stringify(getContinuation(firstHandle)?.data);
    assert.doesNotMatch(firstJson, /generatedAt|durationMs|absolutePath|_rawContext|totalMs/);
    assert.match(firstJson, /stable-repository-data/);

    const second = await executeWorkflow(request, createMockActionMap(), testConfig, undefined, undefined, projectResult);
    const secondHandle = second.results[0].truncatedResponse?.continuationHandle;
    assert.ok(secondHandle);
    assert.equal(JSON.stringify(getContinuation(secondHandle)?.data), firstJson);
  });

  it("keeps raw child results available to later $N references", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "repoOverview", action: "repo.overview", args: {} },
        { fn: "testEcho", action: "test.echo", args: { message: "$0.generatedAt" } },
      ],
      onError: "stop",
    };
    const result = await executeWorkflow(request, createMockActionMap(), testConfig, undefined, undefined, (fn, childResult) => fn === "repoOverview" ? {} : childResult);
    assert.equal((result.results[1].result as { message: string }).message, "2026-07-18T12:00:00.000Z");
  });

  it("projects workflow child results idempotently", () => {
    const projector = (responseProjection as Record<string, unknown>).projectWorkflowChildResultForModel;
    assert.equal(typeof projector, "function");
    if (typeof projector !== "function") return;
    const raw = { repoId: "test", generatedAt: "fixed", durationMs: 42, stable: { marker: "kept" } };
    const once = projector("repoOverview", raw, {}, {});
    assert.deepEqual(projector("repoOverview", once, {}, {}), once);
    assert.deepEqual(
      projector("repoOverview", raw, { detail: "full", includeTelemetry: true }, {}),
      raw,
    );
  });

  it("projects semantic workflow-child status idempotently", () => {
    const projector = (responseProjection as Record<string, unknown>)
      .projectWorkflowChildResultForModel;
    assert.equal(typeof projector, "function");
    if (typeof projector !== "function") return;
    const canonical = {
      ok: true,
      enabled: true,
      selections: [
        {
          languageId: "typescript",
          selected: {
            providerType: "scip",
            providerId: "scip",
            canAffectPass2: true,
          },
          skipped: [],
        },
      ],
      lastRuns: [
        {
          providerType: "scip",
          providerId: "scip",
          languages: ["typescript"],
          status: "completed",
          symbolsMatched: 3,
          edgesCreated: 2,
          diagnosticsCount: 0,
        },
      ],
    };

    const once = projector(
      "semanticEnrichmentStatus",
      canonical,
      { detail: "compact" },
      {},
    );
    assert.deepEqual(
      projector(
        "semanticEnrichmentStatus",
        once,
        { detail: "compact" },
        {},
      ),
      once,
    );
  });

  it("projects usage workflow-child status idempotently", () => {
    const projector = (responseProjection as Record<string, unknown>)
      .projectWorkflowChildResultForModel;
    assert.equal(typeof projector, "function");
    if (typeof projector !== "function") return;
    const canonical = {
      session: {
        totalSdlTokens: 75,
        totalRawEquivalent: 300,
        totalSavedTokens: 225,
        overallSavingsPercent: 75,
        callCount: 1,
        toolBreakdown: [
          {
            tool: "sdl.context",
            sdlTokens: 75,
            rawEquivalent: 300,
            savedTokens: 225,
            callCount: 1,
          },
        ],
      },
    };

    const once = projector(
      "usageStats",
      canonical,
      { detail: "compact" },
      {},
    );
    assert.deepEqual(
      projector("usageStats", once, { detail: "compact" }, {}),
      once,
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

  it("charges raw child tokens to the workflow budget when model output is projected", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "repoOverview", action: "repo.overview", args: {}, maxResponseTokens: 50 },
        { fn: "testEcho", action: "test.echo", args: { message: "must be skipped" } },
      ],
      budget: { maxTotalTokens: 500 },
      onError: "continue",
    };
    const projector = (responseProjection as {
      projectWorkflowChildResultForModel: (fn: string, result: unknown, workflowArgs: Record<string, unknown>, args: Record<string, unknown>) => unknown;
    }).projectWorkflowChildResultForModel;

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
      undefined,
      undefined,
      (fn, childResult, args) => projector(fn, childResult, {}, args),
    );

    assert.ok(result.results[0].truncatedResponse);
    assert.ok(result.results[0].tokens > 500);
    assert.strictEqual(result.results[1].status, "budget_exceeded");
  });

  it("keeps raw child data and tokens in verbose workflow traces", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [{ fn: "repoOverview", action: "repo.overview", args: {}, maxResponseTokens: 50 }],
      onError: "stop",
    };
    const projector = (responseProjection as {
      projectWorkflowChildResultForModel: (fn: string, result: unknown, workflowArgs: Record<string, unknown>, args: Record<string, unknown>) => unknown;
    }).projectWorkflowChildResultForModel;

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
      undefined,
      { level: "verbose", maxPreviewTokens: 500 },
      (fn, childResult, args) => projector(fn, childResult, {}, args),
    );

    assert.match(result.trace?.steps[0]?.resultPreview ?? "", /generatedAt/);
    assert.strictEqual(result.trace?.steps[0]?.tokens, result.results[0].tokens);
    assert.ok((result.trace?.steps[0]?.tokens ?? 0) > 500);
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
    assert.ok((result.trace?.steps[0]?.tokens ?? 0) > result.results[0].tokens);
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

  it("treats workflow budget maxTokens as the total response cap", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testLarge", action: "test.large", args: {} },
        { fn: "testEcho", action: "test.echo", args: { message: "after" } },
      ],
      defaultMaxResponseTokens: 25,
      budget: { maxTokens: 60 },
      onError: "continue",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );

    assert.strictEqual(result.results[0].status, "ok");
    assert.strictEqual(result.results[1].status, "ok");
    assert.ok(result.results[0].truncatedResponse);
    assert.ok(result.totalTokens <= 60);
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

    assert.deepStrictEqual(
      result.results.map((step) => step.stepIndex),
      [1],
    );
    assert.strictEqual(result.intermediateResultsSuppressed, 1);
    assert.strictEqual(result.totalTokens, result.results[0].tokens);
    assert.strictEqual(result.trace?.steps[0]?.tokens, 0);
    assert.strictEqual(result.trace?.steps[0]?.resultPreview, undefined);
    assert.match(
      result.trace?.steps[0]?.summary ?? "",
      /suppressed by onlyFinalResult/,
    );
    assert.strictEqual(
      result.trace?.steps.reduce((sum, step) => sum + step.tokens, 0),
      result.totalTokens,
    );
    assert.strictEqual(result.trace?.totals.tokens, result.totalTokens);
  });

  it("retains a soft-skip error while keeping only the final success trace", async () => {
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

    assert.strictEqual(result.intermediateResultsSuppressed, undefined);
    assert.deepStrictEqual(
      result.results.map((step) => step.stepIndex),
      [0, 1],
    );
    assert.strictEqual(result.results[0].status, "error");
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

  it("retains prior failures while suppressing successful intermediate results", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        { fn: "testEcho", action: "test.echo", args: { message: "omit me" } },
        { fn: "testFail", action: "test.fail", args: {} },
        { fn: "testEcho", action: "test.echo", args: { message: "final response" } },
      ],
      onlyFinalResult: true,
      onError: "continueAll",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
      undefined,
      { level: "verbose" },
    );

    assert.deepStrictEqual(
      result.results.map((step) => [step.stepIndex, step.status]),
      [[1, "error"], [2, "ok"]],
    );
    assert.strictEqual(result.intermediateResultsSuppressed, 1);
    assert.strictEqual(
      result.totalTokens,
      result.results.reduce((sum, step) => sum + step.tokens, 0),
    );
    assert.strictEqual(result.trace?.steps.length, 3);
    assert.strictEqual(result.trace?.steps[0]?.tokens, 0);
    assert.strictEqual(result.trace?.steps[0]?.resultPreview, undefined);
    assert.match(
      result.trace?.steps[0]?.summary ?? "",
      /suppressed by onlyFinalResult/,
    );
    assert.match(result.trace?.steps[1]?.summary ?? "", /Intentional test failure/);
    assert.doesNotMatch(
      result.trace?.steps[1]?.summary ?? "",
      /suppressed by onlyFinalResult/,
    );
    assert.strictEqual(
      result.trace?.steps.reduce((sum, step) => sum + step.tokens, 0),
      result.totalTokens,
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

  it("preserves typed domain errors while honoring each onError mode", async () => {
    const expectedError = {
      message: RUNTIME_REPOSITORY_INSPECTION_DISALLOWED,
      code: "POLICY_ERROR",
      classification: "policy_denied",
      retryable: false,
    };
    assert.deepStrictEqual(
      responseProjection.projectToolResultForModelContent(
        "sdl.runtime.execute",
        { error: expectedError },
        { repoId: "test", runtime: "node", args: ["--version"] },
      ),
      { error: expectedError },
    );

    for (const [onError, expectedStatuses] of [
      ["stop", ["error", "skipped", "skipped"]],
      ["continue", ["error", "ok", "skipped"]],
      ["continueAll", ["error", "ok", "error"]],
    ] as const) {
      const request: ParsedWorkflowRequest = {
        repoId: "test",
        steps: [
          { fn: "testTypedFail", action: "test.typedFail", args: {} },
          { fn: "testEcho", action: "test.echo", args: { message: "independent" } },
          { fn: "testEcho", action: "test.echo", args: { message: "$0.message" } },
        ],
        onError,
      };

      const result = await executeWorkflow(
        request,
        createMockActionMap(),
        testConfig,
      );

      assert.deepStrictEqual(
        result.results.map((step) => step.status),
        expectedStatuses,
        onError,
      );
      assert.deepStrictEqual(result.results[0].error, expectedError, onError);
      const projected = responseProjection.projectToolResultForModelContent(
        "sdl.workflow",
        result,
        { repoId: "test", steps: request.steps, onError },
      ) as { results: Array<Record<string, unknown>> };
      assert.deepStrictEqual(projected.results[0], {
        stepIndex: 0,
        fn: "testTypedFail",
        status: "error",
        error: expectedError,
      }, onError);
      if (onError === "continue") {
        assert.strictEqual(result.results[2].blockedByStep, 0);
        assert.strictEqual(result.results[2].blockedByFn, "testTypedFail");
        assert.strictEqual(
          result.results[2].blockedByError,
          RUNTIME_REPOSITORY_INSPECTION_DISALLOWED,
        );
      }
      if (onError === "continueAll") {
        assert.strictEqual(
          result.results[2].error,
          "Cannot navigate into null/undefined at segment 'message' in reference '$0.message'",
        );
      }
    }
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

  it("preserves invalid response.get jsonPath recovery in failure traces", async () => {
    const artifactBaseDir = mkdtempSync(join(tmpdir(), "sdl-workflow-response-"));
    try {
      const stored = await maybeStoreLargeResponse({
        repoId: "test",
        toolName: "sdl.context",
        payload: {
          status: "complete",
          evidence: [{ rung: "card", symbolId: "symbol:target" }],
        },
        responseMode: "handle",
        artifactBaseDir,
        entropy: () => "0123456789abcdef",
      });
      assert.strictEqual(stored.responseMode, "handle");
      const handle = stored.payload.handle;
      const actionMap = {
        ...createMockActionMap(),
        "response.get": {
          schema: z.object({
            repoId: z.string(),
            handle: z.string(),
            jsonPath: z.string(),
          }),
          handler: async (args: unknown) =>
            readResponseArtifact({
              ...(args as { repoId: string; handle: string; jsonPath: string }),
              artifactBaseDir,
            }),
        },
      };
      const request: ParsedWorkflowRequest = {
        repoId: "test",
        steps: [
          {
            fn: "responseGet",
            action: "response.get",
            args: { handle, jsonPath: "missing" },
          },
        ],
        onError: "continueAll",
      };

      const first = await executeWorkflow(request, actionMap, testConfig);
      const second = await executeWorkflow(request, actionMap, testConfig);
      const trace = first.results[0].failureTrace;

      assert.strictEqual(Array.isArray(first), false);
      assert.strictEqual(first.results[0].status, "error");
      assert.deepStrictEqual(trace?.details?.details, [
        "Available top-level keys: evidence, status",
      ]);
      assert.deepStrictEqual(trace?.details?.nextCalls, [
        {
          action: "response.get",
          args: {
            repoId: "test",
            handle,
            jsonPath: "evidence",
            offset: 0,
            limit: 5,
          },
        },
      ]);
      assert.deepStrictEqual(trace?.details, second.results[0].failureTrace?.details);
    } finally {
      rmSync(artifactBaseDir, { recursive: true, force: true });
    }
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


  it("keeps failed gateway result fields available to later references", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        {
          fn: "testEcho",
          action: "test.echo",
          args: {
            status: "failure",
            error: "boom",
            artifactHandle: "artifact-test-failure",
          },
        },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { message: "$0.artifactHandle" },
        },
      ],
      onError: "continueAll",
    };

    const result = await executeWorkflow(request, createMockActionMap(), testConfig);

    assert.strictEqual(result.results[0].status, "error");
    assert.strictEqual(result.results[1].status, "ok");
    assert.deepStrictEqual(result.results[1].result, {
      message: "artifact-test-failure",
      repoId: "test",
    });
  });

  it("defers no-projector continuation storage to the public family projection", async () => {
    const rawResult = {
      repoId: "test",
      lastIndexedAt: "private-compact-omission",
      rootAvailability: {
        status: "available",
        detail: "v".repeat(3_000),
      },
      filesIndexed: 1,
      symbolsIndexed: 2,
    };
    const actionMap = {
      ...createMockActionMap(),
      "repo.status": {
        schema: z.object({}).passthrough(),
        handler: async () => rawResult,
      },
    };
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [{
        fn: "repoStatus",
        action: "repo.status",
        args: {},
        maxResponseTokens: 50,
      }],
      onError: "stop",
    };

    const executed = await executeWorkflow(request, actionMap, testConfig);
    const executorHandle =
      executed.results[0].truncatedResponse?.continuationHandle;
    assert.ok(executorHandle);
    const projected = responseProjection.projectToolResultForModelContent(
      "sdl.workflow",
      executed,
      { repoId: "test", detail: "compact", steps: request.steps },
    ) as {
      results: Array<{
        result: unknown;
        nextAction?: {
          args: { steps: Array<{ args: { handle: string } }> };
        };
      }>;
    };
    const publicStep = projected.results[0];
    const publicHandle =
      publicStep.nextAction?.args.steps[0].args.handle;
    assert.ok(publicHandle);
    assert.equal(publicHandle, executorHandle);
    const stored = getContinuation(publicHandle)?.data;

    assert.equal(
      (executed.results[0].result as Record<string, unknown>).lastIndexedAt,
      "private-compact-omission",
    );
    assert.doesNotMatch(
      JSON.stringify(publicStep.result),
      /lastIndexedAt|private-compact-omission/,
    );
    assert.doesNotMatch(
      JSON.stringify(stored),
      /lastIndexedAt|private-compact-omission/,
    );
  });

  it("sanitizes an existing handle when family projection shrinks below the cap", async () => {
    const secret = "private-compact-omission".repeat(200);
    const actionMap = {
      ...createMockActionMap(),
      "repo.status": {
        schema: z.object({}).passthrough(),
        handler: async () => ({
          repoId: "test",
          lastIndexedAt: secret,
          rootAvailability: { status: "available" },
          filesIndexed: 1,
          symbolsIndexed: 2,
        }),
      },
    };
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [{
        fn: "repoStatus",
        action: "repo.status",
        args: {},
        maxResponseTokens: 50,
      }],
      onError: "stop",
    };

    const executed = await executeWorkflow(request, actionMap, testConfig);
    const handle = executed.results[0].truncatedResponse?.continuationHandle;
    assert.ok(handle);
    const projected = responseProjection.projectToolResultForModelContent(
      "sdl.workflow",
      executed,
      { repoId: "test", detail: "compact", steps: request.steps },
    ) as {
      results: Array<{ result: unknown; nextAction?: unknown }>;
    };
    const publicStep = projected.results[0];

    assert.equal(publicStep.nextAction, undefined);
    assert.doesNotMatch(JSON.stringify(publicStep.result), /lastIndexedAt/);
    assert.doesNotMatch(JSON.stringify(getContinuation(handle)?.data), /lastIndexedAt/);
  });

  it("upserts an evicted explicit handle under the capacity policy", () => {
    clearContinuationStore();
    try {
      const handle = storeContinuation({ secret: true });
      const fillerHandles = Array.from({ length: 109 }, (_, index) =>
        storeContinuation({ index })
      );
      assert.equal(getContinuation(handle), null);

      const replacement = { safe: "x".repeat(500) };
      const truncated = truncateStepResult(replacement, 1, handle);
      assert.equal(truncated.handle, handle);
      assert.deepStrictEqual(getContinuation(handle)?.data, replacement);
      assert.equal(
        fillerHandles.filter((candidate) => getContinuation(candidate)).length
          + 1,
        91,
      );
    } finally {
      clearContinuationStore();
    }
  });

  it("returns an explanatory truncation preview when maxResponseTokens is too low", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        {
          fn: "testResults",
          action: "test.results",
          args: {},
          maxResponseTokens: 1,
        },
      ],
      onError: "stop",
    };

    const result = await executeWorkflow(request, createMockActionMap(), testConfig);
    const step = result.results[0];
    const canonical = step.result as { results: unknown[] };
    const projected = responseProjection.projectToolResultForModelContent(
      "sdl.workflow",
      result,
      { repoId: "test", detail: "compact", steps: request.steps },
    ) as { results: Array<{ result: unknown }> };
    const publicResult = projected.results[0].result;
    const handle = step.truncatedResponse?.continuationHandle;
    assert.ok(handle);
    const stored = getContinuation(handle)?.data as { results: unknown[] };

    assert.strictEqual(step.status, "ok");
    assert.equal(canonical.results.length, 12);
    assert.equal(stored.results.length, 12);
    assert.match(JSON.stringify(publicResult), /truncated/i);
    assert.ok(
      JSON.stringify(publicResult).length < JSON.stringify(canonical).length,
    );
  });

  it("preserves real empty fields in truncation previews", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [
        {
          fn: "testEcho",
          action: "test.echo",
          args: { emptyList: [], emptyObject: {}, body: "x".repeat(5_000) },
          maxResponseTokens: 40,
        },
      ],
      onError: "stop",
    };

    const result = await executeWorkflow(request, createMockActionMap(), testConfig);
    const step = result.results[0];
    const stepResult = step.result as Record<string, unknown>;
    const projected = responseProjection.projectToolResultForModelContent(
      "sdl.workflow",
      result,
      { repoId: "test", detail: "compact", steps: request.steps },
    ) as { results: Array<{ result: Record<string, unknown> }> };
    const publicResult = projected.results[0].result;
    const handle = step.truncatedResponse?.continuationHandle;
    assert.ok(handle);
    const stored = getContinuation(handle)?.data as Record<string, unknown>;
    const unbounded = structuredClone(result);
    delete unbounded.results[0].truncatedResponse;
    const effective = responseProjection.projectToolResultForModelContent(
      "sdl.workflow",
      unbounded,
      { repoId: "test", detail: "compact", steps: request.steps },
    ) as { results: Array<{ result: Record<string, unknown> }> };
    const effectiveResult = effective.results[0].result;

    assert.deepStrictEqual(stepResult.emptyList, []);
    assert.deepStrictEqual(stepResult.emptyObject, {});
    assert.equal(stepResult.body, "x".repeat(5_000));
    assert.match(String(publicResult.body), /truncated/i);
    assert.deepStrictEqual(stored, effectiveResult);
    assert.deepStrictEqual(stored.emptyList, []);
  });

  it("dryRun validates workflow-injected repoId", async () => {
    const actionMap = {
      ...createMockActionMap(),
      "repo.status": {
        schema: z.object({ repoId: z.string() }),
        handler: async () => assert.fail("dryRun must not execute handlers"),
      },
    };
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      steps: [{ fn: "repoStatus", action: "repo.status", args: {} }],
      onError: "continue",
      dryRun: true,
    };

    const result = await executeWorkflow(request, actionMap, testConfig);

    assert.strictEqual(result.dryRun?.valid, true);
    assert.deepStrictEqual(result.dryRun?.validation[0].issues, []);
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
    assert.deepStrictEqual(result.results, [
      {
        stepIndex: 0,
        fn: "testAdd",
        result: null,
        tokens: 0,
        durationMs: 0,
        status: "skipped",
      },
      {
        stepIndex: 1,
        fn: "testEcho",
        result: null,
        tokens: 0,
        durationMs: 0,
        status: "skipped",
      },
    ]);
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


describe("workflow fair-share response caps", () => {
  it("truncates verbose intermediate results so later steps can run", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test-repo",
      steps: [
        { fn: "testLarge", action: "test.large", args: {} },
        { fn: "testEcho", action: "test.echo", args: { message: "after" } },
        { fn: "testEcho", action: "test.echo", args: { message: "still-runs" } },
      ],
      budget: { maxTotalTokens: 300 },
      onError: "continue",
    };

    const result = await executeWorkflow(
      request,
      createMockActionMap(),
      testConfig,
    );

    assert.strictEqual(result.results[0].status, "ok");
    assert.strictEqual(result.results[1].status, "ok");
    assert.strictEqual(result.results[2].status, "ok");
    assert.ok(result.results[0].tokens < 150);
  });
});


it("classifies denied gateway results as workflow errors", async () => {
  const actionMap = {
    ...createMockActionMap(),
    "test.denied": {
      schema: z.object({}).passthrough(),
      handler: async () => ({
        status: "denied",
        policyDecision: {
          allowed: false,
          deniedReasons: ["Executable is incompatible with the selected runtime."],
        },
        nextAction: "Choose a compatible executable.",
      }),
    },
  };

  const response = await executeWorkflow(
    {
      repoId: "test-repo",
      steps: [
        {
          fn: "test.denied",
          action: "test.denied",
          args: {},
          internal: false,
        },
      ],
      onError: "continueAll",
    },
    actionMap,
    testConfig,
  );

  assert.equal(response.results[0]?.status, "error");
  assert.match(
    String(response.results[0]?.error),
    /Executable is incompatible with the selected runtime/,
  );
});
