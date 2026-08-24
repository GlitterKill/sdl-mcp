import { describe, it } from "node:test";
import assert from "node:assert";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../../dist/mcp/tools/index.js";
import { MCPServer } from "../../dist/server.js";
import { getVersion } from "../../dist/cli/commands/version.js";
import { WorkflowRequestSchema } from "../../dist/code-mode/types.js";
import { buildCompactJsonSchema } from "../../dist/gateway/compact-schema.js";

const TEST_PROJECTION_PROFILE = Object.freeze({
  projector: "generic",
  observabilityProfile: "standard",
  defaultDetail: "compact",
  budgetClass: "compact",
  largeResponseStrategy: "truncate",
  recoveryPolicy: "none",
} as const);

type ListToolsHandler = (
  request: { method: "tools/list" },
  extra: Record<string, unknown>,
) => Promise<{ tools: Array<Record<string, unknown>> }>;

type CallToolHandler = (
  request: {
    method: "tools/call";
    params: { name: string; arguments?: Record<string, unknown> };
  },
  extra: {
    _meta: Record<string, unknown>;
    sendNotification: () => Promise<void>;
    signal: AbortSignal;
  },
) => Promise<Record<string, unknown>>;

function getRequestHandler<T>(server: MCPServer, method: string): T {
  const sdkServer = server.getServer() as unknown as {
    _requestHandlers: Map<string, T>;
  };
  const handler = sdkServer._requestHandlers.get(method);
  assert.ok(handler, `${method} handler should be registered`);
  return handler;
}

interface RegisteredToolCall {
  name: string;
  description?: string;
  wireSchema?: Record<string, unknown>;
  outputSchema?: unknown;
  presentation?: { title?: string };
  handler?: (args: unknown) => unknown;
}

function makeFakeServer(): { names: string[]; tools: RegisteredToolCall[]; server: any } {
  const names: string[] = [];
  const tools: RegisteredToolCall[] = [];
  const server = {
    gatewayMode: false,
    registerTool(
      name: string,
      description?: string,
      _inputSchema?: unknown,
      handler?: (args: unknown) => unknown,
      wireSchema?: Record<string, unknown>,
      presentation?: { title?: string },
      outputSchema?: unknown,
    ): void {
      names.push(name);
      tools.push({
        name,
        description,
        wireSchema,
        outputSchema,
        presentation,
        handler,
      });
    },
    registerPostDispatchHook(): void {},
  };
  return { names, tools, server };
}

describe("MCP tool registration", () => {
  it("advertises flat union output schemas with an object root", async () => {
    const mcpServer = new MCPServer({
      resolveProjectionProfile: (action) =>
        action === "sdl.test.union-output" ? TEST_PROJECTION_PROFILE : undefined,
    });
    mcpServer.registerTool(
      "sdl.test.union-output",
      "Union output",
      z.object({}),
      async () => ({ kind: "first", value: "ok" }),
      undefined,
      undefined,
      z.union([
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("first"), value: z.string() }),
          z.object({ kind: z.literal("second"), count: z.number() }),
        ]),
        z.object({
          responseMode: z.literal("handle"),
          handle: z.string(),
        }),
      ]),
    );

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      mcpServer.getServer().connect(serverTransport),
    ]);

    try {
      const listed = await client.listTools();
      const tool = listed.tools.find(
        (candidate) => candidate.name === "sdl.test.union-output",
      );
      const outputSchema = tool?.outputSchema as
        | Record<string, unknown>
        | undefined;

      assert.equal(outputSchema?.type, "object");
      assert.equal(outputSchema && "anyOf" in outputSchema, false);
      assert.equal(outputSchema && "oneOf" in outputSchema, false);
      assert.equal(outputSchema && "allOf" in outputSchema, false);
    } finally {
      await client.close();
    }
  });

  it("advertises generic errors without weakening a strict success schema", async () => {
    const mcpServer = new MCPServer({
      resolveProjectionProfile: (action) =>
        action === "sdl.test.strict-output" ? TEST_PROJECTION_PROFILE : undefined,
    });
    const inputSchema = z.object({
      mode: z.enum(["success", "error", "invalid"]),
    });
    mcpServer.registerTool(
      "sdl.test.strict-output",
      "Strict output",
      inputSchema,
      async (args) => {
        const { mode } = inputSchema.parse(args);
        if (mode === "error") throw new Error("test failure");
        return mode === "invalid"
          ? { ok: true }
          : { ok: true, value: "valid" };
      },
      undefined,
      undefined,
      z
        .object({
          ok: z.literal(true),
          value: z.string(),
        })
        .strict(),
    );

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      mcpServer.getServer().connect(serverTransport),
    ]);

    try {
      await client.listTools();

      const success = await client.callTool({
        name: "sdl.test.strict-output",
        arguments: { mode: "success" },
      });
      assert.notEqual(success.isError, true);

      const failure = await client.callTool({
        name: "sdl.test.strict-output",
        arguments: { mode: "error" },
      });
      assert.equal(failure.isError, true);
      const error = failure.structuredContent as {
        error?: { message?: string; code?: string };
      };
      assert.equal(
        error.error?.message,
        "An internal error occurred. Check server logs for details.",
      );
      assert.equal(error.error?.code, undefined);

      await assert.rejects(
        client.callTool({
          name: "sdl.test.strict-output",
          arguments: { mode: "invalid" },
        }),
        /Structured content does not match.+value/u,
      );
    } finally {
      await client.close();
    }
  });

  it("validates composite results internally while advertising a bounded outer schema", async () => {
    const mcpServer = new MCPServer();
    const inputSchema = z.object({ invalid: z.boolean().default(false) });
    const advertisedOutputSchema = z
      .object({
        error: z.unknown().optional(),
        nextAction: z.unknown().optional(),
        results: z.unknown().optional(),
      })
      .strict();
    const internalOutputSchema = z
      .object({
        results: z.array(z.object({ name: z.string() }).strict()),
      })
      .strict();
    mcpServer.registerTool(
      "sdl.retrieve",
      "Composite validation test",
      inputSchema,
      async (args) => {
        const { invalid } = inputSchema.parse(args);
        return {
          results: [
            invalid ? { name: "ok", sessionId: "private" } : { name: "ok" },
          ],
        };
      },
      undefined,
      undefined,
      advertisedOutputSchema,
      internalOutputSchema,
    );

    const listed = await getRequestHandler<ListToolsHandler>(
      mcpServer,
      "tools/list",
    )({ method: "tools/list" }, {});
    const advertised = listed.tools.find(
      (tool) => tool.name === "sdl.retrieve",
    )?.outputSchema;
    assert.ok(advertised);
    assert.ok(Buffer.byteLength(JSON.stringify(advertised), "utf8") <= 512);

    const callTool = getRequestHandler<CallToolHandler>(
      mcpServer,
      "tools/call",
    );
    const extra = {
      _meta: {},
      sendNotification: async (): Promise<void> => {},
      signal: new AbortController().signal,
    };
    const valid = await callTool(
      {
        method: "tools/call",
        params: { name: "sdl.retrieve", arguments: { invalid: false } },
      },
      extra,
    );
    assert.notEqual(valid.isError, true);

    const invalid = await callTool(
      {
        method: "tools/call",
        params: { name: "sdl.retrieve", arguments: { invalid: true } },
      },
      extra,
    );
    assert.equal(invalid.isError, true);
  });

  it("registers sdl.info with a human title", () => {
    const { tools, server } = makeFakeServer();

    registerTools(server as any);

    const infoTool = tools.find((tool) => tool.name === "sdl.info");
    assert.ok(infoTool, "expected sdl.info to be registered");
    assert.strictEqual(infoTool.presentation?.title, "SDL Info");
  });

  it("advertises all 34 structured tools in stable order with object-root output schemas", async () => {
    const mcpServer = new MCPServer();
    registerTools(mcpServer, {
      actionAvailability: { memoryTools: false },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      mcpServer.getServer().connect(serverTransport),
    ]);

    try {
      const listed = await client.listTools();
      const expectedNames = [
        "sdl.action.search",
        "sdl.info",
        "sdl.repo.register",
        "sdl.repo.status",
        "sdl.repo.unregister",
        "sdl.index.refresh",
        "sdl.repo.overview",
        "sdl.buffer.push",
        "sdl.buffer.checkpoint",
        "sdl.buffer.status",
        "sdl.symbol.search",
        "sdl.symbol.getCard",
        "sdl.symbol.edit",
        "sdl.slice.build",
        "sdl.slice.refresh",
        "sdl.slice.spillover.get",
        "sdl.delta.get",
        "sdl.code.needWindow",
        "sdl.code.getSkeleton",
        "sdl.code.getHotPath",
        "sdl.policy.get",
        "sdl.policy.set",
        "sdl.pr.risk.analyze",
        "sdl.agent.feedback",
        "sdl.agent.feedback.query",
        "sdl.runtime.execute",
        "sdl.runtime.queryOutput",
        "sdl.response.get",
        "sdl.usage.stats",
        "sdl.file.read",
        "sdl.file.write",
        "sdl.semantic.enrichment.refresh",
        "sdl.semantic.enrichment.status",
        "sdl.search.edit",
      ];
      assert.deepStrictEqual(
        listed.tools.map((tool) => tool.name),
        expectedNames,
      );
      for (const tool of listed.tools) {
        const outputSchema = tool.outputSchema;
        assert.ok(outputSchema, `${tool.name} output schema`);
        assert.strictEqual(
          outputSchema.type,
          "object",
          `${tool.name} output schema root`,
        );
        assert.strictEqual("anyOf" in outputSchema, false, tool.name);
        assert.strictEqual("oneOf" in outputSchema, false, tool.name);
        assert.strictEqual("allOf" in outputSchema, false, tool.name);
      }
    } finally {
      await client.close();
    }
  });

  it("preserves gateway wire schemas with action-specific fields and descriptions", () => {
    const { tools, server } = makeFakeServer();

    registerTools(server as any, {}, { enabled: true, emitLegacyTools: false });

    const queryTool = tools.find((tool) => tool.name === "sdl.query");
    assert.ok(queryTool?.wireSchema, "expected sdl.query wire schema");
    const wireSchema = queryTool.wireSchema as Record<string, unknown>;
    assert.ok(!("oneOf" in wireSchema), "top-level oneOf is not API-compatible");
    assert.ok(!("anyOf" in wireSchema), "top-level anyOf is not API-compatible");
    assert.ok(!("allOf" in wireSchema), "top-level allOf is not API-compatible");

    const properties = wireSchema.properties as Record<string, unknown>;
    const action = properties.action as Record<string, unknown>;
    assert.ok(
      Array.isArray(action.enum) && action.enum.includes("slice.build"),
      "expected slice.build gateway action",
    );
    assert.match(
      JSON.stringify(wireSchema),
      /Natural language task description|Repository ID|Gateway action name/,
    );
  });

  it("keeps tool descriptions version-stamped at registration time", () => {
    const { tools, server } = makeFakeServer();

    registerTools(server as any);

    const repoStatus = tools.find((tool) => tool.name === "sdl.repo.status");
    assert.ok(repoStatus, "expected sdl.repo.status to be registered");
    assert.ok(repoStatus.description?.length, "expected description to be present");
    assert.match(repoStatus.description ?? "", /repository/i);
    assert.ok(getVersion().length > 0, "package version should resolve");
  });

  it("registers output schemas for every flat tool", () => {
    const { tools: stableTools, server: stableServer } = makeFakeServer();
    registerTools(stableServer as any);

    const requiredFlatTools = [
      "sdl.repo.register",
      "sdl.repo.status",
      "sdl.repo.overview",
      "sdl.repo.unregister",
      "sdl.index.refresh",
      "sdl.buffer.push",
      "sdl.buffer.checkpoint",
      "sdl.buffer.status",
      "sdl.symbol.search",
      "sdl.symbol.getCard",
      "sdl.symbol.edit",
      "sdl.slice.build",
      "sdl.slice.refresh",
      "sdl.slice.spillover.get",
      "sdl.delta.get",
      "sdl.code.needWindow",
      "sdl.code.getSkeleton",
      "sdl.code.getHotPath",
      "sdl.policy.get",
      "sdl.policy.set",
      "sdl.pr.risk.analyze",
      "sdl.agent.feedback",
      "sdl.agent.feedback.query",
      "sdl.response.get",
      "sdl.usage.stats",
      "sdl.runtime.execute",
      "sdl.runtime.queryOutput",
      "sdl.file.read",
      "sdl.file.write",
      "sdl.semantic.enrichment.refresh",
      "sdl.semantic.enrichment.status",
      "sdl.search.edit",
    ];

    for (const name of requiredFlatTools) {
      const tool = stableTools.find((candidate) => candidate.name === name);
      assert.ok(tool, `expected ${name} to be registered`);
      assert.ok(tool.outputSchema, `expected ${name} output schema`);
    }

    const { tools: codeTools, server: codeServer } = makeFakeServer();
    registerTools(
      codeServer as any,
      {},
      undefined,
      { enabled: true, exclusive: true } as any,
    );

    const actionSearch = codeTools.find((tool) => tool.name === "sdl.action.search");
    const manual = codeTools.find((tool) => tool.name === "sdl.manual");
    assert.ok(actionSearch?.outputSchema, "expected action.search output schema");
    assert.ok(manual?.outputSchema, "expected manual output schema");
  });

  it("registers live buffer tools alongside existing slice tools", () => {
    const { names, server } = makeFakeServer();

    registerTools(server as any);

    assert.ok(
      names.includes("sdl.slice.refresh"),
      "expected sdl.slice.refresh to be registered",
    );
    assert.ok(
      names.includes("sdl.buffer.push"),
      "expected sdl.buffer.push to be registered",
    );
    assert.ok(
      names.includes("sdl.buffer.checkpoint"),
      "expected sdl.buffer.checkpoint to be registered",
    );
    assert.ok(
      names.includes("sdl.buffer.status"),
      "expected sdl.buffer.status to be registered",
    );
  });

  it("registers code-mode tools alongside flat tools when enabled + non-exclusive", () => {
    const { names, server } = makeFakeServer();

    registerTools(server as any, {}, undefined, {
      enabled: true,
      exclusive: false,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50000,
      maxWorkflowDurationMs: 30000,
      ladderValidation: "warn",
      etagCaching: true,
    });

    // Flat tools should still be present
    assert.ok(
      names.includes("sdl.repo.register"),
      "expected flat tool sdl.repo.register",
    );
    assert.ok(
      names.includes("sdl.symbol.search"),
      "expected flat tool sdl.symbol.search",
    );

    // Code-mode tools should also be present
    assert.ok(
      names.includes("sdl.manual"),
      "expected sdl.manual to be registered alongside flat tools",
    );
    assert.ok(
      names.includes("sdl.action.search"),
      "expected sdl.action.search to be registered alongside flat tools",
    );
    assert.ok(
      names.includes("sdl.workflow"),
      "expected sdl.workflow to be registered alongside flat tools",
    );
    assert.ok(
      names.includes("sdl.context"),
      "expected sdl.context to be registered alongside flat tools",
    );
    assert.ok(
      names.includes("sdl.retrieve"),
      "expected sdl.retrieve to be registered alongside flat tools",
    );
  });

  it("publishes schema detail parity for action search and manual", () => {
    const { tools, server } = makeFakeServer();

    registerTools(server as any, {}, undefined, {
      enabled: true,
      exclusive: false,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50000,
      maxWorkflowDurationMs: 30000,
      ladderValidation: "warn",
      etagCaching: true,
    });

    for (const name of ["sdl.action.search", "sdl.manual"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool?.wireSchema, `expected ${name} wire schema`);
      const properties = tool.wireSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      assert.deepStrictEqual(properties.detail?.enum, [
        "compact",
        "standard",
        "full",
      ]);
      assert.strictEqual(properties.detail?.default, "compact");
      if (name === "sdl.action.search") {
        assert.deepStrictEqual(properties.maxTokens, {
          type: "integer",
          minimum: 500,
          maximum: 32000,
          default: 4000,
        });
      }
    }
  });

  it("publishes refsMode on sdl.context", () => {
    const { tools, server } = makeFakeServer();

    registerTools(server as any, {}, undefined, {
      enabled: true,
      exclusive: false,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50000,
      maxWorkflowDurationMs: 30000,
      ladderValidation: "warn",
      etagCaching: true,
    });

    const contextTool = tools.find((candidate) => candidate.name === "sdl.context");
    assert.ok(contextTool?.wireSchema, "expected sdl.context wire schema");
    const properties = contextTool.wireSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepStrictEqual(properties.refsMode?.enum, ["auto", "off"]);
  });

  it("publishes complete deterministic context and retrieve wire schemas", () => {
    const codeModeConfig = {
      enabled: true,
      exclusive: false,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50000,
      maxWorkflowDurationMs: 30000,
      ladderValidation: "warn" as const,
      etagCaching: true,
    };
    const { tools: firstTools, server: firstServer } = makeFakeServer();
    const { tools: secondTools, server: secondServer } = makeFakeServer();

    registerTools(firstServer as any, {}, undefined, codeModeConfig);
    registerTools(secondServer as any, {}, undefined, codeModeConfig);

    const publicSchemas = (tools: RegisteredToolCall[]) =>
      tools
        .filter((tool) => ["sdl.context", "sdl.retrieve"].includes(tool.name))
        .map((tool) => ({ name: tool.name, wireSchema: tool.wireSchema }));
    assert.strictEqual(
      JSON.stringify(publicSchemas(firstTools)),
      JSON.stringify(publicSchemas(secondTools)),
    );

    const context = firstTools.find((tool) => tool.name === "sdl.context");
    assert.ok(context?.wireSchema, "expected sdl.context wire schema");
    const contextProperties = context.wireSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepStrictEqual(Object.keys(contextProperties), [
      "repoId",
      "taskType",
      "taskText",
      "budget",
      "focusPaths",
      "focusSymbols",
      "chatMentions",
      "includeTests",
      "ifNoneMatch",
      "responseMode",
      "refsMode",
      "wireFormat",
      "detail",
      "includeDiagnostics",
    ]);
    assert.deepStrictEqual(context.wireSchema.required, [
      "repoId",
      "taskType",
      "taskText",
      "budget",
    ]);
    const contextBudget = contextProperties.budget.properties as Record<
      string,
      unknown
    >;
    assert.deepStrictEqual(Object.keys(contextBudget), ["maxTokens"]);
    assert.deepStrictEqual(contextProperties.budget.required, ["maxTokens"]);
    assert.strictEqual(
      (contextProperties.budget as { additionalProperties?: unknown })
        .additionalProperties,
      false,
    );
    assert.ok(!("options" in contextProperties));
    assert.strictEqual(context.wireSchema.additionalProperties, false);

    const retrieve = firstTools.find((tool) => tool.name === "sdl.retrieve");
    assert.ok(retrieve?.wireSchema, "expected sdl.retrieve wire schema");
    assert.ok(!("oneOf" in retrieve.wireSchema));
    assert.ok(!("anyOf" in retrieve.wireSchema));
    assert.ok(!("allOf" in retrieve.wireSchema));
    const retrieveProperties = retrieve.wireSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.ok(!("oneOf" in retrieveProperties.args));
    const variants = retrieveProperties.args.anyOf as Array<
      Record<string, unknown>
    >;
    assert.strictEqual(variants.length, 7);
    assert.deepStrictEqual(
      variants.map((variant) => variant.title),
      [
        "symbolSearch",
        "symbolGetCard",
        "sliceBuild",
        "codeSkeleton",
        "codeHotPath",
        "codeNeedWindow",
        "responseGet",
      ],
    );
    const sliceProperties = variants[2]?.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.ok(!("repoId" in sliceProperties));
    const sliceBudgetRef = sliceProperties.budget.$ref;
    assert.strictEqual(typeof sliceBudgetRef, "string");
    const sliceBudgetKey = (sliceBudgetRef as string).split("/").at(-1);
    assert.ok(sliceBudgetKey);
    const definitions = retrieve.wireSchema.$defs as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    const sliceBudget = definitions[sliceBudgetKey]?.properties;
    assert.ok(sliceBudget);
    assert.ok("maxEstimatedTokens" in sliceBudget);
    assert.ok(!("maxTokens" in sliceBudget));
  });

  it("publishes the complete workflow request schema", async () => {
    const mcpServer = new MCPServer();
    registerTools(mcpServer, {}, undefined, {
      enabled: true,
      exclusive: true,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50000,
      maxWorkflowDurationMs: 30000,
      ladderValidation: "warn",
      etagCaching: true,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      mcpServer.getServer().connect(serverTransport),
    ]);

    try {
      const listed = await client.listTools();
      const workflow = listed.tools.find((tool) => tool.name === "sdl.workflow");
      assert.ok(workflow, "expected sdl.workflow to be registered");
      assert.deepStrictEqual(
        workflow.inputSchema,
        buildCompactJsonSchema(WorkflowRequestSchema),
      );
      const stepProperties = (
        workflow.inputSchema.properties?.steps as {
          items?: { properties?: Record<string, unknown> };
        }
      ).items?.properties;
      assert.ok(
        stepProperties && "maxResponseTokens" in stepProperties,
        "expected steps[].maxResponseTokens in the published schema",
      );
    } finally {
      await client.close();
    }
  });

  it("registers universal and code-mode tools when exclusive mode is enabled", async () => {
    const { names, tools, server } = makeFakeServer();

    registerTools(server as any, {}, undefined, {
      enabled: true,
      exclusive: true,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50000,
      maxWorkflowDurationMs: 30000,
      ladderValidation: "warn",
      etagCaching: true,
    });

    // Only code-mode tools should be registered
    assert.ok(
      names.includes("sdl.manual"),
      "expected sdl.manual in exclusive mode",
    );
    assert.ok(
      names.includes("sdl.workflow"),
      "expected sdl.workflow in exclusive mode",
    );
    assert.ok(
      names.includes("sdl.context"),
      "expected sdl.context in exclusive mode",
    );
    assert.ok(
      names.includes("sdl.action.search"),
      "expected sdl.action.search in exclusive mode",
    );
    assert.ok(
      names.includes("sdl.file"),
      "expected sdl.file in exclusive mode",
    );
    assert.ok(
      names.includes("sdl.retrieve"),
      "expected sdl.retrieve in exclusive mode",
    );
    assert.ok(
      names.includes("sdl.info"),
      "expected universal sdl.info in exclusive mode",
    );
    const actionSearch = tools.find(
      (tool) => tool.name === "sdl.action.search",
    );
    assert.ok(actionSearch?.handler);
    const discovery = await actionSearch.handler({
      query: "sdl.info server information",
      limit: 10,
    }) as { actions?: Array<{ action?: string }> };
    assert.ok(
      discovery.actions?.some((action) => action.action === "info"),
      "exclusive mode discovery should advertise universal sdl.info",
    );
    assert.deepStrictEqual(names, [
      "sdl.action.search",
      "sdl.info",
      "sdl.manual",
      "sdl.retrieve",
      "sdl.workflow",
      "sdl.context",
      "sdl.file",
    ]);

    // No flat tools
    assert.ok(
      !names.includes("sdl.repo.register"),
      "flat tool sdl.repo.register should NOT be registered in exclusive mode",
    );
  });

  it("registers code-mode tools alongside gateway when both enabled", () => {
    const { names, server } = makeFakeServer();

    registerTools(
      server as any,
      {},
      { enabled: true, emitLegacyTools: false },
      {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50000,
        maxWorkflowDurationMs: 30000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    // Gateway tools should be present
    assert.ok(
      names.includes("sdl.query") || names.includes("sdl.repo"),
      "expected gateway tools to be registered",
    );

    // Code-mode tools should also be present
    assert.ok(
      names.includes("sdl.manual"),
      "expected sdl.manual alongside gateway",
    );
    assert.ok(
      names.includes("sdl.action.search"),
      "expected sdl.action.search alongside gateway",
    );
    assert.ok(
      names.includes("sdl.workflow"),
      "expected sdl.workflow alongside gateway",
    );
    assert.ok(
      names.includes("sdl.context"),
      "expected sdl.context alongside gateway",
    );
    assert.ok(
      names.includes("sdl.retrieve"),
      "expected sdl.retrieve alongside gateway",
    );
  });

  it("does not register code-mode tools when codeModeConfig is undefined", () => {
    const { names, server } = makeFakeServer();

    registerTools(server as any, {}, undefined, undefined);

    assert.ok(
      !names.includes("sdl.manual"),
      "sdl.manual should NOT be registered without codeModeConfig",
    );
    assert.ok(
      !names.includes("sdl.workflow"),
      "sdl.workflow should NOT be registered without codeModeConfig",
    );
    assert.ok(
      !names.includes("sdl.context"),
      "sdl.context should NOT be registered without codeModeConfig",
    );
    assert.ok(
      names.includes("sdl.action.search"),
      "sdl.action.search should register as a universal discovery surface",
    );

    // Flat tools should still work
    assert.ok(
      names.includes("sdl.repo.register"),
      "expected flat tools to still register",
    );
  });

  it("does not register code-mode tools when enabled is false", () => {
    const { names, server } = makeFakeServer();

    registerTools(server as any, {}, undefined, {
      enabled: false,
      exclusive: false,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50000,
      maxWorkflowDurationMs: 30000,
      ladderValidation: "warn",
      etagCaching: true,
    });

    assert.ok(
      !names.includes("sdl.manual"),
      "sdl.manual should NOT be registered when enabled=false",
    );
    assert.ok(
      !names.includes("sdl.workflow"),
      "sdl.workflow should NOT be registered when enabled=false",
    );
    assert.ok(
      !names.includes("sdl.context"),
      "sdl.context should NOT be registered when enabled=false",
    );
    assert.ok(
      names.includes("sdl.action.search"),
      "sdl.action.search should still register when enabled=false",
    );
  });
});
