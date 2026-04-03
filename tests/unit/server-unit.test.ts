import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { z } from "zod";
import { MCPServer } from "../../dist/server.js";

/**
 * Tests for src/server.ts — MCPServer class.
 * Verifies tool registration, gatewayMode property, clearTools, and
 * post-dispatch hook registration. Does not test full MCP transport
 * connectivity (that would be an integration test).
 */

describe("MCPServer", () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer();
  });

  describe("constructor", () => {
    it("creates an MCPServer instance", () => {
      assert.ok(server);
      assert.ok(server instanceof MCPServer);
    });

    it("has gatewayMode defaulting to false", () => {
      assert.strictEqual(server.gatewayMode, false);
    });
  });

  describe("gatewayMode", () => {
    it("can be set to true", () => {
      server.gatewayMode = true;
      assert.strictEqual(server.gatewayMode, true);
    });

    it("can be toggled back to false", () => {
      server.gatewayMode = true;
      server.gatewayMode = false;
      assert.strictEqual(server.gatewayMode, false);
    });
  });

  describe("registerTool", () => {
    it("registers a tool without throwing", () => {
      const schema = z.object({ repoId: z.string() });
      const handler = async () => ({ ok: true });

      assert.doesNotThrow(() => {
        server.registerTool("sdl.test.tool", "A test tool", schema, handler);
      });
    });

    it("can register multiple tools", () => {
      const schema = z.object({});
      const handler = async () => ({});

      server.registerTool("tool-a", "desc-a", schema, handler);
      server.registerTool("tool-b", "desc-b", schema, handler);

      // No assertion beyond not throwing — internal tools Map is private
      assert.ok(true);
    });

    it("accepts optional wireSchema", () => {
      const schema = z.object({});
      const handler = async () => ({});
      const wireSchema = {
        type: "object",
        properties: { action: { type: "string" } },
      };

      assert.doesNotThrow(() => {
        server.registerTool(
          "sdl.test.wire",
          "desc",
          schema,
          handler,
          wireSchema,
        );
      });
    });
  });

  describe("clearTools", () => {
    it("does not throw when called on empty tool set", () => {
      assert.doesNotThrow(() => server.clearTools());
    });

    it("does not throw after registering tools", () => {
      server.registerTool("tool-x", "desc", z.object({}), async () => ({}));
      assert.doesNotThrow(() => server.clearTools());
    });
  });

  describe("registerPostDispatchHook", () => {
    it("accepts a hook function", () => {
      const hook = async () => {};
      assert.doesNotThrow(() => server.registerPostDispatchHook(hook));
    });

    it("accepts multiple hooks", () => {
      const hook1 = async () => {};
      const hook2 = async () => {};
      server.registerPostDispatchHook(hook1);
      server.registerPostDispatchHook(hook2);
      assert.ok(true);
    });
  });

  describe("getServer", () => {
    it("returns the underlying MCP Server instance", () => {
      const inner = server.getServer();
      assert.ok(inner, "should return a Server instance");
    });
  });

  describe("notifyToolListChanged", () => {
    it("does not throw when no client is connected", async () => {
      // With no transport connected, notification should be swallowed
      await assert.doesNotReject(server.notifyToolListChanged());
    });
  });

  describe("broad context compaction", () => {
    it("does not affect non-context tool registration", () => {
      const schema = z.object({ repoId: z.string() });
      const handler = async () => ({ results: [1, 2, 3] });

      server.registerTool("sdl.symbol.search", "Search", schema, handler);
      // Just verify registration works — the actual compaction is tested
      // in context-response-projection.test.ts
      assert.ok(server);
    });
  });
});
