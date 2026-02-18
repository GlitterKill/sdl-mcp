import { describe, it } from "node:test";
import assert from "node:assert";
import { registerTools } from "../../src/mcp/tools/index.js";

describe("MCP tool registration", () => {
  it("registers sdl.slice.refresh", () => {
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
  });
});
