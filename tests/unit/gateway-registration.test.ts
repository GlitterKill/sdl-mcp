import { describe, it } from "node:test";
import assert from "node:assert";
import { registerTools } from "../../src/mcp/tools/index.js";

describe("Gateway tool registration", () => {
  it("registers 4 gateway tools when gateway enabled", () => {
    const names: string[] = [];
    const fakeServer = {
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
    };

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
    assert.strictEqual(names.length, 4, "expected exactly 4 gateway tools");
  });

  it("registers 33 tools when gateway enabled with legacy", () => {
    const names: string[] = [];
    const fakeServer = {
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
    };

    registerTools(
      fakeServer as any,
      {},
      {
        enabled: true,
        emitLegacyTools: true,
      },
    );

    // 4 gateway + 29 legacy = 33
    assert.ok(names.includes("sdl.query"), "expected sdl.query gateway tool");
    assert.ok(
      names.includes("sdl.repo.register"),
      "expected sdl.repo.register legacy tool",
    );
    assert.strictEqual(
      names.length,
      33,
      "expected 33 tools (4 gateway + 29 legacy)",
    );
  });

  it("registers 29 flat tools when gateway disabled", () => {
    const names: string[] = [];
    const fakeServer = {
      registerTool(name: string): void {
        names.push(name);
      },
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
    assert.strictEqual(names.length, 29, "expected 29 flat tools");
  });

  it("registers 29 flat tools when no gateway config", () => {
    const names: string[] = [];
    const fakeServer = {
      registerTool(name: string): void {
        names.push(name);
      },
    };

    registerTools(fakeServer as any);

    assert.ok(
      names.includes("sdl.slice.refresh"),
      "expected sdl.slice.refresh",
    );
    assert.strictEqual(names.length, 29, "expected 29 flat tools");
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
