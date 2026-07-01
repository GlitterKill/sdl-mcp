import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  handleActionSearch,
  registerCodeModeTools,
} from "../../dist/code-mode/index.js";
import {
  handleRetrieve,
  normalizeRetrieveArgs,
  RETRIEVE_ACTION_BY_OP,
  RetrieveRequestSchema,
} from "../../dist/code-mode/retrieve.js";

function createTestConfig() {
  return {
    enabled: true,
    exclusive: false,
    maxWorkflowSteps: 20,
    maxWorkflowTokens: 50000,
    maxWorkflowDurationMs: 60000,
    ladderValidation: "warn" as const,
    etagCaching: true,
  };
}

describe("sdl.retrieve", () => {
  it("maps retrieval ops to existing read-only gateway actions", () => {
    assert.deepEqual(RETRIEVE_ACTION_BY_OP, {
      symbolSearch: "symbol.search",
      symbolGetCard: "symbol.getCard",
      sliceBuild: "slice.build",
      codeSkeleton: "code.getSkeleton",
      codeHotPath: "code.getHotPath",
      codeNeedWindow: "code.needWindow",
    });
  });

  it("keeps the public schema compact", () => {
    const parsed = RetrieveRequestSchema.parse({
      repoId: "repo",
      op: "symbolSearch",
      args: { query: "executeWorkflow" },
    });

    assert.equal(parsed.repoId, "repo");
    assert.equal(parsed.op, "symbolSearch");
    assert.deepEqual(parsed.args, { query: "executeWorkflow" });
  });

  it("rejects non-retrieval operations", () => {
    assert.throws(
      () =>
        RetrieveRequestSchema.parse({
          repoId: "repo",
          op: "runtimeExecute",
          args: { runtime: "shell" },
        }),
      /Invalid option|invalid/i,
    );
  });

  it("defaults symbolSearch to packed/auto output", () => {
    assert.deepEqual(normalizeRetrieveArgs("symbolSearch", { query: "foo" }, {}), {
      query: "foo",
      wireFormat: "auto",
    });
  });

  it("defaults sliceBuild to compact auto output", () => {
    assert.deepEqual(
      normalizeRetrieveArgs("sliceBuild", { taskText: "debug foo" }, {}),
      {
        taskText: "debug foo",
        wireFormat: "auto",
        cardDetail: "compact",
        includeLegend: false,
        includeRetrievalEvidence: false,
        includeProcesses: false,
      },
    );
  });

  it("defaults codeNeedWindow to auto response handles without weakening justification", () => {
    assert.deepEqual(
      normalizeRetrieveArgs(
        "codeNeedWindow",
        {
          symbolId: "sym",
          reason: "Need exact branch condition.",
          expectedLines: 20,
          identifiersToFind: ["branch"],
        },
        {},
      ),
      {
        symbolId: "sym",
        reason: "Need exact branch condition.",
        expectedLines: 20,
        identifiersToFind: ["branch"],
        responseMode: "auto",
      },
    );
  });

  it("dispatches through the existing action map and returns the handler result directly", async () => {
    const calls: unknown[] = [];
    const actionMap = {
      "symbol.search": {
        schema: z
          .object({
            repoId: z.string(),
            action: z.literal("symbol.search"),
            query: z.string(),
            wireFormat: z.literal("auto"),
          })
          .passthrough(),
        handler: async (args: unknown) => {
          calls.push(args);
          return { results: [{ symbolId: "sym-1", name: "foo" }] };
        },
      },
    };

    const result = await handleRetrieve(
      { repoId: "repo", op: "symbolSearch", args: { query: "foo" } },
      actionMap as never,
    );

    assert.deepEqual(result, { results: [{ symbolId: "sym-1", name: "foo" }] });
    assert.deepEqual(calls, [
      {
        repoId: "repo",
        action: "symbol.search",
        query: "foo",
        wireFormat: "auto",
      },
    ]);
    assert.equal(Object.hasOwn(result as object, "totalTokens"), false);
    assert.equal(Object.hasOwn(result as object, "durationMs"), false);
    assert.equal(Object.hasOwn(result as object, "intermediateResultsSuppressed"), false);
  });

  it("registers sdl.retrieve as a top-level Code Mode tool", () => {
    const registered: string[] = [];
    const fakeServer = {
      registerTool(name: string) {
        registered.push(name);
      },
    };

    registerCodeModeTools(
      fakeServer as never,
      {},
      createTestConfig(),
      {} as never,
    );

    assert.ok(registered.includes("sdl.retrieve"));
  });

  it("exposes sdl.retrieve through action search", () => {
    const result = handleActionSearch({
      query: "retrieve",
      limit: 10,
      includeSchemas: true,
    });
    const actions =
      (result as { actions?: Array<{ action: string; schemaSummary?: unknown }> })
        .actions ?? [];
    const retrieve = actions.find((action) => action.action === "retrieve");

    assert.ok(retrieve);
    assert.ok(retrieve.schemaSummary);
    assert.match(JSON.stringify(retrieve.schemaSummary), /symbolSearch/);
    assert.match(JSON.stringify(retrieve.schemaSummary), /codeNeedWindow/);
  });
});
