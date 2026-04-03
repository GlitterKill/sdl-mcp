import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type ToolAnnotations,
  type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorToMcpResponse } from "./mcp/errors.js";
import { getToolDispatchLimiter } from "./mcp/dispatch-limiter.js";
import { logToolCall } from "./mcp/telemetry.js";
import {
  buildCompactJsonSchema,
  zodSchemaToJsonSchema,
} from "./gateway/compact-schema.js";
import {
  shouldAttachUsage,
  computeTokenUsage,
  stripRawContext,
  type TokenUsageMetadata,
} from "./mcp/token-usage.js";
import { tokenAccumulator } from "./mcp/token-accumulator.js";
import {
  renderUserNotificationLine,
  formatTokenCount,
} from "./mcp/savings-meter.js";
import { formatToolCallForUser } from "./mcp/tool-call-formatter.js";
import type { LiveIndexCoordinator } from "./live-index/types.js";
import type { CodeModeConfig } from "./config/types.js";
import { normalizeToolArguments } from "./mcp/request-normalization.js";
import {
  buildToolPresentation,
  buildVersionedToolDescription,
  type ToolPresentation,
} from "./mcp/tool-presentation.js";
import { getPackageVersion } from "./util/package-info.js";
import {
  projectBroadContextResult,
  isBroadContextResult,
} from "./mcp/context-response-projection.js";

export interface ToolContext {
  progressToken?: string | number;
  sendNotification: (notification: ServerNotification) => Promise<void>;
  signal: AbortSignal;
  /** Set from transport session for HTTP; undefined for stdio (defaults to "stdio" in hooks). */
  sessionId?: string;
}

export type PostDispatchHook = (
  toolName: string,
  args: unknown,
  result: unknown,
  context: ToolContext,
) => Promise<void>;

interface ToolHandler {
  (args: unknown, context?: ToolContext): Promise<unknown>;
}

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: z.ZodType;
  handler: ToolHandler;
  wireSchema?: Record<string, unknown>;
  presentation: ToolPresentation;
}

export function attachDisplayFooter(
  result: unknown,
  footerText: string,
): unknown {
  if (
    !footerText ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    return result;
  }

  const obj = result as Record<string, unknown>;
  const existingFooter =
    typeof obj._displayFooter === "string" ? obj._displayFooter : "";
  const mergedFooter = existingFooter
    ? `${existingFooter}\n\n${footerText}`
    : footerText;

  return {
    ...obj,
    _displayFooter: mergedFooter,
  };
}

export class MCPServer {
  private server: Server;
  private tools: Map<string, ToolDefinition> = new Map();
  private _gatewayMode = false;
  private postDispatchHooks: PostDispatchHook[] = [];

  constructor() {
    this.server = new Server(
      {
        name: "sdl-mcp",
        version: getPackageVersion(),
      },
      {
        capabilities: {
          tools: { listChanged: true },
          logging: {},
        },
      },
    );

    // Surface transport-level errors (malformed JSON-RPC, write failures,
    // notification handler exceptions) instead of silently swallowing them.
    this.server.onerror = (error) => {
      process.stderr.write(
        `[sdl-mcp] MCP protocol error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    };

    this.setupHandlers();
  }

  get gatewayMode(): boolean {
    return this._gatewayMode;
  }

  set gatewayMode(value: boolean) {
    this._gatewayMode = value;
  }

  registerPostDispatchHook(hook: PostDispatchHook): void {
    this.postDispatchHooks.push(hook);
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        return {
          tools: Array.from(this.tools.values()).map((tool) => ({
            name: tool.name,
            title: tool.presentation.title,
            description:
              tool.presentation.includeVersionInDescription === false
                ? tool.description
                : buildVersionedToolDescription(tool.description),
            annotations: {
              title: tool.presentation.title,
            } satisfies ToolAnnotations,
            inputSchema:
              tool.wireSchema ??
              convertSchema(tool.inputSchema, this._gatewayMode),
          })),
        };
      } catch (error) {
        process.stderr.write(`[sdl-mcp] ListTools error: ${error}\n`);
        throw error;
      }
    });

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        const toolContext: ToolContext = {
          progressToken: extra._meta?.progressToken,
          sendNotification: extra.sendNotification,
          signal: extra.signal,
        };

        try {
          const tool = this.tools.get(request.params.name);
          if (!tool) {
            return {
              content: [
                {
                  type: "text",
                  text: `Tool '${request.params.name}' not found`,
                },
              ],
              isError: true,
            };
          }

          const start = Date.now();
          const normalizedArgs = normalizeToolArguments(
            request.params.arguments,
          );
          const repoId = extractStringField(normalizedArgs, "repoId");
          const symbolId = extractStringField(normalizedArgs, "symbolId");

          // Centralized input validation: parse against the registered Zod schema
          // before dispatching to the handler. This ensures all tools receive
          // validated, coerced arguments regardless of individual handler logic.
          const parseResult = tool.inputSchema.safeParse(normalizedArgs);
          if (!parseResult.success) {
            const issueDetails = parseResult.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            }));
            const humanLines = issueDetails.map((d) =>
              d.path ? `  - ${d.path}: ${d.message}` : `  - ${d.message}`,
            );
            const validationError = {
              error: {
                message: `Invalid tool arguments:\n${humanLines.join("\n")}`,
                code: "VALIDATION_ERROR",
                details: issueDetails,
              },
            };
            process.stderr.write(
              `[sdl-mcp] Tool ${request.params.name} validation error: ${JSON.stringify(validationError)}
`,
            );
            logToolCall({
              tool: request.params.name,
              request: normalizedArgs as Record<string, unknown>,
              response: validationError,
              durationMs: Date.now() - start,
              repoId,
              symbolId,
            });
            return {
              content: [
                {
                  type: "text",
                  text: validationError.error.message,
                },
              ],
              isError: true,
            };
          }

          try {
            // Pass the parsed (validated + coerced) data to the handler
            const result = await getToolDispatchLimiter().run(() =>
              tool.handler(parseResult.data, toolContext),
            );

            // Inject _tokenUsage and strip _rawContext before serialization
            let finalResult = result;
            let capturedUsage: TokenUsageMetadata | undefined;
            if (result && typeof result === "object") {
              const r = result as Record<string, unknown>;
              if (shouldAttachUsage(request.params.name) && r._rawContext) {
                r._tokenUsage = await computeTokenUsage(r);
              }
              // Accumulate session-level token usage
              if (r._tokenUsage) {
                const usage = r._tokenUsage as TokenUsageMetadata;
                tokenAccumulator.recordUsage(
                  request.params.name,
                  usage.sdlTokens,
                  usage.rawEquivalent,
                );
                // Send per-call savings notification to user (MCP logging)
                void toolContext
                  .sendNotification({
                    method: "notifications/message",
                    params: {
                      level: "info",
                      logger: "sdl-mcp",
                      data: renderUserNotificationLine(
                        usage.sdlTokens,
                        usage.rawEquivalent,
                      ),
                    },
                  })
                  .catch(() => {
                    /* non-critical */
                  });
              } else if (
                shouldAttachUsage(request.params.name) &&
                typeof r.totalTokens === "number" &&
                r.totalTokens > 0
              ) {
                // Neutral accounting: count the call but model zero savings
                tokenAccumulator.recordUsage(
                  request.params.name,
                  r.totalTokens,
                  r.totalTokens,
                );
              }

              // Send human-readable tool call summary to user (MCP logging)
              const userDisplay = formatToolCallForUser(
                request.params.name,
                normalizedArgs as Record<string, unknown>,
                r,
              );
              if (userDisplay) {
                void toolContext
                  .sendNotification({
                    method: "notifications/message",
                    params: {
                      level: "info",
                      logger: "sdl-mcp",
                      data: userDisplay,
                    },
                  })
                  .catch(() => {
                    /* non-critical */
                  });
              }

              // Capture token usage before stripping internal fields
              capturedUsage = r._tokenUsage as TokenUsageMetadata | undefined;
              finalResult = stripRawContext(r);
              // Also strip _tokenUsage (stripRawContext only handles _rawContext)
              if (
                finalResult &&
                typeof finalResult === "object" &&
                "_tokenUsage" in finalResult
              ) {
                delete (finalResult as Record<string, unknown>)._tokenUsage;
              }
              // Compact broad context responses — hide actionsTaken, path, metrics, retrievalEvidence
              finalResult = projectBroadContextResult(
                request.params.name,
                finalResult,
              );
            }

            // Capture formatted summary for content block before it gets deleted
            let capturedSummary: string | undefined;

            // Send formatted summary as user notification for usage stats
            if (
              request.params.name === "sdl.usage.stats" &&
              finalResult &&
              typeof finalResult === "object" &&
              "formattedSummary" in finalResult
            ) {
              const summary = (finalResult as Record<string, unknown>)
                .formattedSummary;
              if (typeof summary === "string") {
                void toolContext
                  .sendNotification({
                    method: "notifications/message",
                    params: {
                      level: "info",
                      logger: "sdl-mcp",
                      data: summary,
                    },
                  })
                  .catch(() => {
                    /* non-critical */
                  });
                // Strip from tool response — summary is for the user, not the LLM
                capturedSummary = summary;
                delete (finalResult as Record<string, unknown>)
                  .formattedSummary;
              }
            }

            // Run post-dispatch hooks (non-critical)
            for (const hook of this.postDispatchHooks) {
              try {
                await Promise.race([
                  hook(
                    request.params.name,
                    parseResult.data,
                    finalResult,
                    toolContext,
                  ),
                  new Promise((_, reject) =>
                    setTimeout(
                      () => reject(new Error("Post-dispatch hook timed out")),
                      5_000,
                    ).unref(),
                  ),
                ]);
              } catch (err) {
                process.stderr.write(
                  `[sdl-mcp] Post-dispatch hook failed for tool ${request.params.name}: ${err instanceof Error ? err.message : String(err)}
`,
                );
              }
            }

            logToolCall({
              tool: request.params.name,
              request: normalizedArgs as Record<string, unknown>,
              response: finalResult as Record<string, unknown>,
              durationMs: Date.now() - start,
              repoId,
              symbolId,
            });
            const footerLines: string[] = [];
            if (capturedUsage && capturedUsage.rawEquivalent > 0) {
              footerLines.push(
                `📊 ${formatTokenCount(capturedUsage.sdlTokens)} / ${formatTokenCount(capturedUsage.rawEquivalent)} tokens (SDL/raw-equiv) ${capturedUsage.meter}`,
              );
            }
            if (capturedSummary) {
              footerLines.push(capturedSummary);
            }
            const primaryPayload = attachDisplayFooter(
              finalResult,
              footerLines.join("\n\n"),
            );

            // Wrap result in MCP content format
            const contentBlocks: Array<{ type: string; text: string }> = [
              {
                type: "text",
                text: JSON.stringify(primaryPayload, null, 2),
              },
            ];

            // Append per-call token savings meter (visible in tool response)
            // Skip for compacted broad context — meter is already in _displayFooter
            const wasCompacted = isBroadContextResult(
              request.params.name,
              result,
            );
            if (
              capturedUsage &&
              capturedUsage.rawEquivalent > 0 &&
              !wasCompacted
            ) {
              contentBlocks.push({
                type: "text",
                text: `📊 ${formatTokenCount(capturedUsage.sdlTokens)} / ${formatTokenCount(capturedUsage.rawEquivalent)} tokens (SDL/raw-equiv) ${capturedUsage.meter}`,
              });
            }

            // Append session/lifetime summary for usage.stats (visible in tool response)
            if (capturedSummary) {
              contentBlocks.push({
                type: "text",
                text: capturedSummary,
              });
            }

            return { content: contentBlocks };
          } catch (error) {
            process.stderr.write(
              `[sdl-mcp] Tool ${request.params.name} error: ${error}\n`,
            );
            logToolCall({
              tool: request.params.name,
              request: normalizedArgs as Record<string, unknown>,
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
          process.stderr.write(
            `[sdl-mcp] CallTool outer error: ${outerError}\n`,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(errorToMcpResponse(outerError), null, 2),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  registerTool(
    name: string,
    description: string,
    inputSchema: z.ZodType,
    handler: ToolHandler,
    wireSchema?: Record<string, unknown>,
    presentation?: Partial<ToolPresentation>,
  ): void {
    this.tools.set(name, {
      name,
      description,
      inputSchema,
      handler,
      wireSchema,
      presentation: buildToolPresentation(name, presentation),
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async stop(): Promise<void> {
    // Usage persistence is handled by the ShutdownManager's "persistUsage"
    // cleanup (registered in serve.ts) which runs while the DB is still open.
    await this.server.close();
  }

  getServer(): Server {
    return this.server;
  }

  /**
   * Clear all registered tools and notify connected clients.
   * Used when toggling gateway mode at runtime.
   */
  clearTools(): void {
    this.tools.clear();
  }

  /**
   * Notify connected clients that the tool list has changed.
   * Clients that support listChanged will re-fetch tools/list.
   */
  async notifyToolListChanged(): Promise<void> {
    try {
      await this.server.sendToolListChanged();
    } catch (err) {
      // Swallow errors if no client is connected or notification fails
      process.stderr.write(
        `[sdl-mcp] Failed to send tool list changed notification: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

function extractStringField(args: unknown, field: string): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function convertSchema(
  schema: z.ZodType,
  compact = false,
): Record<string, unknown> {
  if (compact) {
    return buildCompactJsonSchema(schema);
  }
  return zodSchemaToJsonSchema(schema);
}

/**
 * Services that can be injected into an MCPServer instance.
 */
export interface MCPServerServices {
  liveIndex?: LiveIndexCoordinator;
  gatewayConfig?: { enabled?: boolean; emitLegacyTools?: boolean };
  codeModeConfig?: CodeModeConfig;
}

/**
 * Factory function to create a fully-configured MCPServer with all tools registered.
 * Uses dynamic import to avoid eager loading of all tool modules at the top level.
 * Used by the HTTP transport to create per-session server instances.
 */
export async function createMCPServer(
  services: MCPServerServices = {},
): Promise<MCPServer> {
  const { registerTools } = await import("./mcp/tools/index.js");
  const server = new MCPServer();
  registerTools(
    server,
    { liveIndex: services.liveIndex },
    services.gatewayConfig,
    services.codeModeConfig,
  );
  return server;
}
