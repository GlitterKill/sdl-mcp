import { describe, it } from "node:test";
import assert from "node:assert";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { createMCPServer, MCPServer } from "../../dist/server.js";

async function connect(server: MCPServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "tool-name-format-test",
    version: "1.0.0",
  });

  await server["server"].connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("MCPServer tool name formats", () => {
  it("advertises OpenAI-safe aliases and dispatches them to canonical tools", async () => {
    const server = new MCPServer({ toolNameFormat: "openai" });
    let calls = 0;
    server.registerTool(
      "sdl.test.status",
      "test tool",
      z.object({}),
      async () => {
        calls += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    const client = await connect(server);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);

      assert.ok(names.includes("sdl_test_status"));
      assert.ok(!names.includes("sdl.test.status"));
      assert.ok(names.every((name) => /^[a-zA-Z0-9_-]{1,128}$/.test(name)));

      await client.callTool({ name: "sdl_test_status", arguments: {} });
      assert.strictEqual(calls, 1);
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("rejects OpenAI-safe alias collisions", () => {
    const server = new MCPServer({ toolNameFormat: "openai" });
    server.registerTool(
      "sdl_test_status",
      "safe test tool",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "safe" }] }),
    );

    assert.throws(
      () =>
        server.registerTool(
          "sdl.test.status",
          "dotted test tool",
          z.object({}),
          async () => ({ content: [{ type: "text", text: "dotted" }] }),
        ),
      /Tool name alias collision for sdl_test_status/,
    );
  });

  it("applies OpenAI-safe aliases through createMCPServer gateway config", async () => {
    const server = await createMCPServer({
      gatewayConfig: {
        enabled: false,
        emitLegacyTools: false,
        toolNameFormat: "openai",
      },
    });

    const client = await connect(server);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);

      assert.ok(names.includes("sdl_repo_status"));
      assert.ok(!names.some((name) => name.includes(".")));
      assert.ok(names.every((name) => /^[a-zA-Z0-9_-]{1,128}$/.test(name)));
    } finally {
      await client.close();
      await server.stop();
    }
  });
});
