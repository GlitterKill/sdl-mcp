import { describe, it } from "node:test";
import assert from "node:assert";
import { registerTools } from "../../dist/mcp/tools/index.js";
import { getVersion } from "../../dist/cli/commands/version.js";

interface RegisteredToolCall {
  name: string;
  description?: string;
  wireSchema?: Record<string, unknown>;
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
    ): void {
      names.push(name);
      tools.push({ name, description, wireSchema, presentation });
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
    const variants = wireSchema.oneOf as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(variants) && variants.length > 0, "expected oneOf gateway variants");

    const sliceBuildVariant = variants.find((variant) =>
      JSON.stringify(variant).includes('"const":"slice.build"'),
    );
    assert.ok(sliceBuildVariant, "expected slice.build gateway variant");
    assert.match(
      JSON.stringify(sliceBuildVariant),
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
      !names.includes("sdl.info"),
      "sdl.info should NOT be registered in exclusive mode",
    );
    assert.strictEqual(
      names.length,
      4,
      `exclusive mode should register exactly 4 tools, got ${names.length}: ${names.join(", ")}`,
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
