import { describe, it } from "node:test";
import assert from "node:assert";
import { registerTools } from "../../src/mcp/tools/index.js";

describe("MCP tool registration", () => {
  it("registers live buffer tools alongside existing slice tools", () => {
    const names: string[] = [];
    const fakeServer = {
      registerTool(name: string): void {
        names.push(name);
      },
    };

    registerTools(fakeServer as any);

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
});
