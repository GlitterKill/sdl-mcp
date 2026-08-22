import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { executeWorkflow } from "../../dist/code-mode/workflow-executor.js";
import {
  getContinuation,
  storeContinuation,
} from "../../dist/code-mode/workflow-truncation.js";
import type { ParsedWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";
import type { CodeModeConfig } from "../../dist/config/types.js";
import type { ActionMap } from "../../dist/gateway/router.js";
import {
  projectToolResultForModelContent,
  projectWorkflowChildResultForModel,
} from "../../dist/mcp/context-response-projection.js";
import { buildToolResponseEnvelope } from "../../dist/server.js";
import { buildWorkflowPublicOutputSchema } from "../../dist/code-mode/types.js";
import { BufferStatusResponseSchema } from "../../dist/mcp/tools.js";

const config: CodeModeConfig = {
  enabled: true,
  exclusive: false,
  maxWorkflowSteps: 20,
  maxWorkflowTokens: 50_000,
  maxWorkflowDurationMs: 60_000,
  ladderValidation: "warn",
  etagCaching: false,
};

function projectWorkflow(
  result: unknown,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  return projectToolResultForModelContent(
    "sdl.workflow",
    result,
    args,
  ) as Record<string, unknown>;
}

function failureFixture(
  status: "error" | "skipped" | "budget_exceeded",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    stepIndex: 1,
    fn: "repoStatus",
    status,
    result: {
      status: "failure",
      error: { message: "canonical failure" },
      fallbackTools: ["sdl.repo.status"],
    },
    tokens: 0,
    durationMs: 12,
    error: "canonical failure",
    fallbackTools: ["sdl.repo.status"],
    failureTrace: {
      stepIndex: 1,
      fn: "repoStatus",
      action: "repo.status",
      kind: "gateway",
      status,
      message: "canonical failure",
      fallbackTools: ["sdl.repo.status"],
      resolvedArgKeys: ["repoId"],
    },
    nextAction: {
      action: "repo.overview",
      args: { repoId: "repo" },
    },
    ...overrides,
  };
}

describe("workflow projection", () => {
  it("pipes canonical child values that compact projection omits", async () => {
    let received: unknown;
    const actions: ActionMap = {
      "repo.status": {
        schema: z.object({}),
        handler: async () => ({
          repoId: "repo",
          lastIndexedAt: "2026-08-10T00:00:00.000Z",
        }),
      },
      "test.echo": {
        schema: z.object({ value: z.string() }),
        handler: async (args) => {
          received = (args as { value: string }).value;
          return { received };
        },
      },
    };
    const request: ParsedWorkflowRequest = {
      repoId: "repo",
      onError: "stop",
      steps: [
        {
          fn: "repoStatus",
          action: "repo.status",
          args: {},
          internal: false,
          projectionOptions: { detail: "compact", includeDiagnostics: false },
        },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { value: "$0.lastIndexedAt" },
          internal: false,
          projectionOptions: { detail: "compact", includeDiagnostics: false },
        },
      ],
    };

    const result = await executeWorkflow(
      request,
      actions,
      config,
      undefined,
      undefined,
      (fn, value, args) =>
        projectWorkflowChildResultForModel(
          fn,
          value,
          { detail: "compact" },
          args,
        ),
    );
    const projected = projectWorkflow(result, {
      detail: "compact",
      repoId: "repo",
      steps: request.steps,
    });
    const steps = projected.results as Array<Record<string, unknown>>;

    assert.equal(received, "2026-08-10T00:00:00.000Z");
    assert.equal(
      "lastIndexedAt" in (result.results[0].result as Record<string, unknown>),
      false,
    );
    assert.equal(
      "lastIndexedAt" in (steps[0].result as Record<string, unknown>),
      false,
    );
    assert.deepEqual(steps[1].result, {
      received: "2026-08-10T00:00:00.000Z",
    });
  });

  it("keeps compact bufferStatus workflow children schema-valid", () => {
    const workflowArgs = {
      repoId: "repo",
      onlyFinalResult: true,
      steps: [{ fn: "bufferStatus", args: {} }],
    };
    const child = projectWorkflowChildResultForModel(
      "bufferStatus",
      {
        repoId: "repo",
        enabled: true,
        pendingBuffers: 0,
        dirtyBuffers: 0,
        parseQueueDepth: 0,
      },
      workflowArgs,
      {},
    );
    const projected = projectWorkflow(
      {
        results: [{
          stepIndex: 0,
          fn: "bufferStatus",
          result: child,
          tokens: 1,
          durationMs: 1,
          status: "ok",
        }],
        totalTokens: 1,
        durationMs: 1,
        truncated: false,
      },
      workflowArgs,
    );
    const validation = buildWorkflowPublicOutputSchema({
      bufferStatus: BufferStatusResponseSchema,
    }).safeParse(projected);

    assert.equal(
      validation.success,
      true,
      validation.success
        ? undefined
        : JSON.stringify({ projected, issues: validation.error.issues }),
    );
  });

  it("keeps compact usageStats children at the outer public projection", () => {
    const canonical = {
      formattedSummary: "1 call saved 900 tokens",
      aggregate: {
        totalSdlTokens: 100,
        totalRawEquivalent: 1_000,
        totalSavedTokens: 900,
        savingsPercent: 90,
        callCount: 1,
      },
      topTools: [{ tool: "sdl.context", savedTokens: 900 }],
      session: {
        sessionId: "volatile-session",
        startedAt: "2026-08-22T00:00:00.000Z",
      },
    };
    const before = structuredClone(canonical);
    const workflowArgs = {
      repoId: "repo",
      detail: "compact" as const,
      steps: [{ fn: "usageStats", args: {} }],
    };
    const projected = projectWorkflow(
      {
        results: [{
          stepIndex: 0,
          fn: "usageStats",
          result: canonical,
          tokens: 1,
          durationMs: 1,
          status: "ok",
        }],
        totalTokens: 1,
        durationMs: 1,
        truncated: false,
      },
      workflowArgs,
    );
    const result = (
      projected.results as Array<Record<string, unknown>>
    )[0].result;

    assert.deepEqual(result, {
      formattedSummary: "1 call saved 900 tokens",
    });
    assert.deepEqual(canonical, before);
  });

  it("pipes canonical runtime status while omitting minimal success output", async () => {
    let received: unknown;
    const actions: ActionMap = {
      "runtime.execute": {
        schema: z.object({ outputMode: z.literal("minimal") }),
        handler: async () => ({
          status: "success",
          exitCode: 0,
          signal: null,
          durationMs: 5,
          stdoutSummary: "",
          stderrSummary: "",
          artifactHandle: null,
          truncation: {
            stdoutTruncated: false,
            stderrTruncated: false,
            totalStdoutBytes: 0,
            totalStderrBytes: 0,
          },
        }),
      },
      "test.echo": {
        schema: z.object({ value: z.string() }),
        handler: async (args) => {
          received = (args as { value: string }).value;
          return { received };
        },
      },
    };
    const request: ParsedWorkflowRequest = {
      repoId: "repo",
      onError: "stop",
      steps: [
        {
          fn: "runtimeExecute",
          action: "runtime.execute",
          args: { outputMode: "minimal" },
          internal: false,
          projectionOptions: { detail: "compact", includeDiagnostics: false },
        },
        {
          fn: "testEcho",
          action: "test.echo",
          args: { value: "$0.status" },
          internal: false,
          projectionOptions: { detail: "compact", includeDiagnostics: false },
        },
      ],
    };

    const executed = await executeWorkflow(
      request,
      actions,
      config,
      undefined,
      undefined,
      (fn, value, args) =>
        projectWorkflowChildResultForModel(
          fn,
          value,
          { detail: "compact" },
          args,
        ),
    );
    const projected = projectWorkflow(executed, {
      repoId: "repo",
      detail: "compact",
      steps: request.steps,
    });
    const steps = projected.results as Array<Record<string, unknown>>;

    assert.equal(received, "success");
    assert.deepEqual(steps[0], { fn: "runtimeExecute" });
    assert.deepEqual(steps[1].result, { received: "success" });
  });

  it("deduplicates validation, handler, partial, skipped, and budget failures", () => {
    const cases = [
      failureFixture("error", { fn: "validationFixture" }),
      failureFixture("error", { fn: "handlerFixture" }),
      failureFixture("error", { fn: "partialFailureFixture" }),
      failureFixture("skipped", {
        fn: "skippedFixture",
        blockedByStep: 0,
        blockedByFn: "handlerFixture",
        blockedByError: "canonical failure",
      }),
      failureFixture("budget_exceeded", { fn: "budgetFixture" }),
    ];

    for (const fixture of cases) {
      const projected = projectWorkflow(
        { results: [fixture], truncated: fixture.status === "budget_exceeded" },
        { repoId: "repo", detail: "compact" },
      );
      const [step] = projected.results as Array<Record<string, unknown>>;
      const serialized = JSON.stringify(step);

      assert.equal((serialized.match(/canonical failure/g) ?? []).length, 1);
      assert.equal("failureTrace" in step, false);
      assert.equal("fallbackTools" in step, false);
      assert.equal("blockedByFn" in step, false);
      assert.equal("blockedByError" in step, false);
      assert.ok(
        Object.keys(step).filter((key) => key === "nextAction").length <= 1,
      );
      assert.deepEqual(Object.keys(step), [
        ...(fixture.status === "error" || "nextAction" in step
          ? ["stepIndex"]
          : []),
        "fn",
        "status",
        "error",
        ...(fixture.status === "skipped" ? ["blockedByStep"] : []),
        ...("nextAction" in step ? ["nextAction"] : []),
      ]);
    }
  });

  it("keeps onlyFinalResult failures actionable without duplicate fallback arrays", () => {
    const projected = projectWorkflow(
      {
        results: [
          failureFixture("error", { stepIndex: 0, fn: "failedFirst" }),
          {
            stepIndex: 2,
            fn: "finalStep",
            status: "ok",
            result: { ok: true },
            tokens: 2,
            durationMs: 1,
          },
        ],
        intermediateResultsSuppressed: 1,
      },
      { repoId: "repo", onlyFinalResult: true, detail: "compact" },
    );
    const steps = projected.results as Array<Record<string, unknown>>;

    assert.equal(steps.length, 2);
    assert.equal(steps[0].fn, "failedFirst");
    assert.equal(steps[1].fn, "finalStep");
    assert.equal(JSON.stringify(steps).match(/fallbackTools/g), null);
  });

  it("restores public step order at full detail without enabling diagnostics", () => {
    const canonical = {
      results: [
        {
          stepIndex: 0,
          fn: "first",
          status: "ok",
          result: { order: 1, generatedAt: "volatile" },
          tokens: 10,
          durationMs: 20,
        },
        {
          stepIndex: 1,
          fn: "second",
          status: "ok",
          result: { order: 2 },
          tokens: 11,
          durationMs: 21,
        },
      ],
      totalTokens: 21,
      durationMs: 41,
      trace: { steps: [{ resolvedArgsPreview: "{\"secret\":true}" }] },
      diagnostics: { timings: { totalMs: 41 } },
    };

    for (const detail of ["compact", "standard", "full"] as const) {
      const projected = projectWorkflow(canonical, { detail });
      const serialized = JSON.stringify(projected);
      assert.doesNotMatch(
        serialized,
        /durationMs|totalTokens|tokens|trace|diagnostics|generatedAt|session|process/i,
      );
    }

    const full = projectWorkflow(canonical, {
      detail: "full",
      includeDiagnostics: true,
      trace: { level: "verbose", includeResolvedArgs: true },
    });
    const fullSteps = full.results as Array<Record<string, unknown>>;
    assert.deepEqual(fullSteps.map((step) => step.fn), ["first", "second"]);
    assert.deepEqual(fullSteps.map((step) => step.stepIndex), [0, 1]);
    assert.ok("diagnostics" in full);
    assert.ok("trace" in full);
  });

  it("honors sibling child projection controls at the public boundary", () => {
    const projected = projectWorkflow(
      {
        results: [{
          stepIndex: 0,
          fn: "repoStatus",
          status: "ok",
          result: {
            repoId: "repo",
            fullOnlyValue: "preserved",
            diagnostics: {
              timings: { totalMs: 7 },
              resolvedArgs: { repoId: "repo" },
            },
            durationMs: 9,
            generatedAt: "volatile",
          },
          tokens: 20,
          durationMs: 10,
        }],
      },
      {
        repoId: "repo",
        detail: "compact",
        steps: [{
          fn: "repoStatus",
          args: {},
          detail: "full",
          includeDiagnostics: true,
        }],
      },
    );
    const result = (
      projected.results as Array<Record<string, unknown>>
    )[0].result as Record<string, unknown>;

    assert.equal(result.fullOnlyValue, "preserved");
    assert.deepEqual(result.diagnostics, {
      timings: { totalMs: 7 },
      resolvedArgs: { repoId: "repo" },
    });
    assert.equal("durationMs" in result, false);
    assert.equal("generatedAt" in result, false);
  });

  it("keeps text and structured counts and truncation state aligned", () => {
    const canonical = {
      results: [
        { stepIndex: 0, fn: "okStep", status: "ok", result: { secret: "serialized-step-result" }, tokens: 1, durationMs: 1 },
        failureFixture("error", { stepIndex: 1, fn: "errorStep" }),
        failureFixture("skipped", { stepIndex: 2, fn: "skippedStep", blockedByStep: 1 }),
      ],
      truncated: true,
      totalTokens: 1,
      durationMs: 3,
    };
    const envelope = buildToolResponseEnvelope(
      canonical,
      null,
      "",
      "sdl.workflow",
      { repoId: "repo", detail: "compact" },
    );
    const structured = envelope.structuredContent as Record<string, unknown>;
    const steps = structured.results as Array<Record<string, unknown>>;
    const text = envelope.content.map((item) => item.text).join("\n");
    const counts = {
      total: steps.length,
      ok: steps.filter((step) => (step.status ?? "ok") === "ok").length,
      error: steps.filter((step) => step.status === "error").length,
      skipped: steps.filter((step) => step.status === "skipped").length,
    };

    assert.match(text, new RegExp(`total=${counts.total}\\b`));
    assert.match(text, new RegExp(`ok=${counts.ok}\\b`));
    assert.match(text, new RegExp(`error=${counts.error}\\b`));
    assert.match(text, new RegExp(`skipped=${counts.skipped}\\b`));
    assert.match(text, /truncat/i);
    assert.equal(structured.truncated, true);
    assert.doesNotMatch(text, /serialized-step-result/);
  });

  it("preserves explicitly requested process-domain fields", () => {
    const raw = {
      symbolId: "sym",
      file: "src/a.ts",
      name: "a",
      processes: [{ processId: "proc-1", label: "worker" }],
    };
    const direct = projectWorkflowChildResultForModel(
      "symbolGetCard",
      raw,
      { detail: "standard" },
      { includeProcesses: true },
    );
    const projected = projectWorkflow(
      {
        results: [{
          stepIndex: 0,
          fn: "symbolGetCard",
          status: "ok",
          result: raw,
        }],
      },
      {
        repoId: "repo",
        detail: "compact",
        steps: [{
          fn: "symbolGetCard",
          args: { includeProcesses: true },
          detail: "standard",
        }],
      },
    );
    const result = (
      projected.results as Array<Record<string, unknown>>
    )[0].result;

    assert.deepEqual(result, direct);
    assert.match(JSON.stringify(result), /processes|processId|proc-1/);
  });

  it("uses non-enumerable resolved child args for sibling reprojection", async () => {
    const card = {
      symbolId: "sym",
      file: "src/a.ts",
      name: "a",
      callResolution: {
        calls: [{
          symbolId: "dep",
          confidence: 0.9,
          resolutionReason: "exact",
        }],
      },
    };
    const actions: ActionMap = {
      "test.flag": {
        schema: z.object({}),
        handler: async () => ({ flag: true }),
      },
      "symbol.getCard": {
        schema: z.object({
          includeResolutionMetadata: z.boolean(),
        }),
        handler: async () => card,
      },
    };
    const request: ParsedWorkflowRequest = {
      repoId: "repo",
      onError: "stop",
      steps: [
        {
          fn: "testFlag",
          action: "test.flag",
          args: {},
          internal: false,
          projectionOptions: {
            detail: "compact",
            includeDiagnostics: false,
          },
        },
        {
          fn: "symbolGetCard",
          action: "symbol.getCard",
          args: { includeResolutionMetadata: "$0.flag" },
          internal: false,
          projectionOptions: {
            detail: "standard",
            includeDiagnostics: false,
          },
        },
      ],
    };
    const executed = await executeWorkflow(request, actions, config);
    const projected = projectWorkflow(executed, {
      repoId: "repo",
      detail: "compact",
      steps: [
        { fn: "testFlag", args: {} },
        {
          fn: "symbolGetCard",
          args: { includeResolutionMetadata: "$0.flag" },
          detail: "standard",
        },
      ],
    });
    const rawStep = executed.results[1] as unknown as Record<string, unknown>;
    const result = (
      projected.results as Array<Record<string, unknown>>
    )[1].result as Record<string, unknown>;

    assert.equal(Object.keys(rawStep).includes("_resolvedArgs"), false);
    assert.deepEqual(result.callResolution, card.callResolution);
  });

  it("materializes established failure-trace nextCalls once", () => {
    const projected = projectWorkflow(
      {
        results: [{
          stepIndex: 0,
          fn: "runtimeExecute",
          status: "error",
          error: "artifact page failed",
          failureTrace: {
            stepIndex: 0,
            fn: "runtimeExecute",
            action: "runtime.execute",
            kind: "gateway",
            status: "error",
            message: "artifact page failed",
            details: {
              nextCalls: [{
                action: "response.get",
                args: {
                  repoId: "repo",
                  handle: "response-repo-1234567890-abcdef1234567890",
                  maxBytes: 65_536,
                },
              }],
            },
          },
        }],
      },
      {
        repoId: "repo",
        detail: "compact",
        steps: [{
          fn: "runtimeExecute",
          args: { runtime: "node", code: "throw new Error()" },
        }],
      },
    );
    const step = (
      projected.results as Array<Record<string, unknown>>
    )[0];
    const serialized = JSON.stringify(step);

    assert.equal((serialized.match(/artifact page failed/g) ?? []).length, 1);
    assert.equal("failureTrace" in step, false);
    assert.deepEqual(
      (step.nextAction as {
        action: string;
        args: { steps: Array<{ fn: string }> };
      }).args.steps[0].fn,
      "responseGet",
    );
  });

  it("stores the effective sibling child projection in public continuations", () => {
    const rawResult = {
      repoId: "repo",
      fullOnlyValue: "v".repeat(600),
      diagnostics: { timings: { totalMs: 7 } },
      generatedAt: "secret-timestamp",
    };
    const storedHandle = storeContinuation({
      repoId: rawResult.repoId,
      fullOnlyValue: rawResult.fullOnlyValue,
      diagnostics: rawResult.diagnostics,
    });
    const projected = projectWorkflow(
      {
        results: [{
          stepIndex: 0,
          fn: "repoStatus",
          status: "ok",
          result: rawResult,
          tokens: 200,
          durationMs: 4,
          truncatedResponse: {
            originalTokens: 200,
            keptTokens: 50,
            continuationHandle: storedHandle,
            maxTokens: 50,
          },
        }],
      },
      {
        repoId: "repo",
        detail: "compact",
        steps: [{
          fn: "repoStatus",
          args: {},
          detail: "full",
          includeDiagnostics: true,
        }],
      },
    );
    const step = (projected.results as Array<Record<string, unknown>>)[0];
    const nextAction = step.nextAction as {
      action: string;
      args: { steps: Array<{ args: { handle: string } }> };
    };
    const handle = nextAction.args.steps[0].args.handle;
    const continuation = getContinuation(handle);
    const serialized = JSON.stringify(continuation?.data);

    assert.equal(nextAction.action, "sdl.workflow");
    assert.equal(handle, storedHandle);
    assert.match(serialized, /fullOnlyValue|vvvv/);
    assert.match(serialized, /diagnostics|totalMs/);
    assert.doesNotMatch(serialized, /generatedAt|secret-timestamp/);
    assert.equal(rawResult.generatedAt, "secret-timestamp");
  });

  it("stores the executor-created sanitized child projection under the public handle", async () => {
    const rawResult = {
      symbolId: "sym",
      file: "src/a.ts",
      name: "a",
      summary: "v".repeat(600),
      generatedAt: "secret-timestamp",
      durationMs: 99,
      processes: [{ processId: "proc-1", label: "worker" }],
      diagnostics: { timings: { totalMs: 7 } },
    };
    const actions: ActionMap = {
      "symbol.getCard": {
        schema: z.object({ includeProcesses: z.boolean() }),
        handler: async () => rawResult,
      },
    };
    const request: ParsedWorkflowRequest = {
      repoId: "repo",
      onError: "stop",
      steps: [{
        fn: "symbolGetCard",
        action: "symbol.getCard",
        args: { includeProcesses: true },
        internal: false,
        maxResponseTokens: 50,
        projectionOptions: {
          detail: "full",
          includeDiagnostics: true,
        },
      }],
    };

    const executed = await executeWorkflow(
      request,
      actions,
      config,
      undefined,
      undefined,
      (fn, value, args, projectionOptions) =>
        projectWorkflowChildResultForModel(
          fn,
          value,
          { repoId: "repo", detail: "compact", ...projectionOptions },
          { ...args, ...projectionOptions },
        ),
    );
    const executorHandle = executed.results[0].truncatedResponse
      ?.continuationHandle;
    assert.ok(executorHandle);
    assert.notEqual(executed.results[0].result, rawResult);
    assert.deepEqual(
      executed.results[0].result,
      projectWorkflowChildResultForModel(
        "symbolGetCard",
        rawResult,
        { repoId: "repo", detail: "full", includeDiagnostics: true },
        {
          includeProcesses: true,
          detail: "full",
          includeDiagnostics: true,
        },
      ),
    );

    const projected = projectWorkflow(executed, {
      repoId: "repo",
      detail: "compact",
      steps: [{
        fn: "symbolGetCard",
        args: { includeProcesses: true },
        detail: "full",
        includeDiagnostics: true,
      }],
    });
    const step = (projected.results as Array<Record<string, unknown>>)[0];
    const nextAction = step.nextAction as {
      action: string;
      args: { steps: Array<{ args: { handle: string } }> };
    };
    const handle = nextAction.args.steps[0].args.handle;
    const continuation = getContinuation(handle);
    const serialized = JSON.stringify(continuation?.data);

    assert.equal(nextAction.action, "sdl.workflow");
    assert.equal(handle, executorHandle);
    assert.doesNotMatch(
      JSON.stringify(step),
      /generatedAt|secret-timestamp|durationMs/,
    );
    assert.match(serialized, /processes|processId|proc-1/);
    assert.doesNotMatch(serialized, /diagnostics|totalMs/);
    assert.doesNotMatch(
      serialized,
      /generatedAt|secret-timestamp|durationMs/,
    );
    assert.equal(rawResult.generatedAt, "secret-timestamp");
    assert.equal(rawResult.durationMs, 99);
  });
});
