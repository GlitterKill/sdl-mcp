import { describe, it } from "node:test";
import assert from "node:assert";
import { registerTools } from "../../dist/mcp/tools/index.js";

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
  it("registers 4 gateway tools + 2 universal tools when gateway enabled", () => {
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
    assert.ok(
      names.includes("sdl.action.search"),
      "expected sdl.action.search",
    );
    assert.ok(names.includes("sdl.info"), "expected sdl.info");
    assert.strictEqual(
      names.length,
      6,
      "expected 6 tools (4 gateway + 2 universal)",
    );
  });

  it("registers 33 tools when gateway enabled with legacy", () => {
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

    // 2 universal + 4 gateway + 30 legacy = 36
    assert.ok(names.includes("sdl.query"), "expected sdl.query gateway tool");
    assert.ok(
      names.includes("sdl.repo.register"),
      "expected sdl.repo.register legacy tool",
    );
    assert.ok(
      names.includes("sdl.action.search"),
      "expected sdl.action.search universal tool",
    );
    assert.ok(names.includes("sdl.info"), "expected sdl.info universal tool");
    assert.strictEqual(
      names.length,
      33,
      "expected 33 tools (2 universal + 4 gateway + 27 legacy)",
    );
  });

  it("registers 29 tools when gateway disabled (27 flat + 2 universal)", () => {
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
    assert.ok(
      names.includes("sdl.action.search"),
      "expected sdl.action.search",
    );
    assert.ok(names.includes("sdl.info"), "expected sdl.info");
    assert.strictEqual(
      names.length,
      29,
      "expected 29 tools (27 flat + 2 universal)",
    );
  });

  it("registers 29 tools when no gateway config (27 flat + 2 universal)", () => {
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
    assert.ok(
      names.includes("sdl.action.search"),
      "expected sdl.action.search",
    );
    assert.ok(names.includes("sdl.info"), "expected sdl.info");
    assert.strictEqual(
      names.length,
      29,
      "expected 29 tools (27 flat + 2 universal)",
    );
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
