import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerCodeModeTools } from "../../dist/code-mode/index.js";
import { registerTools } from "../../dist/mcp/tools/index.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { AgentContextRequestSchema } from "../../dist/mcp/tools.js";

describe("code-mode tool validation", () => {
  it("accepts the strict flat sdl.context v2 request", () => {
    const parsed = AgentContextRequestSchema.parse({
      repoId: "demo-repo",
      taskType: "explain",
      taskText: "explain handleSymbolSearch",
      budget: { maxTokens: 1234 },
      focusSymbols: ["handleSymbolSearch"],
      focusPaths: ["src/mcp/tools/symbol.ts"],
      chatMentions: ["handleSymbolSearch"],
      includeTests: false,
    });

    assert.deepEqual(parsed.budget, { maxTokens: 1234 });
    assert.deepEqual(parsed.focusSymbols, ["handleSymbolSearch"]);
    assert.deepEqual(parsed.focusPaths, ["src/mcp/tools/symbol.ts"]);
    assert.deepEqual(parsed.chatMentions, ["handleSymbolSearch"]);
    assert.equal(parsed.includeTests, false);
  });

  it("rejects every removed sdl.context budget field", () => {
    for (const field of [
      "maxEstimatedTokens",
      "maxActions",
      "maxDurationMs",
    ]) {
      const result = AgentContextRequestSchema.safeParse({
        repoId: "demo-repo",
        taskType: "explain",
        taskText: "explain handleSymbolSearch",
        budget: { maxTokens: 1234, [field]: 1234 },
      });

      assert.equal(result.success, false, field);
      if (result.success) continue;
      const issue = result.error.issues[0];
      assert.equal(issue?.code, "unrecognized_keys", field);
      assert.deepEqual(issue?.path, ["budget"], field);
      assert.deepEqual("keys" in issue ? issue.keys : undefined, [field], field);
    }
  });

  it("rejects every removed sdl.context root field", () => {
    const removedFields: Record<string, unknown> = {
      options: { answerFirst: true },
      contextMode: "precise",
      semantic: true,
      pprDirection: "both",
      pprWeight: 2,
      chatMentionWeights: { handleSymbolSearch: 1 },
      includeRetrievalEvidence: true,
      evidenceOptimization: "dedupe",
      answerFirst: true,
      cardDetail: "full",
      requireDiagnostics: true,
    };

    for (const [field, value] of Object.entries(removedFields)) {
      const result = AgentContextRequestSchema.safeParse({
        repoId: "demo-repo",
        taskType: "implement",
        taskText: "explain handleSymbolSearch",
        budget: { maxTokens: 1234 },
        [field]: value,
      });

      assert.equal(result.success, false, field);
      if (result.success) continue;
      const issue = result.error.issues[0];
      assert.equal(issue?.code, "unrecognized_keys", field);
      assert.deepEqual(issue?.path, [], field);
      assert.deepEqual("keys" in issue ? issue.keys : undefined, [field], field);
    }
    assert.equal(
      AgentContextRequestSchema.safeParse({
        repoId: "demo-repo",
        taskType: "implement",
        taskText: "explain handleSymbolSearch",
        budget: { maxTokens: 1234 },
        includeDiagnostics: true,
      }).success,
      true,
    );
  });

  it("requires the explicit sdl.context token budget", () => {
    const result = AgentContextRequestSchema.safeParse({
      repoId: "demo-repo",
      taskType: "explain",
      taskText: "explain handleSymbolSearch",
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.deepEqual(result.error.issues[0]?.path, ["budget"]);
  });

  it("registers truthful per-tool output schemas for top-level gateways", () => {
    type OutputSchema = {
      safeParse(value: unknown): { success: boolean };
    };
    const gatewayNames = [
      "sdl.retrieve",
      "sdl.workflow",
      "sdl.context",
      "sdl.file",
    ] as const;
    const outputSchemas = new Map<string, OutputSchema | undefined>();
    const validationSchemas = new Map<string, OutputSchema | undefined>();
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        _handler: (args: unknown) => Promise<unknown>,
        _wireSchema?: unknown,
        _annotations?: unknown,
        outputSchema?: OutputSchema,
        validationOutputSchema?: OutputSchema,
      ) {
        if (gatewayNames.includes(name as (typeof gatewayNames)[number])) {
          outputSchemas.set(name, outputSchema);
          validationSchemas.set(name, validationOutputSchema);
        }
      },
    };

    registerCodeModeTools(
      fakeServer as any,
      { liveIndex: undefined } as any,
      {
        enabled: true,
        exclusive: true,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 30_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    const representativeSuccesses = new Map<string, object[]>([
      [
        "sdl.retrieve",
        [
          { results: [] },
          { card: {} },
          { cards: [] },
          { slice: {} },
          { file: "src/main.ts" },
          { approved: true },
          { etag: "etag-demo" },
          { kind: "responseArtifact" },
        ],
      ],
      [
        "sdl.workflow",
        [{ results: [], totalTokens: 0, durationMs: 0, truncated: false }],
      ],
      [
        "sdl.context",
        [
          { status: "complete" },
          { isError: true },
          { notModified: true },
          {
            responseMode: "handle",
            kind: "responseArtifact",
            handle: "response-demo",
            action: "response.get",
            metadata: {
              handle: "response-demo",
              toolName: "sdl.context",
              originalBytes: 1,
              contentKind: "json",
            },
          },
        ],
      ],
      [
        "sdl.file",
        [
          { filePath: "README.md", content: "# Demo" },
          { mode: "preview", planHandle: "plan-demo" },
          { kind: "responseArtifact", handle: "response-demo" },
        ],
      ],
    ]);

    const schemas = gatewayNames.map((name) => outputSchemas.get(name));
    for (const [index, schema] of schemas.entries()) {
      const name = gatewayNames[index];
      assert.ok(schema, `missing ${name} output schema`);
      for (const success of representativeSuccesses.get(name) ?? []) {
        assert.equal(schema.safeParse(success).success, true, name);
      }
      const exhaustiveSchema = validationSchemas.get(name) ?? schema;
      assert.equal(
        exhaustiveSchema.safeParse({ actionSpecific: true }).success,
        false,
        `${name} must reject unknown-only objects`,
      );
      assert.equal(
        schema.safeParse([]).success,
        false,
        `${name} must reject arrays`,
      );
    }
    const retrieveValidationSchema = validationSchemas.get("sdl.retrieve");
    assert.ok(retrieveValidationSchema);
    assert.equal(
      retrieveValidationSchema.safeParse({
        results: [{ sessionId: "private" }],
      }).success,
      false,
    );
    assert.equal(new Set(schemas).size, gatewayNames.length);
  });

  it("advertises plan-bound file window operations in sdl.file wire schema", () => {
    let fileWireSchema: { properties?: Record<string, unknown> } | null = null;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        _handler: (args: unknown) => Promise<unknown>,
        wireSchema?: unknown,
      ) {
        if (name === "sdl.file") {
          fileWireSchema = wireSchema as { properties?: Record<string, unknown> };
        }
      },
    };

    registerCodeModeTools(
      fakeServer as any,
      { liveIndex: undefined } as any,
      {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 30_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    const properties = fileWireSchema?.properties as
      | Record<string, { enum?: string[] } | unknown>
      | undefined;
    assert.ok(properties);
    assert.deepEqual((properties.op as { enum: string[] }).enum, [
      "read",
      "write",
      "searchEditPreview",
      "searchEditApply",
      "symbolEditPreview",
      "symbolEditApply",
      "symbolEditApplyNow",
      "previewWindow",
      "sourceWindow",
    ]);
    for (const field of [
      "symbolId",
      "symbolRef",
      "operation",
      "expectedAstFingerprint",
      "expectedRange",
      "reason",
      "expectedLines",
      "identifiersToFind",
      "granularity",
      "maxTokens",
      "sliceContext",
      "cursor",
      "ifNoneMatch",
    ]) {
      assert.ok(field in properties, `missing ${field}`);
    }
  });

  it("includes plan-bound file window operations in sdl.manual schema output", async () => {
    let manualHandler: ((args: unknown) => Promise<unknown>) | null = null;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        if (name === "sdl.manual") {
          manualHandler = handler;
        }
      },
    };

    registerCodeModeTools(
      fakeServer as any,
      { liveIndex: undefined } as any,
      {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 30_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    assert.ok(manualHandler);
    const response = (await manualHandler({
      format: "json",
      actions: ["file"],
      includeSchemas: true,
      includeExamples: true,
    })) as {
      actions: Array<{
        action: string;
        example?: Record<string, unknown>;
        schemaSummary?: { fields: Array<{ name: string; enumValues?: string[] }> };
      }>;
    };

    const fileAction = response.actions.find((action) => action.action === "file");
    assert.ok(fileAction);
    assert.equal(fileAction.example?.op, "previewWindow");
    const opField = fileAction.schemaSummary?.fields.find(
      (field) => field.name === "op",
    );
    assert.deepEqual(opField?.enumValues, [
      "read",
      "write",
      "searchEditPreview",
      "searchEditApply",
      "symbolEditPreview",
      "symbolEditApply",
      "symbolEditApplyNow",
      "previewWindow",
      "sourceWindow",
    ]);
  });

  it("routes plan-bound file window operations through the sdl.file handler", async () => {
    let fileHandler: ((args: unknown) => Promise<unknown>) | null = null;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        if (name === "sdl.file") {
          fileHandler = handler;
        }
      },
    };

    registerCodeModeTools(
      fakeServer as any,
      { liveIndex: undefined } as any,
      {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 30_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    assert.ok(fileHandler);
    const handler = fileHandler;
    for (const op of ["previewWindow", "sourceWindow"] as const) {
      await assert.rejects(
        () =>
          handler({
            op,
            repoId: "demo-repo",
            planHandle: "missing-plan",
            symbolId: "deadbeef",
            reason: "Inspect planned source edit",
            expectedLines: 12,
            identifiersToFind: ["targetFunction"],
          }),
        (error: unknown) => {
          const notFound = error as { name?: string; message?: string };
          assert.equal(notFound.name, "NotFoundError");
          assert.match(
            notFound.message ?? "",
            /Edit plan not found or expired: missing-plan/,
          );
          return true;
        },
      );
    }
  });

  it("executes info as an sdl.workflow action", async () => {
    let workflowHandler: ((args: unknown) => Promise<unknown>) | null = null;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        if (name === "sdl.workflow") {
          workflowHandler = handler;
        }
      },
    };

    registerCodeModeTools(
      fakeServer as any,
      { liveIndex: undefined } as any,
      {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 30_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    assert.ok(workflowHandler);
    const response = await workflowHandler({
      repoId: "demo-repo",
      onError: "stop",
      steps: [{ fn: "info", args: { redactPaths: true } }],
    }) as { results?: Array<{ fn?: string; result?: Record<string, unknown> }> };
    assert.equal(response.results?.[0]?.fn, "info");
    assert.equal(typeof response.results?.[0]?.result?.version, "string");

    for (const fn of ["notARealFunction", "sdl.info"]) {
      await assert.rejects(
        () =>
          workflowHandler?.({
            repoId: "demo-repo",
            onError: "stop",
            steps: [{ fn, args: {} }],
          }),
        (error: unknown) => {
          const validationError = error as {
            code?: string;
            details?: string[];
            message?: string;
          };
          assert.strictEqual(validationError.code, "VALIDATION_ERROR");
          assert.ok(
            validationError.message?.includes("Invalid sdl.workflow request"),
          );
          assert.ok(
            validationError.details?.some((detail) =>
              detail.includes(`unknown function '${fn}'`),
            ),
          );
          return true;
        },
      );
    }
  });

  it("omits disabled memory tools from sdl.manual catalog output", async () => {
    let manualHandler: ((args: unknown) => Promise<unknown>) | null = null;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        if (name === "sdl.manual") {
          manualHandler = handler;
        }
      },
    };

    const originalSdlConfig = process.env.SDL_CONFIG;
    const tmpDir = mkdtempSync(join(tmpdir(), "sdl-manual-disabled-"));
    try {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [
            { repoId: "test", rootPath: tmpDir, memory: { enabled: false } },
          ],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;
      invalidateConfigCache();

      registerCodeModeTools(
        fakeServer as any,
        { liveIndex: undefined } as any,
        {
          enabled: true,
          exclusive: false,
          maxWorkflowSteps: 20,
          maxWorkflowTokens: 50_000,
          maxWorkflowDurationMs: 30_000,
          ladderValidation: "warn",
          etagCaching: true,
        },
      );

      assert.ok(manualHandler);
      const response = (await manualHandler({
        format: "json",
        includeSchemas: false,
        includeExamples: false,
      })) as { actions: Array<{ action: string; disabled?: boolean }> };

      assert.ok(response.actions.length > 0);
      assert.equal(
        response.actions.some((action) => action.disabled),
        false,
      );
      assert.equal(
        response.actions.some((action) => action.action.startsWith("memory.")),
        false,
      );
    } finally {
      if (originalSdlConfig !== undefined) {
        process.env.SDL_CONFIG = originalSdlConfig;
      } else {
        delete process.env.SDL_CONFIG;
      }
      invalidateConfigCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

it("keeps sdl.info callable and discoverable in exclusive Code Mode", async () => {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const fakeServer = {
    registerPostDispatchHook() {},
    registerTool(
      name: string,
      _description: string,
      _schema: unknown,
      handler: (args: unknown) => Promise<unknown>,
    ) {
      handlers.set(name, handler);
    },
  };

  registerTools(
    fakeServer as any,
    { actionAvailability: { memoryTools: false } } as any,
    undefined,
    {
      enabled: true,
      exclusive: true,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50_000,
      maxWorkflowDurationMs: 30_000,
      ladderValidation: "warn",
      etagCaching: true,
    },
  );

  assert.ok(handlers.has("sdl.info"));

  const searchResponse = (await handlers.get("sdl.action.search")?.({
    query: "sdl.info server information version capabilities",
    limit: 5,
  })) as { actions: Array<{ action: string }> };
  assert.equal(searchResponse.actions[0]?.action, "info");

  const manualResponse = (await handlers.get("sdl.manual")?.({
    format: "json",
    actions: ["info"],
  })) as { actions: Array<{ action: string }> };
  assert.deepEqual(manualResponse.actions.map((action) => action.action), ["info"]);
});

it("labels top-level-only Code Mode gateways instead of workflow functions", async () => {
  let manualHandler: ((args: unknown) => Promise<unknown>) | undefined;
  const fakeServer = {
    registerTool(
      name: string,
      _description: string,
      _schema: unknown,
      handler: (args: unknown) => Promise<unknown>,
    ) {
      if (name === "sdl.manual") manualHandler = handler;
    },
  };

  registerCodeModeTools(
    fakeServer as any,
    { actionAvailability: { memoryTools: false, infoTool: true } } as any,
    {
      enabled: true,
      exclusive: true,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50_000,
      maxWorkflowDurationMs: 30_000,
      ladderValidation: "warn",
      etagCaching: true,
    },
  );

  assert.ok(manualHandler);
  const response = (await manualHandler({
    format: "typescript",
    actions: ["context", "retrieve", "file", "manual"],
    includeSchemas: true,
  })) as { manual: string };

  for (const action of ["context", "retrieve", "file", "manual"]) {
    assert.match(
      response.manual,
      new RegExp(`Top-level only: call sdl\\.${action} directly`),
    );
    assert.doesNotMatch(response.manual, new RegExp(`function ${action}\\(`));
  }
});
