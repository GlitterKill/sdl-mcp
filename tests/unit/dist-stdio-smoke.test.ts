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
        "sdl.file",
        "sdl.info",
        "sdl.manual",
        "sdl.retrieve",
        "sdl.workflow",
      ]);

      for (const tool of response.tools) {
        const outputSchema = tool.outputSchema as
          | Record<string, unknown>
          | undefined;
        assert.ok(outputSchema, `${tool.name} must advertise an output schema`);
        assert.strictEqual(outputSchema.type, "object");
        for (const combinator of ["anyOf", "oneOf", "allOf"]) {
          assert.strictEqual(combinator in outputSchema, false);
        }
      }

      // Keep truthful outer contracts compact enough for the prompt catalog.
      const expectedOutputProperties = {
        "sdl.retrieve": ["results", "card", "slice", "approved"],
        "sdl.workflow": ["results"],
        "sdl.context": ["status", "isError", "notModified", "kind"],
        "sdl.file": ["filePath", "mode", "kind"],
      } as const;
      for (const [name, expectedProperties] of Object.entries(
        expectedOutputProperties,
      )) {
        const outputSchema = response.tools.find(
          (tool) => tool.name === name,
        )?.outputSchema;
        assert.ok(outputSchema);
        const properties = outputSchema.properties as
          | Record<string, unknown>
          | undefined;
        for (const property of expectedProperties) {
          assert.ok(property in (properties ?? {}), `${name}.${property}`);
        }
        const maxSchemaBytes = name === "sdl.context" ? 6_400 : 512;
        assert.ok(
          Buffer.byteLength(JSON.stringify(outputSchema), "utf8") <=
            maxSchemaBytes,
          `${name} output schema must stay compact`,
        );
      }

      const workflowResult = await client.callTool({
        name: "sdl.workflow",
        arguments: {
          repoId: "missing-repo",
          steps: [
            {
              fn: "actionSearch",
              args: { query: "context", limit: 1 },
            },
          ],
        },
      });
      assert.notStrictEqual(workflowResult.isError, true);
      assert.ok(
        workflowResult.structuredContent &&
          typeof workflowResult.structuredContent === "object",
      );

      const retrieveError = await client.callTool({
        name: "sdl.retrieve",
        arguments: {
          repoId: "missing-repo",
          op: "symbolSearch",
          args: { query: "context" },
        },
      });
      assert.strictEqual(retrieveError.isError, true);
      assert.ok(
        retrieveError.structuredContent &&
          typeof retrieveError.structuredContent === "object",
      );

      const contextTool = response.tools.find((tool) => tool.name === "sdl.context");
      const workflowTool = response.tools.find((tool) => tool.name === "sdl.workflow");
      const contextInputSchema = contextTool?.inputSchema as
        | Record<string, unknown>
        | undefined;
      assert.ok(contextInputSchema);
      assert.strictEqual(contextInputSchema.additionalProperties, false);
      assert.deepStrictEqual(contextInputSchema.required, [
        "repoId",
        "taskType",
        "taskText",
        "budget",
      ]);
      const contextInputProperties = contextInputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      assert.deepStrictEqual(Object.keys(contextInputProperties), [
        "repoId",
        "taskType",
        "taskText",
        "budget",
        "focusPaths",
        "focusSymbols",
        "chatMentions",
        "includeTests",
        "ifNoneMatch",
        "responseMode",
        "refsMode",
        "wireFormat",
        "detail",
        "includeDiagnostics",
      ]);
      const budgetSchema = contextInputProperties.budget;
      assert.strictEqual(budgetSchema.additionalProperties, false);
      assert.deepStrictEqual(budgetSchema.required, ["maxTokens"]);
      assert.deepStrictEqual(
        Object.keys(budgetSchema.properties as Record<string, unknown>),
        ["maxTokens"],
      );
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
