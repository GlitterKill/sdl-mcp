import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type ToolAnnotations,
  type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getLadybugConn } from "./db/ladybug.js";
import { IndexError } from "./domain/errors.js";
import { errorToMcpResponse } from "./mcp/errors.js";
import { runToolDispatch } from "./mcp/dispatch-limiter.js";
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
import { wasteLedger } from "./mcp/waste-ledger.js";
import { renderUserNotificationLine } from "./mcp/savings-meter.js";
import { formatToolCallForUser } from "./mcp/tool-call-formatter.js";
import type { LiveIndexCoordinator } from "./live-index/types.js";
import type {
  CodeModeConfig,
  GatewayConfig,
  ToolNameFormat,
} from "./config/types.js";
import {
  extractReferencedSymbolIds,
  normalizeToolArguments,
} from "./mcp/request-normalization.js";
import {
  buildToolPresentation,
  buildVersionedToolDescription,
  type ToolPresentation,
} from "./mcp/tool-presentation.js";
import { getPackageVersion } from "./util/package-info.js";
import {
  projectBroadContextResult,
  projectContextResultForUsageAccounting,
  projectToolResultForModelContent,
} from "./mcp/context-response-projection.js";
import { logger } from "./util/logger.js";
import {
  attachTimingDiagnostics,
  hasTimingDiagnostics,
  ToolPhaseTimer,
  type ToolTimingDiagnostics,
} from "./mcp/timing-diagnostics.js";
import { SDL_MCP_SERVER_INSTRUCTIONS } from "./mcp/server-instructions.js";
import { markActionArgsParsed } from "./gateway/dispatch-spine.js";
import { classifyPublicGraphRetrieval } from "./mcp/public-graph-retrieval-admission.js";
import { assertGraphRetrievalAvailable } from "./services/graph-retrieval-availability.js";

export interface ToolContext {
  progressToken?: string | number;
  sendNotification: (notification: ServerNotification) => Promise<void>;
  signal: AbortSignal;
  /** Set from transport session for HTTP; undefined for stdio (defaults to "stdio" in hooks). */
  sessionId?: string;
  /** Stable, low-cardinality client identity for outcome-trained policies. */
  clientKey?: string;
  /** Inferred task class used to scope predictive context learning. */
  taskType?: string;
  /** Transport request metadata, kept for telemetry and policy attribution only. */
  requestInfo?: unknown;
}

export type PostDispatchHook = (
  toolName: string,
  args: unknown,
  result: unknown,
  context: ToolContext,
) => Promise<void>;

function sanitizeClientKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 80);
}

function classifyUserAgent(userAgent: string): string {
  const lower = userAgent.toLowerCase();
  if (lower.includes("codex")) return "codex";
  if (lower.includes("claude")) return "claude";
  if (lower.includes("cursor")) return "cursor";
  if (lower.includes("vscode") || lower.includes("visual studio code"))
    return "vscode";
  if (lower.includes("cline")) return "cline";
  const firstProduct = userAgent.split(/\s+/)[0] ?? "unknown";
  return (
    sanitizeClientKeyPart(firstProduct.split("/")[0] ?? firstProduct) ||
    "unknown"
  );
}

export function deriveClientKey(
  sessionId?: string,
  requestInfo?: unknown,
): string {
  const explicitClient = readRequestHeader(requestInfo, "x-sdl-client");
  if (explicitClient) {
    return `client:${sanitizeClientKeyPart(explicitClient)}`;
  }
  const userAgent = readRequestHeader(requestInfo, "user-agent");
  if (userAgent) {
    return `ua:${classifyUserAgent(userAgent)}`;
  }
  if (typeof sessionId === "string" && sessionId.length > 0) {
    return `session:${sanitizeClientKeyPart(sessionId)}`;
  }
  return "stdio";
}

function readRequestHeader(
  requestInfo: unknown,
  name: string,
): string | undefined {
  if (!requestInfo || typeof requestInfo !== "object") return undefined;
  const headers = (requestInfo as { headers?: unknown }).headers;
  const lowerName = name.toLowerCase();
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (key: string) => unknown }).get(name);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(
      headers as Record<string, unknown>,
    )) {
      if (key.toLowerCase() !== lowerName) continue;
      if (typeof value === "string") return value;
      if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    }
  }
  return undefined;
}

function inferTaskType(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const explicit = extractStringField(args, "taskType");
  if (explicit) return explicit;
  const normalized = toolName.replace(/^sdl\./, "");
  const root = normalized.split(".")[0];
  return (root || "general").replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 64);
}

interface ToolHandler {
  (args: unknown, context?: ToolContext): Promise<unknown>;
}

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: z.ZodType;
  handler: ToolHandler;
  wireSchema?: Record<string, unknown>;
  outputSchema?: z.ZodType;
  presentation: ToolPresentation;
}

export function attachDisplayFooter(
  result: unknown,
  footerText: string,
): unknown {
  if (
    !footerText ||
    result === null ||
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

function shouldIncludeDisplayFooter(toolArgs: Record<string, unknown>): boolean {
  const options = isRecordValue(toolArgs.options) ? toolArgs.options : {};
  return toolArgs.includeTelemetry === true
    || options.includeTelemetry === true
    || toolArgs.detail === "full"
    || options.detail === "full";
}

interface ToolResponseContentBlock {
  type: "text";
  text: string;
}

interface ToolResponseEnvelope extends Record<string, unknown> {
  content: ToolResponseContentBlock[];
  structuredContent?: Record<string, unknown>;
  _displayFooter?: string;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const STRUCTURED_CONTENT_INTERNAL_KEYS = new Set([
  "_packedPayload",
  "_packedStats",
  "_tokenUsage",
  "_displayFooter",
  "actionsTaken",
  "contextModeHint",
  "metrics",
  "rungs",
  "taskId",
  "tokenEstimate",
]);

function asStructuredContent(
  value: unknown,
  toolArgs: Record<string, unknown> = {},
): Record<string, unknown> {
  const optionsFromArgs = (args: Record<string, unknown>) => {
    const options = isRecordValue(args.options) ? args.options : {};
    const detail = args.detail ?? options.detail;
    const fullDetail = detail === "full";
    return {
      includeDiagnostics:
        fullDetail || args.includeDiagnostics === true || options.includeDiagnostics === true,
      includeRetrievalEvidence:
        fullDetail
        || args.includeRetrievalEvidence === true
        || options.includeRetrievalEvidence === true,
    };
  };
  const workflowSteps = Array.isArray(toolArgs.steps) ? toolArgs.steps : [];

  const sanitize = (
    item: unknown,
    activeOptions: ReturnType<typeof optionsFromArgs>,
    isRoot = false,
  ): unknown => {
    if (Array.isArray(item)) {
      return item.map((child) => sanitize(child, activeOptions));
    }
    if (!isRecordValue(item)) {
      return item;
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, itemValue] of Object.entries(item)) {
      if (STRUCTURED_CONTENT_INTERNAL_KEYS.has(key) || (isRoot && key === "path")) {
        continue;
      }
      if (key === "diagnostics" && !activeOptions.includeDiagnostics) {
        continue;
      }
      if (key === "retrievalEvidence" && !activeOptions.includeRetrievalEvidence) {
        continue;
      }
      if (key === "finalEvidence" && Array.isArray(itemValue)) {
        sanitized.finalEvidence = itemValue.map((evidenceItem) => {
          if (!isRecordValue(evidenceItem)) {
            return evidenceItem;
          }
          const { timestamp: _timestamp, ...evidence } = evidenceItem;
          return sanitize(evidence, activeOptions);
        });
        continue;
      }
      if (isRoot && key === "results" && Array.isArray(itemValue)) {
        sanitized.results = itemValue.map((step, index) => {
          if (!isRecordValue(step)) {
            return sanitize(step, activeOptions);
          }
          const sourceStepIndex = typeof step.stepIndex === "number"
            ? step.stepIndex
            : index;
          const workflowStep = workflowSteps[sourceStepIndex];
          const childArgs =
            isRecordValue(workflowStep) && isRecordValue(workflowStep.args)
              ? workflowStep.args
              : {};
          const childOptions = optionsFromArgs(childArgs);
          const sanitizedStep: Record<string, unknown> = {};
          for (const [stepKey, stepValue] of Object.entries(step)) {
            sanitizedStep[stepKey] = sanitize(
              stepValue,
              stepKey === "result" ? childOptions : activeOptions,
            );
          }
          return sanitizedStep;
        });
        continue;
      }
      sanitized[key] = sanitize(itemValue, activeOptions);
    }
    return sanitized;
  };

  const structured = isRecordValue(value)
    ? sanitize(value, optionsFromArgs(toolArgs), true)
    : { value };
  return structured as Record<string, unknown>;
}

export function extractDeliveredSymbolIdsFromToolResult(
  result: Record<string, unknown>,
): string[] {
  const ids = new Set<string>();
  collectDeliveredSymbolIds(result, ids);
  return [...ids].sort();
}

function collectDeliveredSymbolIds(
  result: Record<string, unknown>,
  ids: Set<string>,
): void {
  if (typeof result.results === "string") {
    addSymbolIdsFromPackedPayload(result.results, ids);
  } else {
    addSymbolIdsFromRows(result.results, ids);
  }
  addSymbolIdsFromRows(result.cards, ids);
  addSymbolIdFromCard(result.card, ids);
  addSymbolIdsFromEvidence(result.finalEvidence, ids);
  if (typeof result._packedPayload === "string") {
    addSymbolIdsFromPackedPayload(result._packedPayload, ids);
  }
  // sdl.workflow wraps each step as { fn, result } inside results[].
  if (Array.isArray(result.results)) {
    for (const step of result.results) {
      if (isRecordValue(step) && isRecordValue(step.result)) {
        collectDeliveredSymbolIds(step.result, ids);
      }
    }
  }
}

function addSymbolIdsFromPackedPayload(payload: string, ids: Set<string>): void {
  if (!payload.startsWith("#PACKED/")) return;
  for (const line of payload.split("\n")) {
    if (!line.startsWith("@ids=")) continue;
    for (const entry of line.slice("@ids=".length).split(",")) {
      const separatorAt = entry.indexOf(":");
      if (separatorAt <= 0) continue;
      const fullId = entry.slice(separatorAt + 1);
      if (fullId.length > 0) ids.add(fullId);
    }
  }
}

function addSymbolIdsFromRows(value: unknown, ids: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) addSymbolIdFromCard(item, ids);
}

function addSymbolIdFromCard(value: unknown, ids: Set<string>): void {
  if (!isRecordValue(value) || value.unchanged === true) return;
  const symbolId = value.symbolId;
  if (typeof symbolId === "string" && symbolId.length > 0) {
    ids.add(symbolId);
  }
}

function addSymbolIdsFromEvidence(value: unknown, ids: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isRecordValue(item) || item.unchanged === true) continue;
    if (item.type !== "symbolCard") continue;
    const reference = item.reference;
    if (typeof reference === "string") {
      ids.add(reference.startsWith("symbol:") ? reference.slice("symbol:".length) : reference);
    }
  }
}

// MCP edit envelopes already retain machine-readable snippets in structured
// content. Only their visible text uses summary mode; notifications and CLI
// formatting call the formatter separately and keep its default full mode.
function isEditToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
): boolean {
  if (toolName === "sdl.file") {
    return (
      toolArgs.op === "write" ||
      toolArgs.op === "searchEditPreview" ||
      toolArgs.op === "searchEditApply" ||
      (typeof toolArgs.op === "string" && toolArgs.op.startsWith("symbolEdit"))
    );
  }
  return (
    toolName === "sdl.file.write" ||
    toolName === "sdl.search.edit" ||
    toolName === "sdl.symbol.edit"
  );
}

export function buildToolResponseContentBlocks(
  primaryPayload: unknown,
  userDisplay: string | null,
  footerText: string,
  toolName = "",
  toolArgs: Record<string, unknown> = {},
): ToolResponseContentBlock[] {
  const displayText =
    userDisplay ??
    formatToolCallForUser(toolName, toolArgs, primaryPayload, {
      presentation: isEditToolCall(toolName, toolArgs) ? "summary" : "full",
    });
  const contentBlocks: ToolResponseContentBlock[] = [
    {
      type: "text",
      text: displayText ?? `${toolName || "tool"} -> complete`,
    },
  ];

  if (footerText && shouldIncludeDisplayFooter(toolArgs)) {
    contentBlocks.push({
      type: "text",
      text: footerText,
    });
  }
  return contentBlocks;
}

export function buildToolResponseEnvelope(
  primaryPayload: unknown,
  userDisplay: string | null,
  footerText: string,
  toolName = "",
  toolArgs: Record<string, unknown> = {},
  structuredPayload: unknown = primaryPayload,
): ToolResponseEnvelope {
  const modelPayload = projectToolResultForModelContent(
    toolName,
    primaryPayload,
    toolArgs,
  );
  const safeUserDisplay =
    (toolName === "usage.stats" || toolName === "sdl.usage.stats")
      ? userDisplay
      : null;
  const content = buildToolResponseContentBlocks(
    modelPayload,
    safeUserDisplay,
    footerText,
    toolName,
    toolArgs,
  );
  const sanitizedStructuredPayload = asStructuredContent(structuredPayload, toolArgs);
  const structuredModelPayload = projectToolResultForModelContent(
    toolName,
    sanitizedStructuredPayload,
    toolArgs,
  );
  const structuredContent = isRecordValue(structuredModelPayload)
    ? structuredModelPayload
    : { value: structuredModelPayload };
  const visibleFooterText = shouldIncludeDisplayFooter(toolArgs) ? footerText : "";
  return visibleFooterText
    ? { content, structuredContent, _displayFooter: visibleFooterText }
    : { content, structuredContent };
}

export interface MCPServerOptions {
  /** OpenAI-compatible clients reject dots in tool names; keep canonical by default. */
  toolNameFormat?: ToolNameFormat;
}

export class MCPServer {
  private server: Server;
  private tools: Map<string, ToolDefinition> = new Map();
  private clientToolNameToCanonical: Map<string, string> = new Map();
  private readonly toolNameFormat: ToolNameFormat;
  private _gatewayMode = false;
  private postDispatchHooks: PostDispatchHook[] = [];

  constructor(options: MCPServerOptions = {}) {
    this.toolNameFormat = options.toolNameFormat ?? "canonical";
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
        instructions: SDL_MCP_SERVER_INSTRUCTIONS,
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
            name: this.formatToolNameForClient(tool.name),
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
            ...(tool.outputSchema
              ? { outputSchema: convertSchema(tool.outputSchema, this._gatewayMode) }
              : {}),
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
        const extraContext = extra as typeof extra & {
          requestInfo?: unknown;
          sessionId?: string;
        };
        const toolContext: ToolContext = {
          progressToken: extra._meta?.progressToken,
          sendNotification: extra.sendNotification,
          signal: extra.signal,
          sessionId: extraContext.sessionId,
          clientKey: deriveClientKey(
            extraContext.sessionId,
            extraContext.requestInfo,
          ),
          requestInfo: extraContext.requestInfo,
        };

        try {
          const requestedToolName = request.params.name;
          const toolName = this.resolveCanonicalToolName(requestedToolName);
          const tool = this.tools.get(toolName);
          if (!tool) {
            const notFoundResponse = {
              error: {
                message: "Tool not found",
                code: "TOOL_NOT_FOUND",
              },
            };
            return {
              ...buildToolResponseEnvelope(
                notFoundResponse,
                null,
                "",
                toolName,
                {},
              ),
              isError: true,
            };
          }

          const start = Date.now();
          const timer = new ToolPhaseTimer();
          const normalizeStartedAt = timer.start();
          const normalizedArgs = normalizeToolArguments(
            request.params.arguments,
            toolContext.sessionId,
          );
          timer.record("server.normalize", normalizeStartedAt);
          const includeDiagnostics = wantsTimingDiagnostics(normalizedArgs);
          const repoId = extractStringField(normalizedArgs, "repoId");
          const symbolId = extractStringField(normalizedArgs, "symbolId");
          toolContext.taskType = inferTaskType(
            toolName,
            normalizedArgs as Record<string, unknown>,
          );

          // Centralized input validation: parse against the registered Zod schema
          // before dispatching to the handler. This ensures all tools receive
          // validated, coerced arguments regardless of individual handler logic.
          const validationStartedAt = timer.start();
          const parseResult = tool.inputSchema.safeParse(normalizedArgs);
          timer.record("server.validate", validationStartedAt);
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
              `[sdl-mcp] Tool ${toolName} validation error: ${JSON.stringify(validationError)}
`,
            );
            const responseForLog = includeDiagnostics
              ? attachTimingDiagnostics(validationError, timer.snapshot())
              : validationError;
            logToolCall({
              tool: toolName,
              request: normalizedArgs as Record<string, unknown>,
              response: responseForLog,
              durationMs: Date.now() - start,
              repoId,
              symbolId,
              clientKey: toolContext.clientKey,
              taskType: toolContext.taskType,
              diagnostics: extractTimingDiagnostics(responseForLog),
            });
            return {
              ...buildToolResponseEnvelope(
                responseForLog,
                null,
                "",
                toolName,
                normalizedArgs as Record<string, unknown>,
              ),
              isError: true,
            };
          }

          const parsedArgs = markActionArgsParsed(
            tool.inputSchema,
            parseResult.data,
          );
          try {
            const dispatchTool = async (): Promise<unknown> => {
              const graphAdmission = classifyPublicGraphRetrieval(
                toolName,
                parsedArgs,
              );
              if (graphAdmission.mode === "central") {
                if (!graphAdmission.repoId) {
                  throw new IndexError(
                    'Graph retrieval requires an explicit repoId. Provide repoId. Run sdl.index.refresh with mode:"full" if the graph must be rebuilt and verified.',
                  );
                }
                const conn = await getLadybugConn();
                await assertGraphRetrievalAvailable(
                  conn,
                  graphAdmission.repoId,
                );
              }
              if (toolContext.sessionId && isRecordValue(parsedArgs)) {
                const referencedSymbolIds =
                  extractReferencedSymbolIds(parsedArgs);
                if (referencedSymbolIds.length > 0) {
                  wasteLedger.recordReferenced(
                    toolContext.sessionId,
                    referencedSymbolIds,
                  );
                }
              }
              return tool.handler(parsedArgs, toolContext);
            };

            // Pass the parsed (validated + coerced) data to the handler
            const dispatchStartedAt = timer.start();
            const result = shouldBypassToolDispatch(toolName, parsedArgs)
              ? await dispatchTool()
              : await runToolDispatch(
                  dispatchTool,
                  undefined,
                  toolName,
                );
            timer.record("server.dispatch", dispatchStartedAt);

            // Inject _tokenUsage and strip _rawContext before serialization
            const responseProcessingStartedAt = timer.start();
            let finalResult = result;
            let structuredResult: unknown = finalResult;
            let tokensUsedForObs: number | undefined;
            let tokensSavedForObs: number | undefined;
            let deliveredTokenCount: number | undefined;
            let userDisplay: string | null = null;
            if (result && typeof result === "object") {
              const r = result as Record<string, unknown>;
              const usageAccountingResult =
                projectContextResultForUsageAccounting(
                  toolName,
                  r,
                  normalizedArgs as Record<string, unknown>,
                );
              if (
                shouldAttachUsage(toolName) &&
                usageAccountingResult._rawContext
              ) {
                r._tokenUsage = await computeTokenUsage(usageAccountingResult);
              }
              // Accumulate session-level token usage
              if (r._tokenUsage) {
                const usage = r._tokenUsage as TokenUsageMetadata;
                tokenAccumulator.recordUsage(
                  toolName,
                  usage.sdlTokens,
                  usage.rawEquivalent,
                );
                tokensUsedForObs = usage.sdlTokens;
                deliveredTokenCount = usage.sdlTokens;
                tokensSavedForObs = Math.max(
                  0,
                  usage.rawEquivalent - usage.sdlTokens,
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
                shouldAttachUsage(toolName) &&
                typeof r.totalTokens === "number" &&
                r.totalTokens > 0
              ) {
                // Neutral accounting: count the call but model zero savings
                tokenAccumulator.recordUsage(
                  toolName,
                  r.totalTokens,
                  r.totalTokens,
                );
                tokensUsedForObs = r.totalTokens;
                deliveredTokenCount = r.totalTokens;
                tokensSavedForObs = 0;
              }

              if (
                toolContext.sessionId &&
                deliveredTokenCount !== undefined &&
                deliveredTokenCount > 0
              ) {
                const deliveredSymbolIds = extractDeliveredSymbolIdsFromToolResult(r);
                if (deliveredSymbolIds.length > 0) {
                  wasteLedger.recordDelivered(
                    toolContext.sessionId,
                    toolName,
                    deliveredSymbolIds,
                    deliveredTokenCount,
                  );
                }
              }

              // Send human-readable tool call summary to user (MCP logging)
              userDisplay = formatToolCallForUser(
                toolName,
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

              finalResult = stripRawContext(r);
              structuredResult =
                finalResult && typeof finalResult === "object" && !Array.isArray(finalResult)
                  ? { ...(finalResult as Record<string, unknown>) }
                  : finalResult;
              // Also strip _tokenUsage (stripRawContext only handles _rawContext)
              if (
                finalResult &&
                typeof finalResult === "object" &&
                "_tokenUsage" in finalResult
              ) {
                delete (finalResult as Record<string, unknown>)._tokenUsage;
              }
              // Compact broad context responses — hide actionsTaken, path, metrics, retrievalEvidence
              finalResult = projectBroadContextResult(toolName, finalResult);
            }

            // Capture formatted summary for content block before it gets deleted
            let capturedSummary: string | undefined;

            // Send formatted summary as user notification for usage stats
            if (
              toolName === "sdl.usage.stats" &&
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
                userDisplay = summary;
                capturedSummary = summary;
                delete (finalResult as Record<string, unknown>)
                  .formattedSummary;
              }
            }

            // Run post-dispatch hooks (non-critical)
            for (const hook of this.postDispatchHooks) {
              const hookAbortController = new AbortController();
              const abortHook = (): void => {
                hookAbortController.abort();
              };
              if (toolContext.signal.aborted) {
                hookAbortController.abort();
              } else {
                toolContext.signal.addEventListener("abort", abortHook, {
                  once: true,
                });
              }
              const hookContext: ToolContext = {
                ...toolContext,
                signal: hookAbortController.signal,
              };
              let timeoutHandle: NodeJS.Timeout | null = null;
              try {
                const hookStartedAt = timer.start();
                await Promise.race([
                  hook(toolName, parsedArgs, finalResult, hookContext),
                  new Promise((_, reject) =>
                    (timeoutHandle = setTimeout(() => {
                      hookAbortController.abort();
                      reject(new Error("Post-dispatch hook timed out"));
                    }, 5_000)).unref(),
                  ),
                ]);
                timer.record("server.postDispatchHook", hookStartedAt);
              } catch (err) {
                process.stderr.write(
                  `[sdl-mcp] Post-dispatch hook failed for tool ${toolName}: ${err instanceof Error ? err.message : String(err)}
`,
                );
              } finally {
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                }
                toolContext.signal.removeEventListener("abort", abortHook);
              }
            }
            timer.record(
              "server.responseProcessing",
              responseProcessingStartedAt,
            );
            if (includeDiagnostics) {
              const diagnosticsSnapshot = timer.snapshot();
              finalResult = attachTimingDiagnostics(
                finalResult,
                diagnosticsSnapshot,
              );
              structuredResult = attachTimingDiagnostics(
                structuredResult,
                diagnosticsSnapshot,
              );
            }

            logToolCall({
              tool: toolName,
              request: normalizedArgs as Record<string, unknown>,
              response: finalResult as Record<string, unknown>,
              durationMs: Date.now() - start,
              repoId,
              symbolId,
              clientKey: toolContext.clientKey,
              taskType: toolContext.taskType,
              tokensUsed: tokensUsedForObs,
              tokensSaved: tokensSavedForObs,
              diagnostics: extractTimingDiagnostics(finalResult),
            });
            const footerLines: string[] = [];
            if (capturedSummary) {
              footerLines.push(capturedSummary);
            }

            const footerText = footerLines.join("\n\n");
            const primaryPayload = attachDisplayFooter(finalResult, footerText);
            return buildToolResponseEnvelope(
              primaryPayload,
              userDisplay,
              footerText,
              toolName,
              normalizedArgs as Record<string, unknown>,
              structuredResult,
            );
          } catch (error) {
            process.stderr.write(
              `[sdl-mcp] Tool ${toolName} error: ${error}\n`,
            );
            const errorResponse = errorToMcpResponse(error);
            const responseForLog = includeDiagnostics
              ? attachTimingDiagnostics(errorResponse, timer.snapshot())
              : errorResponse;
            logToolCall({
              tool: toolName,
              request: normalizedArgs as Record<string, unknown>,
              response: responseForLog,
              durationMs: Date.now() - start,
              repoId,
              symbolId,
              clientKey: toolContext.clientKey,
              taskType: toolContext.taskType,
              diagnostics: extractTimingDiagnostics(responseForLog),
            });
            // Return projected error content instead of throwing so clients get
            // the same human-first envelope shape as successful tool calls.
            return {
              ...buildToolResponseEnvelope(
                responseForLog,
                null,
                "",
                toolName,
                normalizedArgs as Record<string, unknown>,
              ),
              isError: true,
            };
          }
        } catch (outerError) {
          process.stderr.write(
            `[sdl-mcp] CallTool outer error: ${outerError}\n`,
          );
          const outerErrorResponse = errorToMcpResponse(outerError);
          return {
            ...buildToolResponseEnvelope(
              outerErrorResponse,
              null,
              "",
              request.params.name,
              {},
            ),
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
    outputSchema?: z.ZodType,
  ): void {
    if (this.tools.has(name)) {
      logger.warn("Duplicate tool registration", { name });
    }
    this.registerToolNameAlias(name);
    this.tools.set(name, {
      name,
      description,
      inputSchema,
      handler,
      wireSchema,
      outputSchema,
      presentation: buildToolPresentation(name, presentation),
    });
  }

  private formatToolNameForClient(name: string): string {
    if (this.toolNameFormat !== "openai") {
      return name;
    }
    return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  }

  private registerToolNameAlias(name: string): void {
    const clientName = this.formatToolNameForClient(name);
    const existing = this.clientToolNameToCanonical.get(clientName);
    if (existing && existing !== name) {
      throw new Error(
        `Tool name alias collision for ${clientName}: ${existing} and ${name}`,
      );
    }
    this.clientToolNameToCanonical.set(clientName, name);
  }

  private resolveCanonicalToolName(name: string): string {
    return this.clientToolNameToCanonical.get(name) ?? name;
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
      logger.warn("Failed to send tool list changed notification", {
        error: err,
      });
    }
  }
}

export function isMetadataOnlyTool(name: string): boolean {
  return name === "sdl.action.search" || name === "sdl.manual";
}

const DIRECT_STATUS_TOOL_NAMES = new Set([
  "sdl.repo.status",
  "repo.status",
  "sdl.buffer.status",
  "buffer.status",
  "sdl.policy.get",
  "policy.get",
  "sdl.response.get",
  "response.get",
  "sdl.usage.stats",
  "usage.stats",
]);

const STATUS_GATEWAY_TOOL_NAMES = new Set([
  "sdl.repo",
  "sdl.agent",
  "sdl.code",
  "sdl.query",
]);

const STATUS_WORKFLOW_FNS = new Set([
  "repo.status",
  "repoStatus",
  "buffer.status",
  "bufferStatus",
  "policy.get",
  "policyGet",
  "usage.stats",
  "usageStats",
  "response.get",
  "responseGet",
  "dataPick",
  "dataMap",
  "dataFilter",
  "dataSort",
  "dataTemplate",
  "workflowContinuationGet",
]);

export function shouldBypassToolDispatch(name: string, args: unknown): boolean {
  if (isMetadataOnlyTool(name) || DIRECT_STATUS_TOOL_NAMES.has(name)) {
    return true;
  }
  if (STATUS_GATEWAY_TOOL_NAMES.has(name)) {
    const action = extractStringField(args, "action");
    return action !== undefined && STATUS_WORKFLOW_FNS.has(action);
  }
  if (name !== "sdl.workflow") {
    return false;
  }
  return isStatusOnlyWorkflow(args);
}

function isStatusOnlyWorkflow(args: unknown): boolean {
  if (!args || typeof args !== "object") {
    return false;
  }
  const steps = (args as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return false;
  }

  // Keep read-only status workflows visible while an index refresh owns the
  // normal dispatch slot. Mutating, runtime, and context-building workflow
  // steps still go through the shared limiter.
  return steps.every((step) => {
    if (!step || typeof step !== "object") {
      return false;
    }
    const fn = (step as { fn?: unknown }).fn;
    return typeof fn === "string" && STATUS_WORKFLOW_FNS.has(fn);
  });
}

function extractStringField(args: unknown, field: string): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function wantsTimingDiagnostics(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { includeDiagnostics?: unknown }).includeDiagnostics === true
  );
}

function extractTimingDiagnostics(
  value: unknown,
): ToolTimingDiagnostics | undefined {
  if (!value || typeof value !== "object") return undefined;
  const diagnostics = (value as { diagnostics?: unknown }).diagnostics;
  return hasTimingDiagnostics(diagnostics) ? diagnostics : undefined;
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
  gatewayConfig?: GatewayConfig;
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
  const server = new MCPServer({
    toolNameFormat: services.gatewayConfig?.toolNameFormat,
  });
  registerTools(
    server,
    { liveIndex: services.liveIndex },
    services.gatewayConfig,
    services.codeModeConfig,
  );
  return server;
}
