import assert from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

describe("dist stdio smoke", () => {
  it("keeps stdout quiet before protocol traffic", async () => {
    const child = spawn("node", ["dist/main.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill();
    await once(child, "exit");

    assert.strictEqual(stdout, "");
  });

  it("answers tools/list from the built artifact with metadata-rich tools", async () => {
    const client = new Client({
      name: "dist-stdio-smoke",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/main.js"],
      env: {
        ...process.env,
        NODE_ENV: "test",
      },
    });

    try {
      await client.connect(transport);
      const response = await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );

      assert.ok(response.tools.length > 0);

      const infoTool = response.tools.find((tool) => tool.name === "sdl.info");
      assert.ok(infoTool, "expected sdl.info in tools/list");
      assert.strictEqual(infoTool?.title, "SDL Info");
      assert.match(infoTool?.description ?? "", /SDL-MCP v/);
    } finally {
      await client.close().catch(() => {});
    }
  });
});
