import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ValidationError } from "../../dist/domain/errors.js";
import { createActionMap } from "../../dist/gateway/router.js";
import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";
import { SliceBuildRequestSchema } from "../../dist/mcp/tools.js";

import {
  handleActionSearch,
  registerCodeModeTools,
} from "../../dist/code-mode/index.js";
import {
  buildRetrieveWireSchema,
  handleRetrieve,
  RETRIEVE_ACTION_BY_OP,
  RetrieveOutputSchema,
  RetrieveRequestSchema,
} from "../../dist/code-mode/retrieve.js";
import { projectExclusiveCodeModeRecovery } from "../../dist/code-mode/action-reference-projection.js";

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

const RESPONSE_GET_HANDLE =
  "response-repo-1784866000000-deadbeefdeadbeef";

const RESPONSE_GET_CONTINUATION_ARGS = {
  handle: RESPONSE_GET_HANDLE,
  view: "model" as const,
  cursor: { offsetBytes: 8_192 },
  full: false,
  maxBytes: 8_192,
  offsetBytes: 0,
  raw: false,
};

function createIncompleteResponseGetPage() {
  return {
    handle: RESPONSE_GET_HANDLE,
    contentKind: "json" as const,
    content: "{\"partial\":",
    metadata: {
      repoId: "repo",
      toolName: "sdl.context",
      originalBytes: 16_384,
      contentKind: "json" as const,
    },
    full: false as const,
    complete: false as const,
    truncated: true as const,
    range: { offsetBytes: 0, returnedBytes: 8_192 },
    nextAction: {
      action: "sdl.retrieve" as const,
      args: {
        repoId: "repo",
        op: "responseGet" as const,
        args: RESPONSE_GET_CONTINUATION_ARGS,
      },
    },
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
      responseGet: "response.get",
    });
  });

  it("routes responseGet through response.get model projection", () => {
    const handle = "response-repo-1784866000000-deadbeefdeadbeef";
    const canonical = {
      handle,
      content: {
        fallbackRationale: "Use sdl.symbol.search to recover.",
        nextBestAction: {
          tool: "sdl.code.getSkeleton",
          args: { repoId: "repo", symbolId: "sym" },
        },
      },
    };
    const expected = projectToolResultForModelContent(
      "response.get",
      structuredClone(canonical),
      { repoId: "repo", handle },
    );
    const projected = projectToolResultForModelContent(
      "sdl.retrieve",
      structuredClone(canonical),
      { repoId: "repo", op: "responseGet", args: { handle } },
    );

    assert.deepEqual(projected, expected);
  });

  it("accepts complete responseGet pages", () => {
    const page = {
      handle: RESPONSE_GET_HANDLE,
      contentKind: "json" as const,
      content: { done: true },
      metadata: {
        repoId: "repo",
        toolName: "sdl.context",
        originalBytes: 8_192,
        contentKind: "json" as const,
      },
      full: false as const,
      complete: true as const,
      range: { offsetBytes: 0, returnedBytes: 8_192 },
    };
    const parsed = RetrieveOutputSchema.safeParse(page);

    if (!parsed.success) assert.fail(parsed.error.message);
  });

  it("accepts direct responseGet continuations with stable key order", () => {
    const page = createIncompleteResponseGetPage();
    const parsed = RetrieveOutputSchema.safeParse(page);

    if (!parsed.success) assert.fail(parsed.error.message);
    assert.deepEqual(parsed.data.nextAction, page.nextAction);
    assert.deepEqual(
      Object.keys(JSON.parse(JSON.stringify(parsed.data)) as object),
      [
        "handle",
        "contentKind",
        "content",
        "metadata",
        "full",
        "complete",
        "truncated",
        "range",
        "nextAction",
      ],
    );
  });

  it("rejects workflow-wrapped and unknown-field responseGet pages", () => {
    const page = createIncompleteResponseGetPage();
    const workflowWrapped = {
      ...page,
      nextAction: {
        action: "sdl.workflow",
        args: {
          repoId: "repo",
          steps: [
            {
              fn: "responseGet",
              args: RESPONSE_GET_CONTINUATION_ARGS,
            },
          ],
        },
      },
    };

    assert.equal(RetrieveOutputSchema.safeParse(workflowWrapped).success, false);
    assert.equal(
      RetrieveOutputSchema.safeParse({
        ...page,
        unknownPageField: true,
      }).success,
      false,
    );
  });

  it("rejects incoherent direct responseGet continuation arguments", () => {
    const page = createIncompleteResponseGetPage();
    const invalidContinuationArgs = [
      { ...RESPONSE_GET_CONTINUATION_ARGS, handle: "response-other" },
      {
        ...RESPONSE_GET_CONTINUATION_ARGS,
        cursor: { offsetBytes: 8_191 },
      },
      { ...RESPONSE_GET_CONTINUATION_ARGS, full: true },
      { ...RESPONSE_GET_CONTINUATION_ARGS, raw: true },
      { ...RESPONSE_GET_CONTINUATION_ARGS, offsetBytes: 4_096 },
    ];

    for (const args of invalidContinuationArgs) {
      const invalid = structuredClone(page);
      invalid.nextAction.args.args = args;
      assert.equal(RetrieveOutputSchema.safeParse(invalid).success, false);
    }
  });

  it("validates every compact code success shape", () => {
    const range = { startLine: 1, startCol: 0, endLine: 3, endCol: 0 };
    const cases = [
      ["ordinary hot path", {
        file: "src/example.ts",
        range,
        excerpt: "export function example() {}",
        matchedIdentifiers: ["example"],
      }],
      ["truncated hot path", {
        file: "src/example.ts",
        range,
        excerpt: "export function example() {}",
        matchedIdentifiers: ["example"],
        truncated: true,
        nextAction: {
          action: "sdl.retrieve",
          args: {
            repoId: "repo",
            op: "codeHotPath",
            args: {
              symbolId: "sym",
              identifiersToFind: ["example"],
              maxTokens: 400,
            },
          },
        },
      }],
      ["cached hot path", {
        file: "src/example.ts",
        range,
        ref: { key: "code:hot-path", etag: "etag-1" },
        unchanged: true,
        matchedIdentifiers: ["example"],
      }],
      ["identifier miss hot path", {
        file: "src/example.ts",
        range,
        excerpt: "",
        matchedIdentifiers: [],
        missedIdentifiers: ["absent"],
        missedIdentifierHint: "No requested identifiers matched.",
      }],
      ["ordinary skeleton", {
        file: "src/example.ts",
        range,
        skeleton: "export function example() {}",
      }],
      ["truncated skeleton", {
        file: "src/example.ts",
        range,
        skeleton: "export function example() {}",
        truncated: true,
        truncation: {
          truncated: true,
          droppedCount: 4,
          howToResume: {
            type: "cursor",
            value: 2,
            parameter: "skeletonOffset",
            repeatOriginalRequest: true,
          },
        },
      }],
      ["response handle", {
        responseMode: "handle",
        kind: "responseArtifact",
        handle: "artifact-1",
        action: "response.get",
        metadata: {
          toolName: "sdl.retrieve",
          originalBytes: 12_000,
          contentKind: "json",
        },
      }],
    ] as const;

    const failures = cases.flatMap(([name, value]) => {
      const parsed = RetrieveOutputSchema.safeParse(value);
      return parsed.success ? [] : [name + ": " + parsed.error.message];
    });
    assert.deepEqual(failures, []);

    assert.equal(
      RetrieveOutputSchema.safeParse({
        file: "src/example.ts",
        range,
        excerpt: "export function example() {}",
        matchedIdentifiers: ["example"],
        truncated: true,
        nextAction: {
          id: "sdl.retrieve",
          args: { repoId: "repo", op: "codeHotPath" },
        },
      }).success,
      false,
    );
  });

  it("publishes ordered any-of variants that accept representative args", () => {
    const actionMap = createActionMap(undefined, undefined);
    const schema = buildRetrieveWireSchema(actionMap);
    assert.ok(!("oneOf" in schema));
    assert.ok(!("anyOf" in schema));
    assert.ok(!("allOf" in schema));
    const properties = schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    const argsSchema = properties.args;
    assert.ok(!("oneOf" in argsSchema));
    const variants = argsSchema.anyOf as Array<Record<string, unknown>>;
    const cases = [
      ["symbolSearch", { query: "executeWorkflow" }],
      ["symbolGetCard", { symbolId: "sym" }],
      ["sliceBuild", { taskText: "debug foo" }],
      ["codeSkeleton", { file: "src/main.ts" }],
      ["codeHotPath", { symbolId: "sym", identifiersToFind: ["foo"] }],
      [
        "codeNeedWindow",
        {
          symbolId: "sym",
          reason: "Need the exact branch.",
          expectedLines: 20,
          identifiersToFind: ["foo"],
        },
      ],
      [
        "responseGet",
        { handle: "response-repo-1784866000000-deadbeefdeadbeef" },
      ],
    ] as const;

    assert.strictEqual(variants.length, cases.length);
    cases.forEach(([op, args], index) => {
      assert.strictEqual(variants[index]?.title, op);
      const action = actionMap[RETRIEVE_ACTION_BY_OP[op]];
      assert.ok(action);
      const result = action.schema.safeParse({ repoId: "repo", ...args });
      assert.equal(result.success, true, `${op} args must match its variant`);
    });

    const responseGet = variants.find(
      (variant) => variant.title === "responseGet",
    );
    assert.ok(responseGet);
    const responseGetProperties = responseGet.properties as Record<
      string,
      unknown
    >;
    assert.ok("handle" in responseGetProperties);
    assert.ok(!("repoId" in responseGetProperties));
    assert.deepEqual(responseGet.required, ["handle"]);
    assert.ok(!(responseGet.required as string[]).includes("repoId"));
  });

  it("validates args against the selected operation at dispatch", async () => {
    await assert.rejects(
      () =>
        handleRetrieve(
          {
            repoId: "repo",
            op: "symbolSearch",
            args: { symbolId: "sym" },
          },
          createActionMap(undefined, undefined),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(
          error.message,
          /Either 'query' or 'pattern' must be provided/,
        );
        assert.deepEqual(
          (error as ValidationError & { details?: unknown }).details,
          [
            {
              path: "args",
              message: "Either 'query' or 'pattern' must be provided",
            },
          ],
        );
        return true;
      },
    );
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

  it("defaults symbolSearch to packed/auto output", async () => {
    const result = await handleRetrieve(
      { repoId: "repo", op: "symbolSearch", args: { query: "foo" } },
      {
        "symbol.search": {
          schema: z.object({
            repoId: z.string(),
            query: z.string(),
            wireFormat: z.literal("auto"),
          }),
          handler: async (args: unknown) => args,
        },
      } as never,
    );
    assert.deepEqual(result, {
      repoId: "repo",
      query: "foo",
      wireFormat: "auto",
    });
  });

  it("defaults sliceBuild to compact auto output", async () => {
    const result = await handleRetrieve(
      { repoId: "repo", op: "sliceBuild", args: { taskText: "debug foo" } },
      {
        "slice.build": {
          schema: z.object({
            repoId: z.string(),
            taskText: z.string(),
            wireFormat: z.literal("auto"),
            cardDetail: z.literal("compact"),
            includeLegend: z.literal(false),
            includeRetrievalEvidence: z.literal(false),
            includeProcesses: z.literal(false),
          }),
          handler: async (args: unknown) => args,
        },
      } as never,
    );
    assert.deepEqual(result, {
      repoId: "repo",
      taskText: "debug foo",
      wireFormat: "auto",
      cardDetail: "compact",
      includeLegend: false,
      includeRetrievalEvidence: false,
      includeProcesses: false,
    });
  });

  it("defaults codeNeedWindow to auto response handles without weakening justification", async () => {
    const result = await handleRetrieve(
      {
        repoId: "repo",
        op: "codeNeedWindow",
        args: {
          symbolId: "sym",
          reason: "Need exact branch condition.",
          expectedLines: 20,
          identifiersToFind: ["branch"],
        },
      },
      {
        "code.needWindow": {
          schema: z.object({
            repoId: z.string(),
            symbolId: z.string(),
            reason: z.string(),
            expectedLines: z.number(),
            identifiersToFind: z.array(z.string()),
            responseMode: z.literal("auto"),
          }),
          handler: async (args: unknown) => args,
        },
      } as never,
    );
    assert.deepEqual(result, {
      repoId: "repo",
      symbolId: "sym",
      reason: "Need exact branch condition.",
      expectedLines: 20,
      identifiersToFind: ["branch"],
      responseMode: "auto",
    });
  });

  it("maps codeSkeleton filePath args to the gateway file field", async () => {
    const calls: unknown[] = [];
    const actionMap = {
      "code.getSkeleton": {
        schema: z
          .object({
            repoId: z.string(),
            file: z.string(),
            exportedOnly: z.boolean().optional(),
          })
          .passthrough(),
        handler: async (args: unknown) => {
          calls.push(args);
          return { skeleton: "export function parse() { ... }" };
        },
      },
    };

    const result = await handleRetrieve(
      {
        repoId: "repo",
        op: "codeSkeleton",
        args: {
          filePath: "src/mcp/tools/search-edit/signature.ts",
          exportedOnly: false,
        },
      },
      actionMap as never,
    );

    assert.deepEqual(result, { skeleton: "export function parse() { ... }" });
    assert.deepEqual(calls, [
      {
        repoId: "repo",
        file: "src/mcp/tools/search-edit/signature.ts",
        exportedOnly: false,
      },
    ]);
  });

  it("dispatches through the existing action map and returns the handler result directly", async () => {
    const calls: unknown[] = [];
    const actionMap = {
      "symbol.search": {
        schema: z
          .object({
            repoId: z.string(),
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
        query: "foo",
        wireFormat: "auto",
      },
    ]);
    assert.equal(Object.hasOwn(result as object, "totalTokens"), false);
    assert.equal(Object.hasOwn(result as object, "durationMs"), false);
    assert.equal(Object.hasOwn(result as object, "intermediateResultsSuppressed"), false);
  });

  it("uses the trusted envelope repoId for responseGet dispatch", async () => {
    const calls: unknown[] = [];
    const handle = "response-trusted-repo-1784866000000-deadbeefdeadbeef";
    const result = await handleRetrieve(
      {
        repoId: "trusted-repo",
        op: "responseGet",
        args: { repoId: "attacker-repo", handle },
      },
      {
        "response.get": {
          schema: z
            .object({ repoId: z.string(), handle: z.string() })
            .strict(),
          handler: async (args: unknown) => {
            calls.push(args);
            return { ok: true };
          },
        },
      } as never,
    );

    assert.deepEqual(calls, [{ repoId: "trusted-repo", handle }]);
    assert.deepEqual(result, { ok: true });
  });

  it("reports nested action validation failures as actionable validation errors", async () => {
    await assert.rejects(
      () =>
        handleRetrieve(
          { repoId: "repo", op: "codeHotPath", args: { symbolId: "sym" } },
          {
            "code.getHotPath": {
              schema: z.object({
                repoId: z.string(),
                symbolId: z.string(),
                identifiersToFind: z.array(z.string()).min(1),
              }),
              handler: async (args: unknown) => args,
            },
          } as never,
        ),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /args\.identifiersToFind/);
        assert.deepEqual(
          (error as ValidationError & { details?: unknown }).details,
          [
            {
              path: "args.identifiersToFind",
              message: "Invalid input: expected array, received undefined",
            },
          ],
        );
        return true;
      },
    );
  });

  it("rejects unknown nested slice budget fields with an actionable path", async () => {
    await assert.rejects(
      () =>
        handleRetrieve(
          {
            repoId: "repo",
            op: "sliceBuild",
            args: {
              taskText: "debug foo",
              budget: { maxTokens: 1234 },
            },
          },
          {
            "slice.build": {
              schema: SliceBuildRequestSchema,
              handler: async (args: unknown) => args,
            },
          } as never,
        ),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.deepEqual(
          (error as ValidationError & { details?: unknown }).details,
          [
            {
              path: "args.budget",
              message: 'Unrecognized key: "maxTokens"',
            },
          ],
        );
        return true;
      },
    );
  });

  it("does not forward diagnostics through retrieve actions", async () => {
    const calls: unknown[] = [];
    const actionMap = {
      "symbol.search": {
        schema: z
          .object({
            repoId: z.string(),
            query: z.string(),
            wireFormat: z.literal("auto"),
          })
          .passthrough(),
        handler: async (args: unknown) => {
          calls.push(args);
          return { results: [] };
        },
      },
    };

    await handleRetrieve(
      {
        repoId: "repo",
        op: "symbolSearch",
        args: { query: "foo" },
        includeDiagnostics: true,
      },
      actionMap as never,
    );

    assert.deepEqual(calls, [
      {
        repoId: "repo",
        query: "foo",
        wireFormat: "auto",
      },
    ]);
  });

  it("projects exclusive recovery guidance onto callable Code Mode gateways", async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
      },
    };
    const actionMap = {
      "code.needWindow": {
        schema: z.object({ repoId: z.string(), symbolId: z.string() }).passthrough(),
        handler: async () => ({
          approved: true,
          whyDenied: [
            'Try sdl.retrieve op:"codeSkeleton" or sdl.symbol.getCard instead.',
          ],
          downgradeGuidance:
            "Set policy.allowBreakGlass=true via sdl.policy.set, or call sdl.code.getSkeleton.",
          nextBestAction: {
            tool: "sdl.code.getHotPath",
            args: {
              repoId: "repo",
              symbolId: "sym",
              identifiersToFind: ["run"],
            },
          },
        }),
      },
    };

    registerCodeModeTools(
      fakeServer as never,
      {},
      { ...createTestConfig(), exclusive: true },
      actionMap as never,
    );
    const result = await handlers.get("sdl.retrieve")?.({
      repoId: "repo",
      op: "codeNeedWindow",
      args: {
        symbolId: "sym",
        reason: "Need the guarded branch.",
        expectedLines: 20,
        identifiersToFind: ["run"],
      },
    });
    const projected = JSON.stringify(result);

    assert.doesNotMatch(
      projected,
      /sdl\.(?:code\.(?:getSkeleton|getHotPath)|symbol\.(?:search|getCard)|policy\.set)/,
    );
    assert.match(projected, /sdl\.retrieve/);
    assert.match(projected, /op:\\"symbolGetCard/);
    assert.match(projected, /sdl\.workflow/);
  });

  it("projects exclusive recovery errors without changing their type", async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
      },
    };
    const originalError = Object.assign(
      new ValidationError("Symbol not found. Use sdl.symbol.search."),
      {
        fallbackTools: ["sdl.symbol.search", "sdl.action.search"],
        fallbackRationale: "Use sdl.symbol.search to find the symbol.",
      },
    );
    const actionMap = {
      "symbol.search": {
        schema: z.object({ repoId: z.string(), query: z.string() }).passthrough(),
        handler: async () => {
          throw originalError;
        },
      },
    };

    registerCodeModeTools(
      fakeServer as never,
      {},
      { ...createTestConfig(), exclusive: true },
      actionMap as never,
    );

    await assert.rejects(
      () =>
        handlers.get("sdl.retrieve")?.({
          repoId: "repo",
          op: "symbolSearch",
          args: { query: "missing" },
        }) as Promise<unknown>,
      (error: unknown) => {
        assert.strictEqual(error, originalError);
        const projected = JSON.stringify({
          message: (error as Error).message,
          fallbackTools: (error as typeof originalError).fallbackTools,
          fallbackRationale: (error as typeof originalError).fallbackRationale,
        });
        assert.doesNotMatch(
          projected,
          /sdl\.(?:code\.(?:getSkeleton|getHotPath)|symbol\.search|policy\.set)/,
        );
        assert.deepEqual((error as typeof originalError).fallbackTools, [
          "sdl.retrieve",
          "sdl.action.search",
        ]);
        assert.match(projected, /op:\\?"symbolSearch/);
        return true;
      },
    );
  });

  it("projects exclusive workflow recovery guidance onto callable gateways", async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
      },
    };
    const actionMap = {
      "code.needWindow": {
        schema: z.object({ repoId: z.string(), symbolId: z.string() }).passthrough(),
        handler: async () => ({
          approved: true,
          downgradeGuidance:
            "Set policy.allowBreakGlass=true via sdl.policy.set, or call sdl.code.getSkeleton.",
          nextBestAction: {
            tool: "sdl.code.getHotPath",
            args: {
              repoId: "repo",
              symbolId: "sym",
              identifiersToFind: ["run"],
            },
          },
        }),
      },
    };

    registerCodeModeTools(
      fakeServer as never,
      {},
      { ...createTestConfig(), exclusive: true },
      actionMap as never,
    );
    const result = await handlers.get("sdl.workflow")?.({
      repoId: "repo",
      steps: [
        {
          fn: "codeNeedWindow",
          args: {
            symbolId: "sym",
            reason: "Need the guarded branch.",
            expectedLines: 20,
            identifiersToFind: ["run"],
          },
        },
      ],
    });
    const projected = JSON.stringify(result);

    assert.doesNotMatch(
      projected,
      /sdl\.(?:code\.(?:getSkeleton|getHotPath)|symbol\.search|policy\.set)/,
    );
    assert.doesNotMatch(projected, /sdl\.retrieve/);
    assert.match(projected, /sdl\.workflow/);
  });

  it("projects exclusive workflow failure traces onto callable gateways", async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
      },
    };
    const actionMap = {
      "symbol.search": {
        schema: z.object({ repoId: z.string(), query: z.string() }).passthrough(),
        handler: async () => {
          throw new ValidationError(
            "Symbol not found. Use sdl.symbol.search to find valid IDs.",
          );
        },
      },
    };

    registerCodeModeTools(
      fakeServer as never,
      {},
      { ...createTestConfig(), exclusive: true },
      actionMap as never,
    );
    const result = await handlers.get("sdl.workflow")?.({
      repoId: "repo",
      steps: [
        {
          fn: "symbolSearch",
          args: { query: "missing" },
        },
      ],
    });
    const projected = JSON.stringify(result);

    assert.doesNotMatch(projected, /sdl\.symbol\.search/);
    assert.match(projected, /sdl\.retrieve/);
    assert.match(projected, /op:\\?"symbolSearch/);
  });

  it("preserves flat recovery guidance outside exclusive Code Mode", async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
      },
    };
    const payload = {
      downgradeGuidance: "Call sdl.code.getSkeleton.",
    };
    const actionMap = {
      "code.needWindow": {
        schema: z.object({ repoId: z.string(), symbolId: z.string() }).passthrough(),
        handler: async () => payload,
      },
    };

    registerCodeModeTools(
      fakeServer as never,
      {},
      createTestConfig(),
      actionMap as never,
    );
    const result = await handlers.get("sdl.retrieve")?.({
      repoId: "repo",
      op: "codeNeedWindow",
      args: {
        symbolId: "sym",
        reason: "Need the guarded branch.",
        expectedLines: 20,
        identifiersToFind: ["run"],
      },
    });

    assert.strictEqual(result, payload);
    assert.match(JSON.stringify(result), /sdl\.code\.getSkeleton/);
  });

  it("projects recovery references returned through workflow continuations", async () => {
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
      },
    };
    const recovery = Array.from({ length: 20 }, () => ({
      fallbackRationale: "Use sdl.symbol.search to recover.",
      nextBestAction: {
        tool: "sdl.code.getSkeleton",
        args: { repoId: "repo", symbolId: "sym" },
      },
      nextCalls: [
        {
          tool: "sdl.code.getHotPath",
          args: { repoId: "repo", symbolId: "sym" },
        },
      ],
    }));

    registerCodeModeTools(
      fakeServer as never,
      {},
      { ...createTestConfig(), exclusive: true },
      {} as never,
    );
    const result = await handlers.get("sdl.workflow")?.({
      repoId: "repo",
      steps: [
        {
          fn: "dataPick",
          args: {
            input: { recovery },
            fields: { recovery: "recovery" },
          },
          maxResponseTokens: 50,
        },
        {
          fn: "workflowContinuationGet",
          args: {
            handle: "$0.truncatedResponse.continuationHandle",
            path: "recovery",
            limit: 1,
          },
        },
      ],
    });
    const continuationData = (
      result as {
        results: Array<{ result?: { data?: unknown } }>;
      }
    ).results[1]?.result?.data;
    assert.doesNotMatch(
      JSON.stringify(continuationData),
      /sdl\.(?:code\.(?:getSkeleton|getHotPath)|symbol\.search|policy\.set)/,
    );
    assert.deepEqual(continuationData, [
      {
        fallbackRationale: 'Use sdl.retrieve op:"symbolSearch" to recover.',
        nextBestAction: {
          tool: "sdl.workflow",
          args: {
            repoId: "repo",
            steps: [
              {
                fn: "codeSkeleton",
                args: { symbolId: "sym", refsMode: "auto" },
              },
            ],
            onError: "continue",
            includeTelemetry: false,
          },
        },
      },
    ]);
  });

  it("leaves inherited action names unmapped while projecting valid next calls", () => {
    const inherited = { tool: "__proto__", args: { symbolId: "sym" } };
    const result = projectExclusiveCodeModeRecovery({
      nextBestAction: inherited,
      nextCalls: [
        { tool: "sdl.code.getSkeleton", args: { symbolId: "sym" } },
        inherited,
      ],
    }, "repo");

    assert.equal(result.nextBestAction, undefined);
    assert.deepEqual(result.nextCalls[0], {
      tool: "sdl.workflow",
      args: {
        repoId: "repo",
        steps: [
          {
            fn: "codeSkeleton",
            args: { symbolId: "sym", refsMode: "auto" },
          },
        ],
        onError: "continue",
        includeTelemetry: false,
      },
    });
    assert.equal(result.nextCalls.length, 1);
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
    const schemaSummary = JSON.stringify(retrieve.schemaSummary);
    assert.match(schemaSummary, /symbolSearch/);
    assert.match(schemaSummary, /codeNeedWindow/);
    assert.doesNotMatch(schemaSummary, /includeDiagnostics/);
  });
});
