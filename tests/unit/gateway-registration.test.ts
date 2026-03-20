import { describe, it } from "node:test";
import assert from "node:assert";
import { registerTools } from "../../src/mcp/tools/index.js";

function makeFakeGatewayServer(names: string[]) {
  return {
    _gatewayMode: false,
    set gatewayMode(v: boolean) {
      this._gatewayMode = v;
    },
    get gatewayMode() {
      return this._gatewayMode;
    },
    registerTool(name: string): void {
      names.push(name);
    },
    registerPostDispatchHook(): void {},
  };
}

describe("Gateway tool registration", () => {
  it("registers 4 gateway tools + 1 universal tool when gateway enabled", () => {
    const names: string[] = [];
    const fakeServer = makeFakeGatewayServer(names);

    registerTools(
      fakeServer as any,
      {},
      {
        enabled: true,
        emitLegacyTools: false,
      },
    );

    assert.ok(names.includes("sdl.query"), "expected sdl.query");
    assert.ok(names.includes("sdl.code"), "expected sdl.code");
    assert.ok(names.includes("sdl.repo"), "expected sdl.repo");
    assert.ok(names.includes("sdl.agent"), "expected sdl.agent");
    assert.ok(names.includes("sdl.action.search"), "expected sdl.action.search");
    assert.strictEqual(names.length, 5, "expected 5 tools (4 gateway + 1 universal)");
  });

  it("registers 35 tools when gateway enabled with legacy", () => {
    const names: string[] = [];
    const fakeServer = makeFakeGatewayServer(names);

    registerTools(
      fakeServer as any,
      {},
      {
        enabled: true,
        emitLegacyTools: true,
      },
    );

    // 1 universal + 4 gateway + 30 legacy = 35
    assert.ok(names.includes("sdl.query"), "expected sdl.query gateway tool");
    assert.ok(
      names.includes("sdl.repo.register"),
      "expected sdl.repo.register legacy tool",
    );
    assert.ok(names.includes("sdl.action.search"), "expected sdl.action.search universal tool");
    assert.strictEqual(
      names.length,
      35,
      "expected 35 tools (1 universal + 4 gateway + 30 legacy)",
    );
  });

  it("registers 31 tools when gateway disabled (30 flat + 1 universal)", () => {
    const names: string[] = [];
    const fakeServer = {
      registerTool(name: string): void {
        names.push(name);
      },
      registerPostDispatchHook(): void {},
    };

    registerTools(
      fakeServer as any,
      {},
      {
        enabled: false,
      },
    );

    assert.ok(
      names.includes("sdl.repo.register"),
      "expected sdl.repo.register",
    );
    assert.ok(
      !names.includes("sdl.query"),
      "should not register gateway tools",
    );
    assert.ok(names.includes("sdl.action.search"), "expected sdl.action.search");
    assert.strictEqual(names.length, 31, "expected 31 tools (30 flat + 1 universal)");
  });

  it("registers 31 tools when no gateway config (30 flat + 1 universal)", () => {
    const names: string[] = [];
    const fakeServer = {
      registerTool(name: string): void {
        names.push(name);
      },
      registerPostDispatchHook(): void {},
    };

    registerTools(fakeServer as any);

    assert.ok(
      names.includes("sdl.slice.refresh"),
      "expected sdl.slice.refresh",
    );
    assert.ok(names.includes("sdl.action.search"), "expected sdl.action.search");
    assert.strictEqual(names.length, 31, "expected 31 tools (30 flat + 1 universal)");
  });

  it("sets gatewayMode on server when gateway enabled", () => {
    let gatewayModeSet = false;
    const fakeServer = {
      _gatewayMode: false,
      set gatewayMode(v: boolean) {
        gatewayModeSet = v;
      },
      get gatewayMode() {
        return this._gatewayMode;
      },
      registerTool(): void {},
      registerPostDispatchHook(): void {},
    };

    registerTools(
      fakeServer as any,
      {},
      {
        enabled: true,
        emitLegacyTools: false,
      },
    );

    assert.strictEqual(gatewayModeSet, true, "expected gatewayMode to be set");
  });
});
