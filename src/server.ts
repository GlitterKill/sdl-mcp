import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { errorToMcpResponse } from "./mcp/errors.js";
import { logToolCall } from "./mcp/telemetry.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

interface ToolHandler {
  (args: unknown): Promise<unknown>;
}

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: z.ZodType;
  handler: ToolHandler;
}

export class MCPServer {
  private server: Server;
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    this.server = new Server({
      name: "sdl-mcp",
      version: packageJson.version,
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        return {
          tools: Array.from(this.tools.values()).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: convertSchema(tool.inputSchema),
          })),
        };
      } catch (error) {
        process.stderr.write(`[sdl-mcp] ListTools error: ${error}\n`);
        throw error;
      }
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const tool = this.tools.get(request.params.name);
        if (!tool) {
          return {
            content: [
              { type: "text", text: `Tool '${request.params.name}' not found` },
            ],
            isError: true,
          };
        }

        const start = Date.now();
        const repoId = extractStringField(request.params.arguments, "repoId");
        const symbolId = extractStringField(
          request.params.arguments,
          "symbolId",
        );

        try {
          const result = await tool.handler(request.params.arguments);
          logToolCall({
            tool: request.params.name,
            request: request.params.arguments as Record<string, unknown>,
            response: result as Record<string, unknown>,
            durationMs: Date.now() - start,
            repoId,
            symbolId,
          });
          // Wrap result in MCP content format
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          process.stderr.write(
            `[sdl-mcp] Tool ${request.params.name} error: ${error}\n`,
          );
          logToolCall({
            tool: request.params.name,
            request: request.params.arguments as Record<string, unknown>,
            response: errorToMcpResponse(error),
            durationMs: Date.now() - start,
            repoId,
            symbolId,
          });
          // Return error in MCP content format instead of throwing
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(errorToMcpResponse(error), null, 2),
              },
            ],
            isError: true,
          };
        }
      } catch (outerError) {
        process.stderr.write(`[sdl-mcp] CallTool outer error: ${outerError}\n`);
        return {
          content: [{ type: "text", text: `Internal error: ${outerError}` }],
          isError: true,
        };
      }
    });
  }

  registerTool(
    name: string,
    description: string,
    inputSchema: z.ZodType,
    handler: ToolHandler,
  ): void {
    this.tools.set(name, {
      name,
      description,
      inputSchema,
      handler,
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async stop(): Promise<void> {
    await this.server.close();
  }

  getServer(): Server {
    return this.server;
  }
}

function extractStringField(args: unknown, field: string): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertSchema(schema: z.ZodType): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return zodToJsonSchema(schema as any, { target: "openApi3" }) as Record<
    string,
    unknown
  >;
}
