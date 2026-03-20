import { describe, it } from "node:test";
import assert from "node:assert";
import { registerTools } from "../../src/mcp/tools/index.js";

function makeFakeServer(): { names: string[]; server: any } {
  const names: string[] = [];
  const server = {
    gatewayMode: false,
    registerTool(name: string): void {
      names.push(name);
    },
    registerPostDispatchHook(): void {},
  };
  return { names, server };
}

describe("MCP tool registration", () => {
  it("registers live buffer tools alongside existing slice tools", () => {
    const { names, server } = makeFakeServer();

    registerTools(server as any);

    assert.ok(
      names.includes("sdl.slice.refresh"),
      "expected sdl.slice.refresh to be registered",
    );
    assert.ok(
      names.includes("sdl.context.summary"),
      "expected sdl.context.summary to be registered",
    );
    assert.ok(
      names.includes("sdl.symbol.getCards"),
      "expected sdl.symbol.getCards to be registered",
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
      maxChainSteps: 20,
      maxChainTokens: 50000,
      maxChainDurationMs: 30000,
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
      names.includes("sdl.chain"),
      "expected sdl.chain to be registered alongside flat tools",
    );
  });

  it("registers only code-mode tools when exclusive mode is enabled", () => {
    const { names, server } = makeFakeServer();

    registerTools(server as any, {}, undefined, {
      enabled: true,
      exclusive: true,
      maxChainSteps: 20,
      maxChainTokens: 50000,
      maxChainDurationMs: 30000,
      ladderValidation: "warn",
      etagCaching: true,
    });

    // Only code-mode tools should be registered
    assert.ok(
      names.includes("sdl.manual"),
      "expected sdl.manual in exclusive mode",
    );
    assert.ok(
      names.includes("sdl.chain"),
      "expected sdl.chain in exclusive mode",
    );
    assert.ok(
      names.includes("sdl.action.search"),
      "expected sdl.action.search in exclusive mode",
    );
    assert.strictEqual(
      names.length,
      3,
      `exclusive mode should register exactly 3 tools, got ${names.length}: ${names.join(", ")}`,
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
        maxChainSteps: 20,
        maxChainTokens: 50000,
        maxChainDurationMs: 30000,
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
      names.includes("sdl.chain"),
      "expected sdl.chain alongside gateway",
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
      !names.includes("sdl.chain"),
      "sdl.chain should NOT be registered without codeModeConfig",
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
      maxChainSteps: 20,
      maxChainTokens: 50000,
      maxChainDurationMs: 30000,
      ladderValidation: "warn",
      etagCaching: true,
    });

    assert.ok(
      !names.includes("sdl.manual"),
      "sdl.manual should NOT be registered when enabled=false",
    );
    assert.ok(
      !names.includes("sdl.chain"),
      "sdl.chain should NOT be registered when enabled=false",
    );
    assert.ok(
      names.includes("sdl.action.search"),
      "sdl.action.search should still register when enabled=false",
    );
  });
});
