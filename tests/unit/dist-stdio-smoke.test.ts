import assert from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("answers tools/list from the built artifact with the exclusive Code Mode surface", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sdl-mcp-dist-smoke-"));
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
        SDL_GRAPH_DB_PATH: join(tempDir, "graph.lbug"),
        SDL_CONFIG: join(process.cwd(), "config", "sdlmcp.config.example.json"),
      },
    });

    try {
      await client.connect(transport);
      const response = await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );

      assert.ok(response.tools.length > 0);
      const names = response.tools.map((tool) => tool.name).sort();
      assert.deepStrictEqual(names, [
        "sdl.action.search",
        "sdl.context",
        "sdl.manual",
        "sdl.workflow",
      ]);

      const contextTool = response.tools.find((tool) => tool.name === "sdl.context");
      const workflowTool = response.tools.find((tool) => tool.name === "sdl.workflow");
      assert.strictEqual(contextTool?.title, "SDL Context");
      assert.strictEqual(workflowTool?.title, "SDL Workflow");
      assert.match(contextTool?.description ?? "", /SDL-MCP v/);
      assert.match(workflowTool?.description ?? "", /SDL-MCP v/);
    } finally {
      await client.close().catch(() => {});
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
