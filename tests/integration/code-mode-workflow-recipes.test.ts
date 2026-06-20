import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { executeWorkflow } from "../../dist/code-mode/workflow-executor.js";
import type { ParsedWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";
import type { CodeModeConfig } from "../../dist/config/types.js";
import type { ActionMap } from "../../dist/gateway/router.js";

const config: CodeModeConfig = {
  enabled: true,
  exclusive: false,
  maxWorkflowSteps: 20,
  maxWorkflowTokens: 50000,
  maxWorkflowDurationMs: 60000,
  ladderValidation: "warn",
  etagCaching: false,
};

function actionMap(): ActionMap {
  const symbols = Array.from({ length: 12 }, (_, index) => ({
    symbolId: `sym-${index}`,
    name: `name-${index}`,
    file: `src/file-${index}.ts`,
    kind: "function",
    summary: "large symbol payload ".repeat(20),
  }));

  return {
    "symbol.search": {
      schema: z.object({ query: z.string(), limit: z.number().optional() }),
      handler: async () => ({ results: symbols }),
    },
    "symbol.getCard": {
      schema: z.object({ symbolId: z.string() }),
      handler: async (args) => ({
        card: { symbolId: (args as { symbolId: string }).symbolId },
      }),
    },
    "code.getSkeleton": {
      schema: z.object({ symbolId: z.string() }),
      handler: async (args) => ({
        skeleton: `function ${(args as { symbolId: string }).symbolId}() {}`,
      }),
    },
    "runtime.execute": {
      schema: z.object({ outputMode: z.string().optional() }).passthrough(),
      handler: async () => ({ status: "ok", exitCode: 0, artifactHandle: "art-1" }),
    },
    "runtime.queryOutput": {
      schema: z.object({ artifactHandle: z.string() }).passthrough(),
      handler: async (args) => ({
        matchStatus: "matched",
        excerpts: [
          { content: `queried ${(args as { artifactHandle: string }).artifactHandle}` },
        ],
      }),
    },
    "searchEditPreview": {
      schema: z.object({ query: z.object({ literal: z.string() }) }),
      handler: async () => ({ planHandle: "plan-1" }),
    },
    "previewWindow": {
      schema: z.object({ planHandle: z.string() }),
      handler: async (args) => ({
        content: `preview ${(args as { planHandle: string }).planHandle}`,
      }),
    },
    "test.fail": {
      schema: z.object({}).passthrough(),
      handler: async () => {
        throw new Error("recipe failure");
      },
    },
    "test.echo": {
      schema: z.object({ message: z.unknown() }),
      handler: async (args) => args,
    },
  };
}

describe("code-mode workflow recipes", () => {
  it("runs symbolSearch -> symbolGetCard -> codeSkeleton", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      onError: "stop",
      steps: [
        { fn: "symbolSearch", action: "symbol.search", args: { query: "name" }, internal: false },
        { fn: "symbolGetCard", action: "symbol.getCard", args: { symbolId: "$0.results[0].symbolId" }, internal: false },
        { fn: "codeSkeleton", action: "code.getSkeleton", args: { symbolId: "$1.card.symbolId" }, internal: false },
      ],
    };

    const result = await executeWorkflow(request, actionMap(), config);

    assert.deepEqual(result.results.map((step) => step.status), ["ok", "ok", "ok"]);
  });

  it("runs runtimeExecute(minimal) -> runtimeQueryOutput", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      onError: "stop",
      steps: [
        { fn: "runtimeExecute", action: "runtime.execute", args: { outputMode: "minimal" }, internal: false },
        { fn: "runtimeQueryOutput", action: "runtime.queryOutput", args: { artifactHandle: "$0.artifactHandle" }, internal: false },
      ],
    };

    const result = await executeWorkflow(request, actionMap(), config);

    assert.equal(result.results[1].status, "ok");
    assert.match(JSON.stringify(result.results[1].result), /art-1/);
  });

  it("runs symbolSearch(truncated) -> workflowContinuationGet(path/results) -> dataMap", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      onError: "stop",
      steps: [
        { fn: "symbolSearch", action: "symbol.search", args: { query: "name" }, internal: false, maxResponseTokens: 50 },
        {
          fn: "workflowContinuationGet",
          action: "workflowContinuationGet",
          args: { handle: "$0.truncatedResponse.continuationHandle", path: "results", offset: 1, limit: 2 },
          internal: true,
        },
        {
          fn: "dataMap",
          action: "dataMap",
          args: { input: "$1.data", fields: { name: "name" } },
          internal: true,
        },
      ],
    };

    const result = await executeWorkflow(request, actionMap(), config);

    assert.deepEqual(result.results[2].result, [{ name: "name-1" }, { name: "name-2" }]);
  });

  it("runs searchEditPreview -> previewWindow", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      onError: "stop",
      steps: [
        { fn: "searchEditPreview", action: "searchEditPreview", args: { query: { literal: "old" } }, internal: false },
        { fn: "previewWindow", action: "previewWindow", args: { planHandle: "$0.planHandle" }, internal: false },
      ],
    };

    const result = await executeWorkflow(request, actionMap(), config);

    assert.equal(result.results[1].status, "ok");
    assert.match(JSON.stringify(result.results[1].result), /plan-1/);
  });

  it("blocks only failed dependencies under onError=continue", async () => {
    const request: ParsedWorkflowRequest = {
      repoId: "test",
      onError: "continue",
      steps: [
        { fn: "testFail", action: "test.fail", args: {}, internal: false },
        { fn: "testEcho", action: "test.echo", args: { message: "$0.missing" }, internal: false },
        { fn: "testEcho", action: "test.echo", args: { message: "independent" }, internal: false },
      ],
    };

    const result = await executeWorkflow(request, actionMap(), config);

    assert.deepEqual(result.results.map((step) => step.status), ["error", "skipped", "ok"]);
  });
});
