import { describe, it } from "node:test";
import assert from "node:assert";
import { registerTools } from "../../dist/mcp/tools/index.js";
import { getVersion } from "../../dist/cli/commands/version.js";

interface RegisteredToolCall {
  name: string;
  description?: string;
  wireSchema?: Record<string, unknown>;
  outputSchema?: unknown;
  presentation?: { title?: string };
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
      _handler?: unknown,
      wireSchema?: Record<string, unknown>,
      presentation?: { title?: string },
      outputSchema?: unknown,
    ): void {
      names.push(name);
      tools.push({ name, description, wireSchema, outputSchema, presentation });
    },
    registerPostDispatchHook(): void {},
  };
  return { names, tools, server };
}

describe("MCP tool registration", () => {
  it("registers sdl.info with a human title", () => {
    const { tools, server } = makeFakeServer();

    registerTools(server as any);

    const infoTool = tools.find((tool) => tool.name === "sdl.info");
    assert.ok(infoTool, "expected sdl.info to be registered");
    assert.strictEqual(infoTool.presentation?.title, "SDL Info");
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

  it("registers only proven flat output schemas", () => {
    const { tools: stableTools, server: stableServer } = makeFakeServer();
    registerTools(stableServer as any);

    const requiredFlatTools = [
      "sdl.repo.register",
      "sdl.repo.status",
      "sdl.repo.unregister",
      "sdl.index.refresh",
      "sdl.buffer.push",
      "sdl.buffer.checkpoint",
      "sdl.buffer.status",
      "sdl.symbol.search",
      "sdl.symbol.getCard",
      "sdl.slice.build",
      "sdl.slice.refresh",
      "sdl.slice.spillover.get",
      "sdl.delta.get",
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
    ];
    const intentionallyOmittedFlatTools = [
      "sdl.repo.overview",
      "sdl.symbol.edit",
      "sdl.code.needWindow",
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
    for (const name of intentionallyOmittedFlatTools) {
      const tool = stableTools.find((candidate) => candidate.name === name);
      assert.ok(tool, `expected ${name} to be registered`);
      assert.strictEqual(
        tool.outputSchema,
        undefined,
        `expected ${name} output schema to remain omitted`,
      );
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
      assert.deepStrictEqual(properties.detail?.enum, ["compact", "full"]);
      assert.strictEqual(properties.detail?.default, "compact");
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
    for (const field of ["refsMode", "wireFormat", "ifNoneMatch"]) {
      assert.ok(field in contextProperties, `missing context ${field}`);
    }
    const contextBudget = contextProperties.budget.properties as Record<
      string,
      unknown
    >;
    for (const field of [
      "maxTokens",
      "maxEstimatedTokens",
      "maxActions",
      "maxDurationMs",
    ]) {
      assert.ok(field in contextBudget, `missing context budget.${field}`);
    }
    const contextOptions = contextProperties.options.properties as Record<
      string,
      unknown
    >;
    assert.ok("focusSymbols" in contextOptions);
    assert.ok("focusPaths" in contextOptions);

    const retrieve = firstTools.find((tool) => tool.name === "sdl.retrieve");
    assert.ok(retrieve?.wireSchema, "expected sdl.retrieve wire schema");
    const retrieveProperties = retrieve.wireSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    const variants = retrieveProperties.args.oneOf as Array<
      Record<string, unknown>
    >;
    assert.strictEqual(variants.length, 6);
    assert.deepStrictEqual(
      variants.map((variant) => variant.title),
      [
        "symbolSearch",
        "symbolGetCard",
        "sliceBuild",
        "codeSkeleton",
        "codeHotPath",
        "codeNeedWindow",
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

  it("registers only code-mode tools when exclusive mode is enabled", () => {
    const { names, server } = makeFakeServer();

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
      !names.includes("sdl.info"),
      "sdl.info should NOT be registered in exclusive mode",
    );
    assert.strictEqual(
      names.length,
      6,
      `exclusive mode should register exactly 6 tools, got ${names.length}: ${names.join(", ")}`,
    );

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
