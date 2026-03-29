import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * Tests for src/gateway/legacy.ts — legacy tool registration.
 *
 * We create a mock MCPServer that captures registerTool calls, then
 * invoke registerLegacyTools and verify the expected tools are registered
 * with deprecation descriptions and valid schemas/handlers.
 */

describe("Gateway legacy tool registration", () => {
  /** Minimal mock that captures registerTool calls. */
  function createMockServer() {
    const registered: Array<{
      name: string;
      description: string;
      schema: unknown;
      handler: unknown;
    }> = [];

    return {
      registered,
      registerTool(
        name: string,
        description: string,
        schema: unknown,
        handler: unknown,
      ) {
        registered.push({ name, description, schema, handler });
      },
    };
  }

  // Dynamic import to avoid top-level side-effects
  async function loadLegacy() {
    return await import("../../dist/gateway/legacy.js");
  }

  it("registers all 30 legacy tools", async () => {
    const { registerLegacyTools } = await loadLegacy();
    const mock = createMockServer();

    registerLegacyTools(mock as any, {});

    assert.strictEqual(mock.registered.length, 30);
  });

  it("registers known tool names", async () => {
    const { registerLegacyTools } = await loadLegacy();
    const mock = createMockServer();

    registerLegacyTools(mock as any, {});

    const names = mock.registered.map((t) => t.name);
    const expected = [
      "sdl.repo.register",
      "sdl.repo.status",
      "sdl.index.refresh",
      "sdl.buffer.push",
      "sdl.buffer.checkpoint",
      "sdl.buffer.status",
      "sdl.symbol.search",
      "sdl.symbol.getCard",
      "sdl.symbol.getCards",
      "sdl.slice.build",
      "sdl.slice.refresh",
      "sdl.slice.spillover.get",
      "sdl.delta.get",
      "sdl.code.needWindow",
      "sdl.code.getSkeleton",
      "sdl.code.getHotPath",
      "sdl.policy.get",
      "sdl.policy.set",
      "sdl.repo.overview",
      "sdl.usage.stats",
      "sdl.pr.risk.analyze",
      "sdl.agent.context",
      "sdl.context.summary",
      "sdl.agent.feedback",
      "sdl.agent.feedback.query",
      "sdl.runtime.execute",
      "sdl.memory.store",
      "sdl.memory.query",
      "sdl.memory.remove",
      "sdl.memory.surface",
    ];

    for (const name of expected) {
      assert.ok(names.includes(name), `Missing legacy tool: ${name}`);
    }
  });

  it("all descriptions contain [Legacy] prefix", async () => {
    const { registerLegacyTools } = await loadLegacy();
    const mock = createMockServer();

    registerLegacyTools(mock as any, {});

    for (const tool of mock.registered) {
      assert.ok(
        tool.description.startsWith("[Legacy"),
        `Tool ${tool.name} description should start with [Legacy]: ${tool.description}`,
      );
    }
  });

  it("all descriptions mention the preferred gateway tool", async () => {
    const { registerLegacyTools } = await loadLegacy();
    const mock = createMockServer();

    registerLegacyTools(mock as any, {});

    for (const tool of mock.registered) {
      assert.ok(
        tool.description.includes("prefer sdl."),
        `Tool ${tool.name} description should mention preferred gateway tool: ${tool.description}`,
      );
    }
  });

  it("each registered tool has a Zod schema and function handler", async () => {
    const { registerLegacyTools } = await loadLegacy();
    const mock = createMockServer();

    registerLegacyTools(mock as any, {});

    for (const tool of mock.registered) {
      assert.ok(tool.schema, `${tool.name} missing schema`);
      assert.ok(
        typeof tool.handler === "function",
        `${tool.name} missing handler function`,
      );
    }
  });

  it("sdl.memory.surface is the last registered tool", async () => {
    const { registerLegacyTools } = await loadLegacy();
    const mock = createMockServer();

    registerLegacyTools(mock as any, {});

    const last = mock.registered[mock.registered.length - 1];
    assert.strictEqual(last?.name, "sdl.memory.surface");
  });
});
