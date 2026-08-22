import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { buildCatalog } from "../../dist/code-mode/action-catalog.js";
import { buildFlatToolDescriptors } from "../../dist/mcp/tools/tool-descriptors.js";
import {
  closeLadybugDb,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import { resetSearchEditPlanStore } from "../../dist/mcp/tools/search-edit/plan-store.js";
import { handleSymbolGetCard } from "../../dist/mcp/tools/symbol.js";
import {
  AgentFeedbackQueryResponseSchema,
  AgentContextOutputSchema,
  BufferCheckpointResponseSchema,
  BufferStatusResponseSchema,
  DeltaGetResponseSchema,
  CodeNeedWindowResponseSchema,
  FileReadResponseSchema,
  FileWriteResponseSchema,
  InfoResponseSchema,
  RepoOverviewResponseSchema,
  RepoStatusResponseSchema,
  RuntimeQueryOutputResponseSchema,
  SearchEditResponseSchema,
  SemanticEnrichmentRefreshResponseSchema,
  SemanticEnrichmentStatusResponseSchema,
  SymbolEditResponseSchema,
  SymbolGetCardResponseSchema,
  withProjectionSuccessOutputSchema,
} from "../../dist/mcp/tools.js";
import {
  buildToolResponseEnvelope,
  createMCPServer,
  type MCPServer,
} from "../../dist/server.js";
import {
  PUBLIC_TOOL_CONTRACT_CASES,
  type PublicToolContractCase,
  type WireFixtureContext,
} from "../fixtures/tool-contract/public-tool-contract-cases.ts";

const TEMP_BASE =
  process.platform === "win32" ? join(homedir(), ".codex", "tmp") : tmpdir();
mkdirSync(TEMP_BASE, { recursive: true });

const TEST_ROOT = mkdtempSync(join(TEMP_BASE, "sdl-output-schema-wire-"));
const REPO_ROOT = join(TEST_ROOT, "repo");
const DB_PATH = join(TEST_ROOT, "graph.lbug");
const CONFIG_PATH = join(TEST_ROOT, "sdl.config.json");
const REPO_ID = "output-schema-wire";
const GREETING_SOURCE = [
  "export function greet(name: string): string {",
  "  const message = \`Hello ${name}\`;",
  "  return message;",
  "}",
  "",
].join("\n");

interface ToolEnvelope {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface WireCase {
  name: string;
  schema: z.ZodType;
  successArgs: () => Record<string, unknown>;
  errorArgs: () => Record<string, unknown>;
  errorTextPattern: RegExp;
}

const LARGE_CODE_SOURCE = [
  "export function widelySeparatedMarkers(): number {",
  "  const firstMarker = 1;",
  ...Array.from(
    { length: 96 },
    (_, index) => `  const filler${index} = ${index};`,
  ),
  "  const lastMarker = 2;",
  "  return firstMarker + lastMarker;",
  "}",
  "",
  ...Array.from({ length: 64 }, (_, index) =>
    [
      `export function skeletonHelper${index}(value: number): number {`,
      `  return value + ${index};`,
      "}",
      "",
    ].join("\n"),
  ),
].join("\n");
const GenericStructuredErrorSchema = z
  .object({
    error: z
      .object({
        message: z.string().min(1),
        code: z.string().min(1),
        details: z.array(z.unknown()).optional(),
        classification: z.string().optional(),
        retryable: z.boolean().optional(),
        fallbackTools: z.array(z.string()).optional(),
        fallbackRationale: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

function responseText(response: ToolEnvelope): string {
  return (response.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function assertConciseText(response: ToolEnvelope, label: string): void {
  const text = responseText(response);
  assert.ok(text.length > 0, `${label}: expected non-empty text`);
  assert.ok(text.length <= 4_000, `${label}: text should remain concise`);
}


function assertNoDefaultVolatility(
  value: unknown,
  label: string,
  allowVolatileFields = false,
  allowRecoveryFields = false,
): void {
  if (typeof value === "string") {
    assert.equal(
      /(?:^|[\s"'=:(])(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/(?:Applications|Library|System|Users|etc|home|mnt|opt|private|root|tmp|usr|var|workspace)(?:\/|$))/iu.test(
        value,
      ),
      false,
      label + ": absolute path leaked: " + value,
    );
    if (!allowVolatileFields) {
      assert.doesNotMatch(
        value,
        /(?:\(\d+(?:\.\d+)?\s*ms\)|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b|\bsession[-_ ]?id\s*[:=]\s*[a-z0-9][\w.-]*)/iu,
        label + ": volatile default text: " + value,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) =>
      assertNoDefaultVolatility(
        entry,
        label,
        allowVolatileFields,
        allowRecoveryFields,
      ),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, entry] of Object.entries(value)) {
    assert.equal(
      !allowRecoveryFields && (key === "nextAction" || key === "nextActions"),
      false,
      label + ": phantom recovery field " + key,
    );
    if (!allowVolatileFields) {
      assert.doesNotMatch(
        key,
        /^(?:timestamp|.*(?:Duration|Elapsed)Ms|totalMs|session(?:Id|Count|Delta)|lastIndexedAt|createdAt|updatedAt|expiresAt)$/iu,
        label + ": volatile default field " + key,
      );
    }
    assertNoDefaultVolatility(
      entry,
      label,
      allowVolatileFields,
      allowRecoveryFields,
    );
  }
}

it("rejects embedded machine paths and volatile default text", () => {
  for (const value of [
    "Config: F:\\secret",
    "Share: \\\\server\\secret",
    "Config: /home/agent/.sdl/config.json",
    "done (39ms)",
    "indexed 2026-08-21T12:34:56.789Z",
    "session-id: output-schema-wire-42",
  ]) {
    assert.throws(() => assertNoDefaultVolatility(value, "self-check"), value);
  }

  for (const value of [
    "src/mcp/tools.ts",
    "https://example.com/home/agent",
    "/results/0/path",
  ]) {
    assert.doesNotThrow(() => assertNoDefaultVolatility(value, "self-check"));
  }
});

function assertStableDefaultReport(
  first: ToolEnvelope,
  second: ToolEnvelope,
  schema: z.ZodType,
  label: string,
): Record<string, unknown> {
  const firstText = responseText(first);
  const secondText = responseText(second);
  assert.notEqual(first.isError, true, firstText);
  assert.notEqual(second.isError, true, secondText);
  assert.strictEqual(secondText, firstText, label);
  const firstResult = schema.parse(first.structuredContent) as Record<string, unknown>;
  const secondResult = schema.parse(second.structuredContent) as Record<string, unknown>;
  assert.deepEqual(Object.keys(secondResult), Object.keys(firstResult), label);
  assert.strictEqual(JSON.stringify(secondResult), JSON.stringify(firstResult), label);
  assert.equal(Object.hasOwn(firstResult, "nextAction"), false, label);
  assert.equal(Object.hasOwn(firstResult, "nextActions"), false, label);
  assertNoDefaultVolatility(firstResult, label);
  assertNoDefaultVolatility(firstText, label);
  return firstResult;
}

const RETRIEVE_OP_BY_ACTION = new Map<string, string>([
  ["symbol.search", "symbolSearch"],
  ["symbol.getCard", "symbolGetCard"],
  ["slice.build", "sliceBuild"],
  ["code.getSkeleton", "codeSkeleton"],
  ["code.getHotPath", "codeHotPath"],
  ["code.needWindow", "codeNeedWindow"],
]);

const DIRECT_CODE_MODE_TOOL_BY_ACTION = new Map<string, string>([
  ["action.search", "sdl.action.search"],
  ["context", "sdl.context"],
  ["info", "sdl.info"],
  ["manual", "sdl.manual"],
  ["retrieve", "sdl.retrieve"],
]);

function findStringProperty(value: unknown, key: string): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStringProperty(entry, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  for (const [entryKey, entry] of Object.entries(value)) {
    if (entryKey === key && typeof entry === "string") return entry;
    const found = findStringProperty(entry, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function withoutRepoId(args: Record<string, unknown>): Record<string, unknown> {
  const { repoId: _repoId, ...rest } = args;
  return rest;
}

function resolveContractCall(
  wireCase: PublicToolContractCase,
  args: Record<string, unknown>,
  workflowFn: string | undefined,
  repoId: string,
): { name: string; arguments: Record<string, unknown> } {
  if (wireCase.surface === "flat" || wireCase.surface === "gateway") {
    return { name: `sdl.${wireCase.action}`, arguments: args };
  }
  if (wireCase.surface === "codeMode") {
    const directTool = DIRECT_CODE_MODE_TOOL_BY_ACTION.get(wireCase.action);
    if (directTool !== undefined) return { name: directTool, arguments: args };
    const retrieveOp = RETRIEVE_OP_BY_ACTION.get(wireCase.action);
    if (retrieveOp !== undefined) {
      return {
        name: "sdl.retrieve",
        arguments: {
          repoId,
          op: retrieveOp,
          args: withoutRepoId(args),
          responseMode: "inline",
        },
      };
    }
    if (wireCase.action === "file.read") {
      return { name: "sdl.file", arguments: { op: "read", ...args } };
    }
  }
  assert.ok(
    workflowFn,
    `${wireCase.id}: action ${wireCase.action} is not in the public catalog`,
  );
  return {
    name: "sdl.workflow",
    arguments: {
      repoId,
      onlyFinalResult: true,
      steps: [{ fn: workflowFn, args: withoutRepoId(args) }],
    },
  };
}

function assertWireProjection(
  response: ToolEnvelope,
  advertisedOutputSchema: z.ZodType,
  call: { name: string; arguments?: Record<string, unknown> },
  label: string,
): Record<string, unknown> {
  assert.equal(
    response.isError,
    undefined,
    `${label}: ${responseText(response)} structured=${JSON.stringify(response.structuredContent)}`,
  );
  const textBlock = response.content?.[0];
  assert.equal(textBlock?.type, "text", `${label}: expected one text block`);
  assert.ok(response.structuredContent, `${label}: missing structured content`);
  const expectedEnvelope = buildToolResponseEnvelope(
    response.structuredContent,
    null,
    "",
    call.name,
    call.arguments,
    response.structuredContent,
    true,
    undefined,
    undefined,
    undefined,
    typeof call.arguments.action === "string"
      ? call.arguments.action
      : call.name,
  );
  assert.deepEqual(
    expectedEnvelope.structuredContent,
    response.structuredContent,
    `${label}: declared projector changed the structured projection`,
  );
  assert.equal(
    textBlock?.text,
    expectedEnvelope.content[0]?.text,
    `${label}: text and structured content diverged`,
  );
  if ((textBlock?.text ?? "").trimStart().startsWith("{")) {
    assert.deepEqual(
      JSON.parse(textBlock?.text ?? ""),
      response.structuredContent,
      `${label}: JSON text and structured content diverged`,
    );
  }
  const advertisedParse = advertisedOutputSchema.safeParse(
    response.structuredContent,
  );
  assert.equal(
    advertisedParse.success,
    true,
    `${label}: advertised output schema rejected result=${JSON.stringify(response.structuredContent)} issues=${JSON.stringify(advertisedParse.error?.issues)}`,
  );
  assert.doesNotMatch(
    JSON.stringify(response.structuredContent),
    /An internal error occurred/iu,
    `${label}: generic internal error leaked through success`,
  );
  assertNoDefaultVolatility(response.structuredContent, label, false, true);
  return response.structuredContent as Record<string, unknown>;
}

async function setupWireFixtureContext(
  client: Client,
  symbolId: string,
): Promise<WireFixtureContext> {
  // Named setup: produce every result-dependent handle before any case consumes it.
  const status = (await client.callTool({
    name: "sdl.repo.status",
    arguments: { repoId: REPO_ID },
  })) as ToolEnvelope;
  const versionId = findStringProperty(
    status.structuredContent,
    "latestVersionId",
  );
  assert.ok(versionId, "setup: expected the indexed version");

  const storedResponse = (await client.callTool({
    name: "sdl.file",
    arguments: {
      op: "read",
      repoId: REPO_ID,
      filePath: "notes.txt",
      responseMode: "handle",
    },
  })) as ToolEnvelope;
  const responseHandle = findStringProperty(
    storedResponse.structuredContent,
    "handle",
  );
  assert.ok(
    responseHandle,
    `setup: expected a response handle: ${responseText(storedResponse)}`,
  );

  const runtime = (await client.callTool({
    name: "sdl.runtime.execute",
    arguments: {
      repoId: REPO_ID,
      runtime: "node",
      args: ["-e", "process.stdout.write('wire-output')"],
      outputMode: "minimal",
      persistOutput: true,
      detail: "full",
    },
  })) as ToolEnvelope;
  const runtimeHandle = findStringProperty(
    runtime.structuredContent,
    "artifactHandle",
  );
  assert.ok(
    runtimeHandle,
    `setup: expected a runtime artifact handle: ${responseText(runtime)}`,
  );

  const slice = (await client.callTool({
    name: "sdl.slice.build",
    arguments: {
      repoId: REPO_ID,
      taskText: "Explain greet",
      entrySymbols: [symbolId],
      budget: { maxCards: 8 },
    },
  })) as ToolEnvelope;
  const sliceHandle = findStringProperty(slice.structuredContent, "sliceHandle");
  assert.ok(sliceHandle, "setup: expected a slice handle");

  const continued = (await client.callTool({
    name: "sdl.workflow",
    arguments: {
      repoId: REPO_ID,
      steps: [{
        fn: "dataMap",
        args: {
          input: Array.from({ length: 12 }, (_, index) => ({
            id: index,
            payload: `item-${index}-${"x".repeat(160)}`,
          })),
          fields: { id: "id", payload: "payload" },
        },
        maxResponseTokens: 50,
      }],
    },
  })) as ToolEnvelope;
  const workflowHandle = findStringProperty(
    continued.structuredContent,
    "continuationHandle",
  );
  assert.ok(workflowHandle, "setup: expected a workflow continuation handle");

  const preview = (await client.callTool({
    name: "sdl.file",
    arguments: {
      op: "searchEditPreview",
      repoId: REPO_ID,
      targeting: "text",
      query: { literal: "Hello", replacement: "Hi" },
      filters: { include: ["src/greeting.ts"] },
      editMode: "replacePattern",
      createBackup: false,
    },
  })) as ToolEnvelope;
  const editPreviewHandle = findStringProperty(
    preview.structuredContent,
    "planHandle",
  );
  assert.ok(editPreviewHandle, "setup: expected an edit preview handle");

  return {
    repoId: REPO_ID,
    knownFile: "notes.txt",
    symbolId,
    fromVersion: versionId,
    toVersion: versionId,
    responseHandle,
    runtimeHandle,
    workflowHandle,
    sliceHandle,
    editPreviewHandle,
  };
}
async function executePublicContractCases(
  client: Client,
  flatClient: Client,
  context: WireFixtureContext,
): Promise<void> {
  const expectedCases = PUBLIC_TOOL_CONTRACT_CASES.filter(
    ({ mutation }) => mutation === "none",
  );
  const advertised = new Map(
    (await client.listTools()).tools.map((tool) => [tool.name, tool]),
  );
  const flatAdvertised = new Map(
    (await flatClient.listTools()).tools.map((tool) => [tool.name, tool]),
  );
  const flatOutputSchemas = new Map(
    buildFlatToolDescriptors({}).flatMap((descriptor) =>
      descriptor.outputSchema
        ? [
            [
              descriptor.name,
              withProjectionSuccessOutputSchema(
                descriptor.name.slice(4),
                descriptor.outputSchema,
              ),
            ] as const,
          ]
        : [],
    ),
  );
  const catalog = new Map(
    buildCatalog({ memoryVisible: true, infoVisible: true }).map((entry) => [
      entry.action,
      entry,
    ]),
  );
  const executedCaseIds: string[] = [];
  const projectedByCaseId = new Map<string, unknown>();

  for (const [caseIndex, wireCase] of expectedCases.entries()) {
    const caseLabel = `${wireCase.id} [${wireCase.surface}:${wireCase.action}] case ${caseIndex + 1}/${expectedCases.length}`;
    const catalogEntry = catalog.get(wireCase.action);
    if (wireCase.surface !== "gateway") {
      assert.ok(
        catalogEntry,
        `${caseLabel}: action is not in the public catalog`,
      );
    }
    const surfaceClient = wireCase.surface === "flat" ? flatClient : client;
    const surfaceAdvertised =
      wireCase.surface === "flat" ? flatAdvertised : advertised;
    const call = resolveContractCall(
      wireCase,
      wireCase.buildArgs(context),
      catalogEntry?.fn,
      context.repoId,
    );
    assert.ok(
      surfaceAdvertised.has(call.name),
      `${caseLabel}: ${call.name} is not advertised on its declared surface`,
    );
    let schemaToolName = call.name;
    if (wireCase.surface === "gateway") {
      assert.equal(
        typeof call.arguments.action,
        "string",
        `${caseLabel}: gateway call must declare its routed child action`,
      );
      schemaToolName = `sdl.${call.arguments.action}`;
    }
    const advertisedJsonSchema = surfaceAdvertised.get(schemaToolName)?.outputSchema;
    const advertisedOutputSchema = advertisedJsonSchema
      ? z.fromJSONSchema(advertisedJsonSchema)
      : flatOutputSchemas.get(schemaToolName);
    assert.ok(
      advertisedOutputSchema,
      `${caseLabel}: ${schemaToolName} has no registered output schema`,
    );

    const first = (await surfaceClient.callTool(call)) as ToolEnvelope;
    const firstProjection = assertWireProjection(
      first,
      advertisedOutputSchema,
      call,
      caseLabel,
    );
    const second = (await surfaceClient.callTool(call)) as ToolEnvelope;
    const secondProjection = assertWireProjection(
      second,
      advertisedOutputSchema,
      call,
      `${caseLabel} repeat`,
    );
    assert.deepEqual(
      secondProjection,
      firstProjection,
      `${wireCase.id}: repeated call changed key or array order`,
    );
    wireCase.assertResult?.(firstProjection, context);
    executedCaseIds.push(wireCase.id);
    projectedByCaseId.set(wireCase.id, firstProjection);
  }

  assert.deepEqual(executedCaseIds, expectedCases.map(({ id }) => id));
  for (const [surfaceId, flatId] of [
    ["gateway-agent-contract", "flat-agent-feedback-query-contract"],
    ["gateway-code-contract", "flat-code-getSkeleton-contract"],
    ["gateway-query-contract", "flat-symbol-search-contract"],
    ["gateway-repo-contract", "flat-repo-status-contract"],
    ["codeMode-symbol-search-contract", "flat-symbol-search-contract"],
    ["workflow-symbol-search-contract", "flat-symbol-search-contract"],
    ["codeMode-symbol-getCard-contract", "flat-symbol-getCard-contract"],
    ["workflow-symbol-getCard-contract", "flat-symbol-getCard-contract"],


    ["codeMode-code-getSkeleton-contract", "flat-code-getSkeleton-contract"],
    ["workflow-code-getSkeleton-contract", "flat-code-getSkeleton-contract"],
    ["codeMode-code-getHotPath-contract", "flat-code-getHotPath-contract"],
    ["workflow-code-getHotPath-contract", "flat-code-getHotPath-contract"],


  ] as const) {
    const surfaceProjection = projectedByCaseId.get(surfaceId);
    const comparableProjection = surfaceId.startsWith("workflow-")
      ? (
          surfaceProjection as
            | { results?: Array<{ result?: unknown }> }
            | undefined
        )?.results?.[0]?.result
      : surfaceProjection;
    assert.deepEqual(
      comparableProjection,
      projectedByCaseId.get(flatId),
      `${surfaceId}: projected result diverged from ${flatId}`,
    );
  }
}
async function connect(server: MCPServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  Object.assign(serverTransport, { sessionId: "output-schema-wire" });
  const client = new Client({
    name: `output-schema-wire-${randomUUID()}`,
    version: "1.0.0",
  });
  await server.getServer().connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("MCP output-schema wire contracts", { concurrency: false }, () => {
  let server: MCPServer;
  let client: Client;
  let flatServer: MCPServer;
  let flatClient: Client;
  let symbolId = "";
  let largeSymbolId = "";
  const previousEnv = {
    config: process.env.SDL_CONFIG,
    graphDb: process.env.SDL_GRAPH_DB_PATH,
    db: process.env.SDL_DB_PATH,
    native: process.env.SDL_MCP_DISABLE_NATIVE_ADDON,
  };

  before(async () => {
    mkdirSync(join(REPO_ROOT, "src"), { recursive: true });
    writeFileSync(
      join(REPO_ROOT, "src", "greeting.ts"),
      GREETING_SOURCE,
      "utf8",
    );
    writeFileSync(
      join(REPO_ROOT, "src", "large-code.ts"),
      LARGE_CODE_SOURCE,
      "utf8",
    );
    writeFileSync(
      join(REPO_ROOT, "notes.txt"),
      "oldName appears in this disposable fixture.\n",
      "utf8",
    );
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          repos: [],
          policy: {
            maxWindowLines: 180,
            maxWindowTokens: 1_400,
            requireIdentifiers: true,
            allowBreakGlass: true,
            defaultDenyRaw: false,
          },
          graphDatabase: { path: DB_PATH },
          indexing: {
            pipeline: "legacy",
            engine: "typescript",
            enableFileWatching: false,
            algorithmRefresh: {
              enabled: false,
              pageRank: { enabled: false },
              kCore: { enabled: false },
              louvain: { enabled: false, maxCallEdges: 0 },
            },
          },
          liveIndex: { enabled: false },
          semantic: { enabled: false, generateSummaries: false },
          semanticEnrichment: {
            enabled: false,
            autoRunOnIndexRefresh: false,
          },
          prefetch: { enabled: false, warmTopN: 0 },
          memory: { enabled: true },
          scip: { enabled: false, generator: { enabled: false } },
          observability: { enabled: false },
          security: { allowedRepoRoots: [REPO_ROOT] },
        },
        null,
        2,
      ),
      "utf8",
    );

    process.env.SDL_CONFIG = CONFIG_PATH;
    process.env.SDL_GRAPH_DB_PATH = DB_PATH;
    process.env.SDL_DB_PATH = DB_PATH;
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    invalidateConfigCache();
    resetSearchEditPlanStore();

    await closeLadybugDb();
    await initLadybugDb(DB_PATH);
    server = await createMCPServer({
      gatewayConfig: { enabled: true, emitLegacyTools: true },
      codeModeConfig: {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 60_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    });
    client = await connect(server);
    await client.listTools();
    flatServer = await createMCPServer();
    flatClient = await connect(flatServer);
    await flatClient.listTools();

    for (const setupCall of [
      {
        name: "sdl.repo.register",
        arguments: {
          repoId: REPO_ID,
          rootPath: REPO_ROOT,
          languages: ["ts"],
          updateExisting: true,
        },
      },
      {
        name: "sdl.index.refresh",
        arguments: { repoId: REPO_ID, mode: "full" },
      },
    ]) {
      const response = (await client.callTool(setupCall)) as ToolEnvelope;
      assert.notEqual(
        response.isError,
        true,
        `${setupCall.name}: ${JSON.stringify(response.structuredContent)}`,
      );
    }

    const search = (await client.callTool({
      name: "sdl.symbol.search",
      arguments: {
        repoId: REPO_ID,
        query: "greet",
        semantic: false,
        wireFormat: "json",
        limit: 5,
      },
    })) as ToolEnvelope;
    assert.notEqual(search.isError, true);
    const results = (
      search.structuredContent as {
        results?: Array<{ symbolId?: string; name?: string }>;
      }
    )?.results;
    symbolId =
      results?.find((result) => result.name === "greet")?.symbolId ?? "";
    assert.ok(symbolId, "expected the indexed greet symbol");
    const largeSearch = (await client.callTool({
      name: "sdl.symbol.search",
      arguments: {
        repoId: REPO_ID,
        query: "widelySeparatedMarkers",
        semantic: false,
        wireFormat: "json",
        limit: 5,
      },
    })) as ToolEnvelope;
    assert.notEqual(largeSearch.isError, true);
    const largeResults = (
      largeSearch.structuredContent as {
        results?: Array<{ symbolId?: string; name?: string }>;
      }
    )?.results;
    largeSymbolId =
      largeResults?.find(
        (result) => result.name === "widelySeparatedMarkers",
      )?.symbolId ?? "";
    assert.ok(largeSymbolId, "expected the indexed large fixture symbol");

  });

  after(async () => {
    await flatClient?.close();
    await client?.close();
    await flatServer?.stop();
    await server?.stop();
    resetSearchEditPlanStore();
    await closeLadybugDb();
    invalidateConfigCache();

    if (previousEnv.config === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousEnv.config;
    if (previousEnv.graphDb === undefined) delete process.env.SDL_GRAPH_DB_PATH;
    else process.env.SDL_GRAPH_DB_PATH = previousEnv.graphDb;
    if (previousEnv.db === undefined) delete process.env.SDL_DB_PATH;
    else process.env.SDL_DB_PATH = previousEnv.db;
    if (previousEnv.native === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousEnv.native;
    }

    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  it("executes every non-mutating public contract case through the wire", async () => {
    const context = await setupWireFixtureContext(client, symbolId);
    await executePublicContractCases(client, flatClient, context);
  });

  it("preserves the optional test-case facet in card schema order", () => {
    const baseCard = {
      symbolId: "sym-test",
      repoId: REPO_ID,
      file: "tests/sample.test.ts",
      range: { startLine: 1, startCol: 0, endLine: 3, endCol: 0 },
      kind: "function",
      name: "keeps sdl.info callable",
      exported: false,
      sideEffects: [],
      deps: { imports: [], calls: [] },
      detailLevel: "full",
      etag: "etag",
      version: { ledgerVersion: "v1", astFingerprint: "fp" },
    };
    const testCase = {
      framework: "node:test",
      title: "keeps sdl.info callable",
      suitePath: ["Code Mode"],
      modifiers: ["only"],
    };
    const withFacet = SymbolGetCardResponseSchema.parse({
      card: { ...baseCard, testCase },
    }) as { card: Record<string, unknown> };
    const withoutFacet = SymbolGetCardResponseSchema.parse({
      card: baseCard,
    }) as { card: Record<string, unknown> };

    assert.deepStrictEqual(withFacet.card.testCase, testCase);
    assert.deepStrictEqual(Object.keys(withFacet.card), [
      "symbolId",
      "repoId",
      "file",
      "range",
      "kind",
      "name",
      "exported",
      "sideEffects",
      "testCase",
      "deps",
      "detailLevel",
      "etag",
      "version",
    ]);
    assert.deepStrictEqual(Object.keys(withoutFacet.card), [
      "symbolId",
      "repoId",
      "file",
      "range",
      "kind",
      "name",
      "exported",
      "sideEffects",
      "deps",
      "detailLevel",
      "etag",
      "version",
    ]);
  });

  const cases: WireCase[] = [
    {
      name: "sdl.context",
      schema: AgentContextOutputSchema,
      successArgs: () => ({
        repoId: REPO_ID,
        taskType: "explain",
        taskText: "Explain greet",
        budget: { maxTokens: 2_048 },
        focusSymbols: [symbolId],
        responseMode: "inline",
        refsMode: "off",
        wireFormat: "json",
      }),
      errorArgs: () => ({
        repoId: REPO_ID,
        taskType: "explain",
        taskText: "Explain greet",
        budget: { maxTokens: 2_048 },
        options: { answerFirst: true },
      }),
      errorTextPattern: /options/u,
    },
    {
      name: "sdl.info",
      schema: InfoResponseSchema,
      successArgs: () => ({ redactPaths: true }),
      errorArgs: () => ({ redactPaths: "yes" }),
      errorTextPattern: /redactPaths/u,
    },
    {
      name: "sdl.repo.overview",
      schema: RepoOverviewResponseSchema,
      successArgs: () => ({ repoId: REPO_ID, level: "full" }),
      errorArgs: () => ({ repoId: REPO_ID, level: "invalid" }),
      errorTextPattern: /level/u,
    },
    {
      name: "sdl.symbol.edit",
      schema: SymbolEditResponseSchema,
      successArgs: () => ({
        mode: "preview",
        repoId: REPO_ID,
        symbolId,
        operation: {
          kind: "replaceBody",
          content: "return `Hi ${name}`;\n",
        },
        createBackup: false,
      }),
      errorArgs: () => ({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: "missing-symbol-edit-plan",
      }),
      errorTextPattern: /planHandle/u,
    },
    {
      name: "sdl.code.needWindow",
      schema: CodeNeedWindowResponseSchema,
      successArgs: () => ({
        repoId: REPO_ID,
        symbolId,
        reason: "Inspect the greeting implementation",
        expectedLines: 4,
        identifiersToFind: ["message"],
        maxTokens: 256,
        refsMode: "off",
        responseMode: "inline",
      }),
      errorArgs: () => ({
        repoId: REPO_ID,
        reason: "Missing target",
        expectedLines: 0,
        identifiersToFind: [],
      }),
      errorTextPattern: /expectedLines|symbolId/u,
    },
    {
      name: "sdl.file.read",
      schema: FileReadResponseSchema,
      successArgs: () => ({
        repoId: REPO_ID,
        filePath: "notes.txt",
        responseMode: "inline",
      }),
      errorArgs: () => ({ repoId: REPO_ID, filePath: "" }),
      errorTextPattern: /filePath/u,
    },
    {
      name: "sdl.file.write",
      schema: FileWriteResponseSchema,
      successArgs: () => ({
        repoId: REPO_ID,
        filePath: "wire-created.txt",
        content: "created by the output-schema wire test\n",
        createIfMissing: true,
        createBackup: false,
      }),
      errorArgs: () => ({
        repoId: REPO_ID,
        filePath: "",
        content: "invalid path",
      }),
      errorTextPattern: /filePath/u,
    },
    {
      name: "sdl.semantic.enrichment.refresh",
      schema: SemanticEnrichmentRefreshResponseSchema,
      successArgs: () => ({ repoId: REPO_ID, dryRun: true }),
      errorArgs: () => ({ repoId: "" }),
      errorTextPattern: /repoId/u,
    },
    {
      name: "sdl.semantic.enrichment.status",
      schema: SemanticEnrichmentStatusResponseSchema,
      successArgs: () => ({ repoId: REPO_ID, detail: "compact" }),
      errorArgs: () => ({ repoId: "", detail: "compact" }),
      errorTextPattern: /repoId/u,
    },
    {
      name: "sdl.search.edit",
      schema: SearchEditResponseSchema,
      successArgs: () => ({
        mode: "preview",
        repoId: REPO_ID,
        targeting: "text",
        query: {
          literal: "oldName",
          replacement: "newName",
        },
        editMode: "replacePattern",
        filters: { extensions: [".txt"] },
        maxFiles: 5,
        createBackup: false,
        responseMode: "inline",
      }),
      errorArgs: () => ({
        mode: "apply",
        repoId: REPO_ID,
        planHandle: "missing-search-edit-plan",
      }),
      errorTextPattern: /planHandle/u,
    },
  ];

  for (const wireCase of cases) {
    it(`${wireCase.name} returns schema-valid success and generic error envelopes`, async () => {
      const wireClient = wireCase.name === "sdl.context" ? client : flatClient;
      const success = (await wireClient.callTool({
        name: wireCase.name,
        arguments: wireCase.successArgs(),
      })) as ToolEnvelope;

      assert.notEqual(
        success.isError,
        true,
        `${wireCase.name}: ${JSON.stringify(success.structuredContent)}`,
      );
      assertConciseText(success, `${wireCase.name} success`);
      wireCase.schema.parse(success.structuredContent);
      if (wireCase.name === "sdl.context") {
        type ProjectedContext = {
          retrieval?: {
            lanes?: Array<{ available?: unknown }>;
          };
          evidence?: Array<Record<string, unknown>>;
          edges?: Array<Record<string, unknown>>;
          sessionDelta?: unknown;
          diagnosticTimings?: unknown;
        };
        const defaultContext = success.structuredContent as ProjectedContext;

        assert.equal(defaultContext.retrieval?.lanes, undefined);
        assert.equal(defaultContext.sessionDelta, undefined);
        assert.equal(defaultContext.diagnosticTimings, undefined);
        const executableNextAction = {
          id: "code.getSkeleton",
          args: { symbolId },
        };
        const parsedWithNextAction = AgentContextOutputSchema.parse({
          ...(success.structuredContent as Record<string, unknown>),
          nextAction: executableNextAction,
        });
        assert.deepStrictEqual(parsedWithNextAction.nextAction, executableNextAction);
        assert.equal(
          AgentContextOutputSchema.safeParse({
            ...(success.structuredContent as Record<string, unknown>),
            unexpectedRootField: true,
          }).success,
          false,
        );
        assert.ok(defaultContext.evidence?.length);
        for (const evidence of defaultContext.evidence) {
          assert.equal(evidence.rank, undefined);
          assert.equal(evidence.tier, undefined);
          assert.equal(evidence.lanes, undefined);
        }
        for (const edge of defaultContext.edges ?? []) {
          assert.equal(edge.confidencePermille, undefined);
        }

        const diagnosticsResponse = (await wireClient.callTool({
          name: wireCase.name,
          arguments: {
            ...wireCase.successArgs(),
            includeDiagnostics: true,
          },
        })) as ToolEnvelope;
        assert.notEqual(
          diagnosticsResponse.isError,
          true,
          responseText(diagnosticsResponse),
        );
        wireCase.schema.parse(diagnosticsResponse.structuredContent);
        const diagnosticsContext =
          diagnosticsResponse.structuredContent as ProjectedContext;
        assert.ok(diagnosticsContext.retrieval?.lanes?.length);
        for (const lane of diagnosticsContext.retrieval.lanes) {
          assert.equal(typeof lane.available, "boolean");
        }
        assert.ok(diagnosticsContext.evidence?.length);
        assert.equal(typeof diagnosticsContext.evidence[0]?.tier, "number");
      }

      const failure = (await wireClient.callTool({
        name: wireCase.name,
        arguments: wireCase.errorArgs(),
      })) as ToolEnvelope;

      assert.equal(failure.isError, true, wireCase.name);
      assertConciseText(failure, `${wireCase.name} error`);
      assert.match(responseText(failure), wireCase.errorTextPattern);
      GenericStructuredErrorSchema.parse(failure.structuredContent);
    });
  }

  it("keeps retrieve code variants schema-valid across inline, auto, and handle delivery", async () => {
    const callRetrieve = async (
      op: "codeSkeleton" | "codeHotPath",
      args: Record<string, unknown>,
      responseMode: "inline" | "auto" | "handle",
    ): Promise<ToolEnvelope> =>
      (await client.callTool({
        name: "sdl.retrieve",
        arguments: { repoId: REPO_ID, op, args, responseMode },
      })) as ToolEnvelope;

    const recoverModelContent = async (
      response: ToolEnvelope,
    ): Promise<unknown> => {
      const artifact = response.structuredContent as
        | { kind?: string; handle?: string }
        | undefined;
      assert.notEqual(response.isError, true, JSON.stringify(response));
      assert.equal(artifact?.kind, "responseArtifact");
      assert.ok(artifact?.handle);
      const recoveryArgs = {
        repoId: REPO_ID,
        handle: artifact.handle,
        view: "model" as const,
        full: true,
      };
      const recover = async (): Promise<ToolEnvelope> =>
        (await client.callTool({
          name: "sdl.response.get",
          arguments: recoveryArgs,
        })) as ToolEnvelope;
      const recovered = await recover();
      const repeated = await recover();
      assert.notEqual(recovered.isError, true, JSON.stringify(recovered));
      assert.notEqual(repeated.isError, true, JSON.stringify(repeated));
      assert.strictEqual(responseText(repeated), responseText(recovered));
      assertNoDefaultVolatility(
        responseText(recovered),
        "fresh response.get text",
        false,
        true,
      );
      assert.ok(recovered.structuredContent);
      assert.ok(repeated.structuredContent);
      const page = recovered.structuredContent as Record<string, unknown> & {
        complete?: boolean;
        content?: unknown;
      };
      const repeatedPage = repeated.structuredContent as Record<
        string,
        unknown
      >;
      assert.deepEqual(Object.keys(repeatedPage), Object.keys(page));
      assert.strictEqual(JSON.stringify(repeatedPage), JSON.stringify(page));
      assert.equal(Object.hasOwn(page, "nextAction"), false);
      assert.equal(Object.hasOwn(page, "nextActions"), false);
      assertNoDefaultVolatility(page, "fresh response.get", false, true);
      assert.equal(page.complete, true);
      return page.content;
    };

    const skeletonArgs = {
      file: "src/large-code.ts",
      maxTokens: 64,
      refsMode: "off",
    };
    const hotPathArgs = {
      symbolId: largeSymbolId,
      identifiersToFind: ["firstMarker", "absentMarker", "lastMarker"],
      contextLines: 1,
      maxTokens: 8,
      refsMode: "off",
    };
    let hotHandle = "";
    let directHotPath: Record<string, unknown> | undefined;

    for (const [label, op, args] of [
      ["skeleton", "codeSkeleton", skeletonArgs],
      ["hot path", "codeHotPath", hotPathArgs],
    ] as const) {
      const handled = await callRetrieve(op, args, "handle");
      const artifact = handled.structuredContent as { handle?: string };
      const recovered = await recoverModelContent(handled);
      assert.equal(
        (recovered as Record<string, unknown>).truncated,
        true,
        label,
      );
      const inline = await callRetrieve(op, args, "inline");
      assert.notEqual(
        inline.isError,
        true,
        label + ": " + responseText(inline),
      );
      assert.deepStrictEqual(inline.structuredContent, recovered, label);
      const automatic = await callRetrieve(op, args, "auto");
      assert.notEqual(
        automatic.isError,
        true,
        label + " auto: " + responseText(automatic),
      );
      const automaticContent =
        (
          automatic.structuredContent as
            | { kind?: string }
            | undefined
        )?.kind === "responseArtifact"
          ? await recoverModelContent(automatic)
          : automatic.structuredContent;
      assert.deepStrictEqual(automaticContent, recovered, label + " auto");
      if (op === "codeHotPath") {
        hotHandle = artifact.handle ?? "";
        directHotPath = inline.structuredContent as Record<string, unknown>;
      }
    }

    assert.ok(directHotPath);
    assert.deepEqual(directHotPath.matchedIdentifiers, ["firstMarker"]);
    assert.deepEqual(directHotPath.missedIdentifiers, [
      "absentMarker",
      "lastMarker",
    ]);
    assert.equal(typeof directHotPath.missedIdentifierHint, "string");
    const directRecovery = directHotPath.nextAction as
      | { action?: string; args?: Record<string, unknown> }
      | undefined;
    assert.equal(directRecovery?.action, "sdl.retrieve");
    assert.ok(directRecovery?.args);
    const directExecution = (await client.callTool({
      name: directRecovery.action,
      arguments: directRecovery.args,
    })) as ToolEnvelope;
    assert.notEqual(
      directExecution.isError,
      true,
      responseText(directExecution),
    );
    assert.doesNotMatch(responseText(directExecution), /repoId.*expected.*string/iu);

    const firstRef = await callRetrieve(
      "codeHotPath",
      { ...hotPathArgs, refsMode: "auto" },
      "inline",
    );
    const secondRef = await callRetrieve(
      "codeHotPath",
      { ...hotPathArgs, refsMode: "auto" },
      "inline",
    );
    assert.notEqual(firstRef.isError, true, responseText(firstRef));
    assert.notEqual(secondRef.isError, true, responseText(secondRef));
    const repeated = secondRef.structuredContent as Record<string, unknown>;
    assert.equal(repeated.unchanged, true);
    assert.equal(typeof repeated.ref, "object");

    assert.ok(hotHandle);
    const workflow = (await client.callTool({
      name: "sdl.workflow",
      arguments: {
        repoId: REPO_ID,
        detail: "compact",
        steps: [
          {
            fn: "responseGet",
            args: { handle: hotHandle, view: "model", full: true },
          },
        ],
      },
    })) as ToolEnvelope;
    assert.notEqual(workflow.isError, true, responseText(workflow));
    const workflowRecovery = (
      workflow.structuredContent as {
        results?: Array<{
          result?: {
            content?: {
              nextAction?: {
                action?: string;
                args?: Record<string, unknown>;
              };
            };
          };
        }>;
      }
    ).results?.[0]?.result?.content?.nextAction;
    assert.equal(workflowRecovery?.action, "sdl.retrieve");
    assert.ok(workflowRecovery?.args);
    const workflowExecution = (await client.callTool({
      name: workflowRecovery.action,
      arguments: workflowRecovery.args,
    })) as ToolEnvelope;
    assert.notEqual(
      workflowExecution.isError,
      true,
      responseText(workflowExecution),
    );
    assert.doesNotMatch(
      responseText(workflowExecution),
      /repoId.*expected.*string/iu,
    );
  });
  it("keeps truncated workflow continuations complete and executable", async () => {
    const completeResult = Array.from({ length: 12 }, (_, index) => ({
      id: index,
      payload: `item-${index}-${"x".repeat(160)}`,
    }));
    const response = (await client.callTool({
      name: "sdl.workflow",
      arguments: {
        repoId: REPO_ID,
        steps: [{
          fn: "dataMap",
          args: {
            input: completeResult,
            fields: { id: "id", payload: "payload" },
          },
          maxResponseTokens: 50,
        }],
      },
    })) as ToolEnvelope;

    assert.notEqual(response.isError, true, responseText(response));
    const step = (
      response.structuredContent as {
        results?: Array<{
          result?: unknown;
          truncatedResponse?: {
            originalTokens?: number;
            keptTokens?: number;
            continuationHandle?: string;
          };
          nextAction?: {
            action?: string;
            args?: Record<string, unknown>;
          };
        }>;
      }
    ).results?.[0];
    assert.ok(step);
    assert.ok(
      JSON.stringify(step.result).length < JSON.stringify(completeResult).length,
      "model result should be a bounded preview",
    );
    assert.ok(step.truncatedResponse?.continuationHandle);
    assert.equal(Object.hasOwn(step.truncatedResponse, "maxTokens"), false);
    assert.ok(
      (step.truncatedResponse.originalTokens ?? 0)
        > (step.truncatedResponse.keptTokens ?? 0),
    );
    assert.equal(step.nextAction?.action, "sdl.workflow");
    assert.ok(step.nextAction.args);
    assert.equal(
      (
        step.nextAction.args.steps as
          | Array<{ fn?: string; args?: Record<string, unknown> }>
          | undefined
      )?.[0]?.fn,
      "workflowContinuationGet",
    );

    const resumed = (await client.callTool({
      name: step.nextAction.action,
      arguments: step.nextAction.args,
    })) as ToolEnvelope;
    assert.notEqual(resumed.isError, true, responseText(resumed));
    const resumedResult = (
      resumed.structuredContent as {
        results?: Array<{
          result?: {
            data?: unknown;
          };
        }>;
      }
    ).results?.[0]?.result;
    assert.deepStrictEqual(
      resumedResult?.data,
      completeResult,
      JSON.stringify(resumed.structuredContent),
    );
  });

  it("returns response.get failures in the generic structured error envelope", async () => {
    const failure = (await client.callTool({
      name: "sdl.response.get",
      arguments: {
        repoId: REPO_ID,
        handle: `response-${REPO_ID}-1784866000000-deadbeefdeadbeef`,
      },
    })) as ToolEnvelope;

    assert.equal(failure.isError, true);
    GenericStructuredErrorSchema.parse(failure.structuredContent);
    assert.match(responseText(failure), /Response artifact not found/u);
  });

  it("marks an invalid indexed fileWrite workflow step as an MCP error", async () => {
    try {
      const response = (await client.callTool({
        name: "sdl.workflow",
        arguments: {
          repoId: REPO_ID,
          steps: [
            {
              fn: "fileWrite",
              args: {
                filePath: "src/greeting.ts",
                content: "export function greet(",
                createBackup: false,
              },
            },
          ],
        },
      })) as ToolEnvelope;
      const results = (
        response.structuredContent as {
          results?: Array<{ status?: string; result?: unknown }>;
        }
      )?.results;

      assert.equal(response.isError, true);
      assert.ok(results?.some((result) => result.status === "error"));
    } finally {
      const restore = (await flatClient.callTool({
        name: "sdl.file.write",
        arguments: {
          repoId: REPO_ID,
          filePath: "src/greeting.ts",
          content: GREETING_SOURCE,
          createBackup: false,
        },
      })) as ToolEnvelope;
      assert.notEqual(restore.isError, true);
    }
  });

  it("marks a stale searchEditApply workflow step as an MCP error", async () => {
    const interveningSource = GREETING_SOURCE.replace("Hello", "Intervening");

    try {
      const response = (await client.callTool({
        name: "sdl.workflow",
        arguments: {
          repoId: REPO_ID,
          detail: "full",
          steps: [
            {
              fn: "searchEdit",
              args: {
                mode: "preview",
                targeting: "text",
                query: { literal: "Hello", replacement: "Hi", global: true },
                filters: { include: ["src/greeting.ts"] },
                editMode: "replacePattern",
                responseMode: "inline",
                createBackup: false,
              },
            },
            {
              fn: "fileWrite",
              args: {
                filePath: "src/greeting.ts",
                content: interveningSource,
                createBackup: false,
              },
            },
            {
              fn: "searchEdit",
              args: { mode: "apply", planHandle: "$0.planHandle" },
            },
          ],
        },
      })) as ToolEnvelope;
      const results = (
        response.structuredContent as {
          results?: Array<{ status?: string; result?: unknown }>;
        }
      )?.results;

      assert.equal(response.isError, true);
      assert.deepEqual(
        results?.map((result) => result.status),
        [undefined, undefined, "error"],
        JSON.stringify(response.structuredContent),
      );
      const applyFailure = results?.[2] as Record<string, unknown> | undefined;
      assert.match(JSON.stringify(applyFailure), /drifted/iu);
      assert.equal(
        readFileSync(join(REPO_ROOT, "src", "greeting.ts"), "utf8"),
        interveningSource,
      );
    } finally {
      const restore = (await flatClient.callTool({
        name: "sdl.file.write",
        arguments: {
          repoId: REPO_ID,
          filePath: "src/greeting.ts",
          content: GREETING_SOURCE,
          createBackup: false,
        },
      })) as ToolEnvelope;
      assert.notEqual(restore.isError, true);
    }
  });

  it("marks a nonzero runtimeExecute workflow step as an MCP error", async () => {
    const response = (await client.callTool({
      name: "sdl.workflow",
      arguments: {
        repoId: REPO_ID,
        steps: [
          {
            fn: "runtimeExecute",
            args: {
              runtime: "node",
              args: ["-e", "process.exit(7)"],
              outputMode: "minimal",
              persistOutput: false,
            },
          },
        ],
      },
    })) as ToolEnvelope;
    const results = (
      response.structuredContent as {
        results?: Array<{ status?: string; result?: unknown }>;
      }
    )?.results;

    assert.equal(response.isError, true);
    assert.ok(results?.some((result) => result.status === "error"));
  });

  it("omits redundant success metadata from runtimeExecute workflow output", async () => {
    const minimal = (await client.callTool({
      name: "sdl.workflow",
      arguments: {
        repoId: REPO_ID,
        steps: [{
          fn: "runtimeExecute",
          args: {
            runtime: "node",
            args: ["-e", "process.stdout.write('minimal-hidden')"],
            outputMode: "minimal",
            persistOutput: false,
          },
        }],
      },
    })) as ToolEnvelope;
    const summary = (await client.callTool({
      name: "sdl.workflow",
      arguments: {
        repoId: REPO_ID,
        steps: [{
          fn: "runtimeExecute",
          args: {
            runtime: "node",
            args: ["-e", "process.stdout.write('summary-visible')"],
            outputMode: "summary",
            persistOutput: false,
          },
        }],
      },
    })) as ToolEnvelope;
    const minimalStep = (
      minimal.structuredContent as { results?: Array<Record<string, unknown>> }
    )?.results?.[0];
    const summaryStep = (
      summary.structuredContent as { results?: Array<Record<string, unknown>> }
    )?.results?.[0];

    assert.notEqual(
      minimal.isError,
      true,
      JSON.stringify(minimal.structuredContent),
    );
    assert.deepEqual(minimalStep, { fn: "runtimeExecute" });
    assert.notEqual(
      summary.isError,
      true,
      JSON.stringify(summary.structuredContent),
    );
    assert.equal(summaryStep?.status, undefined);
    assert.deepEqual(summaryStep?.result, {
      stdoutSummary: "summary-visible",
    });
  });

  it("keeps stable read-only reports schema-valid and recovery-free", async () => {
    const call = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolEnvelope> =>
      (await client.callTool({ name, arguments: args })) as ToolEnvelope;

    for (const detail of ["compact", "standard", "full"] as const) {
      const args = { repoId: REPO_ID, detail };
      const result = assertStableDefaultReport(
        await call("sdl.repo.status", args),
        await call("sdl.repo.status", args),
        RepoStatusResponseSchema,
        "repo.status " + detail,
      );
      assert.equal(result.repoId, REPO_ID);
      assert.equal(Object.hasOwn(result, "diagnostics"), false);
    }

    const diagnosticArgs = {
      repoId: REPO_ID,
      detail: "full",
      includeDiagnostics: true,
    };
    const diagnosticFirst = await call("sdl.repo.status", diagnosticArgs);
    const diagnosticSecond = await call("sdl.repo.status", diagnosticArgs);
    assert.notEqual(diagnosticFirst.isError, true, responseText(diagnosticFirst));
    assert.notEqual(diagnosticSecond.isError, true, responseText(diagnosticSecond));
    const firstDiagnostic = RepoStatusResponseSchema.parse(
      diagnosticFirst.structuredContent,
    ) as Record<string, unknown>;
    const secondDiagnostic = RepoStatusResponseSchema.parse(
      diagnosticSecond.structuredContent,
    ) as Record<string, unknown>;
    const firstDiagnosticText = responseText(diagnosticFirst);
    assert.deepEqual(Object.keys(secondDiagnostic), Object.keys(firstDiagnostic));
    assert.strictEqual(
      JSON.stringify(secondDiagnostic),
      JSON.stringify(firstDiagnostic),
    );
    assert.strictEqual(responseText(diagnosticSecond), firstDiagnosticText);
    assert.equal(Object.hasOwn(firstDiagnostic, "nextAction"), false);
    assertNoDefaultVolatility(
      firstDiagnostic,
      "repo.status diagnostics",
      true,
    );
    assertNoDefaultVolatility(
      firstDiagnosticText,
      "repo.status diagnostics",
      true,
    );

    const feedbackArgs = { repoId: REPO_ID, detail: "full" };
    const feedback = assertStableDefaultReport(
      await call("sdl.agent.feedback.query", feedbackArgs),
      await call("sdl.agent.feedback.query", feedbackArgs),
      AgentFeedbackQueryResponseSchema,
      "empty agent.feedback.query",
    );
    assert.deepEqual(feedback.feedback, []);
    assert.deepEqual(feedback.aggregatedStats, {
      totalFeedback: 0,
      topUsefulSymbols: [],
      topMissingSymbols: [],
    });
    assert.equal(feedback.hasMore, false);

    const bufferArgs = { repoId: REPO_ID, detail: "full" };
    const buffer = assertStableDefaultReport(
      await call("sdl.buffer.status", bufferArgs),
      await call("sdl.buffer.status", bufferArgs),
      BufferStatusResponseSchema,
      "empty buffer.status",
    );
    assert.equal(buffer.pendingBuffers, 0);
  });

  it("round-trips fresh runtime output deterministically without phantom recovery", async () => {
    const executed = (await client.callTool({
      name: "sdl.runtime.execute",
      arguments: {
        repoId: REPO_ID,
        runtime: "node",
        args: ["-e", "process.stdout.write('task5-fresh-output')"],
        outputMode: "minimal",
        persistOutput: true,
        detail: "full",
      },
    })) as ToolEnvelope;
    assert.notEqual(executed.isError, true, responseText(executed));
    const artifactHandle = (
      executed.structuredContent as { artifactHandle?: string }
    ).artifactHandle;
    assert.ok(artifactHandle);

    const queryArgs = {
      repoId: REPO_ID,
      artifactHandle,
      queryTerms: ["task5-fresh-output"],
      contextLines: 0,
      detail: "full",
    };
    const callQuery = async (): Promise<ToolEnvelope> =>
      (await flatClient.callTool({
        name: "sdl.runtime.queryOutput",
        arguments: queryArgs,
      })) as ToolEnvelope;
    const result = assertStableDefaultReport(
      await callQuery(),
      await callQuery(),
      RuntimeQueryOutputResponseSchema.pick({
        artifactHandle: true,
        excerpts: true,
        matchStatus: true,
      }).strict(),
      "fresh runtime.queryOutput",
    );
    assert.match(JSON.stringify(result.excerpts), /task5-fresh-output/u);
  });

  it("returns a same-version delta as a schema-valid deterministic empty success", async () => {
    const status = (await client.callTool({
      name: "sdl.repo.status",
      arguments: { repoId: REPO_ID },
    })) as ToolEnvelope;
    assert.notEqual(status.isError, true, responseText(status));
    const latestVersionId = (
      status.structuredContent as { latestVersionId?: string }
    ).latestVersionId;
    assert.ok(latestVersionId);

    const callDelta = async (): Promise<ToolEnvelope> =>
      (await client.callTool({
        name: "sdl.delta.get",
        arguments: {
          repoId: REPO_ID,
          fromVersion: latestVersionId,
          toVersion: latestVersionId,
          detail: "full",
        },
      })) as ToolEnvelope;

    const first = await callDelta();
    const second = await callDelta();

    assert.notEqual(first.isError, true, responseText(first));
    assert.notEqual(second.isError, true, responseText(second));
    DeltaGetResponseSchema.parse(first.structuredContent);
    assert.strictEqual(
      JSON.stringify(second.structuredContent),
      JSON.stringify(first.structuredContent),
    );
    const result = first.structuredContent as {
      delta?: {
        fromVersion?: string;
        toVersion?: string;
        changedSymbols?: unknown[];
        blastRadius?: unknown[];
      };
      hint?: string;
      nextAction?: unknown;
    };
    assert.equal(result.delta?.fromVersion, latestVersionId);
    assert.equal(result.delta?.toVersion, latestVersionId);
    assert.deepEqual(result.delta?.changedSymbols, []);
    assert.deepEqual(result.delta?.blastRadius, []);
    assert.equal(
      result.hint,
      "Only one ledger version exists — delta is empty. Run index.refresh after making changes to create a new version.",
    );
    assert.equal(result.nextAction, undefined);
  });

  it("keeps symbol-card refsMode off/auto repeat semantics through flat wire", async () => {
    const callCard = async (
      refsMode: "off" | "auto",
      label: string,
    ): Promise<Record<string, unknown>> => {
      const call = {
        name: "sdl.symbol.getCard",
        arguments: {
          repoId: REPO_ID,
          symbolId,
          detail: "full",
          refsMode,
        },
      };
      const response = (await flatClient.callTool(call)) as ToolEnvelope;
      return assertWireProjection(
        response,
        withProjectionSuccessOutputSchema(
          "symbol.getCard",
          SymbolGetCardResponseSchema,
        ),
        call,
        label,
      );
    };

    const firstOff = await callCard("off", "symbol.getCard refs off first");
    const secondOff = await callCard("off", "symbol.getCard refs off repeat");
    assert.deepStrictEqual(secondOff, firstOff);
    const secondOffCard = (
      secondOff as { card?: { ref?: unknown; unchanged?: boolean } }
    ).card;
    assert.ok(secondOffCard);
    assert.equal(secondOffCard.unchanged, undefined);
    assert.equal(secondOffCard.ref, undefined);

    // refsMode:off does not populate the session-ref cache, so the first auto
    // call is the named setup and the second call consumes that exact entry.
    const firstAuto = await callCard("auto", "symbol.getCard refs auto setup");
    const secondAuto = await callCard("auto", "symbol.getCard refs auto repeat");
    const firstAutoCard = (
      firstAuto as { card?: { ref?: unknown; unchanged?: boolean } }
    ).card;
    assert.ok(firstAutoCard);
    assert.equal(firstAutoCard.unchanged, undefined);
    assert.equal(firstAutoCard.ref, undefined);
    const secondAutoCard = (
      secondAuto as {
        card?: {
          ref?: { etag?: string; key?: string };
          unchanged?: boolean;
        };
      }
    ).card;
    assert.equal(secondAutoCard?.unchanged, true);
    assert.equal(secondAutoCard?.ref?.key, `card:${REPO_ID}:${symbolId}`);
    assert.equal(typeof secondAutoCard?.ref?.etag, "string");
  });

  it("round-trips ifNoneMatch through the flat symbol-card wire", async () => {
    // Normal model projections hide ETags, so seed the conditional request from
    // the canonical handler result and validate only the real wire response.
    const canonical = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolId,
      detail: "full",
      refsMode: "off",
    });
    const canonicalCard = (
      canonical as {
        card?: {
          etag?: string;
          version?: { ledgerVersion?: string };
        };
      }
    ).card;
    const etag = canonicalCard?.etag;
    const ledgerVersion = canonicalCard?.version?.ledgerVersion;
    assert.ok(etag);
    assert.ok(ledgerVersion);

    const conditionalCall = {
      name: "sdl.symbol.getCard",
      arguments: {
        repoId: REPO_ID,
        symbolId,
        detail: "full",
        refsMode: "off",
        ifNoneMatch: etag,
      },
    };
    const conditional = (await flatClient.callTool(
      conditionalCall,
    )) as ToolEnvelope;
    const projected = assertWireProjection(
      conditional,
      withProjectionSuccessOutputSchema(
        "symbol.getCard",
        SymbolGetCardResponseSchema,
      ),
      conditionalCall,
      "symbol.getCard conditional response",
    );
    assert.deepStrictEqual(projected, {
      notModified: true,
      etag,
      ledgerVersion,
    });
  });

  it("preserves symbol-search model equality across json, packed, and auto fallback", async () => {
    const callSearch = async (
      wireFormat: "json" | "packed" | "auto",
    ): Promise<ToolEnvelope> =>
      (await flatClient.callTool({
        name: "sdl.symbol.search",
        arguments: {
          repoId: REPO_ID,
          query: "no-such-symbol-wire-format-crosscut",
          semantic: false,
          limit: 1,
          wireFormat,
        },
      })) as ToolEnvelope;

    const json = await callSearch("json");
    const packed = await callSearch("packed");
    const automatic = await callSearch("auto");
    for (const response of [json, packed, automatic]) {
      assert.notEqual(response.isError, true, responseText(response));
    }

    const jsonModel = json.structuredContent as Record<string, unknown>;
    assert.deepStrictEqual(packed.structuredContent, jsonModel);
    assert.deepStrictEqual(automatic.structuredContent, jsonModel);
    assert.strictEqual(responseText(packed), responseText(json));
    assert.strictEqual(responseText(automatic), responseText(json));
    assert.ok(
      Array.isArray(
        (automatic.structuredContent as { results?: unknown }).results,
      ),
      "small auto response should fall back to JSON",
    );
  });

  it("keeps workflow controls executable through the SDK wire", async () => {
    const callWorkflow = async (
      options: Record<string, unknown>,
    ): Promise<ToolEnvelope> =>
      (await client.callTool({
        name: "sdl.workflow",
        arguments: { repoId: REPO_ID, ...options },
      })) as ToolEnvelope;
    const successfulSteps = [
      {
        fn: "dataPick",
        args: { input: { value: "first" }, fields: { value: "value" } },
      },
      {
        fn: "dataPick",
        args: { input: { value: "final" }, fields: { value: "value" } },
      },
    ];

    const onlyFinal = await callWorkflow({
      steps: successfulSteps,
      onlyFinalResult: true,
    });
    assert.notEqual(onlyFinal.isError, true, responseText(onlyFinal));
    const finalResults = (
      onlyFinal.structuredContent as {
        results?: Array<{ stepIndex?: number; result?: unknown }>;
      }
    ).results;
    assert.equal(finalResults?.length, 1);
    assert.deepEqual(finalResults?.[0]?.result, { value: "final" });

    const dryRun = await callWorkflow({
      steps: successfulSteps,
      dryRun: true,
    });
    assert.notEqual(dryRun.isError, true, responseText(dryRun));
    const dryRunResult = dryRun.structuredContent as {
      results?: Array<{ status?: string }>;
      dryRun?: { valid?: boolean; stepCount?: number };
    };
    assert.equal(dryRunResult.dryRun?.valid, true);
    assert.equal(dryRunResult.dryRun?.stepCount, 2);
    assert.deepEqual(
      dryRunResult.results?.map(({ status }) => status),
      ["skipped", "skipped"],
    );

    const failingSteps = [
      {
        fn: "dataMap",
        args: { input: { value: "not-an-array" }, fields: { value: "value" } },
      },
      {
        fn: "dataPick",
        args: { input: { value: "independent" }, fields: { value: "value" } },
      },
      {
        fn: "dataPick",
        args: { input: "$0", fields: { value: "value" } },
      },
    ];
    for (const [onError, expectedStatuses] of [
      ["stop", ["error", "skipped", "skipped"]],
      ["continue", ["error", undefined, "skipped"]],
      ["continueAll", ["error", undefined, "error"]],
    ] as const) {
      const response = await callWorkflow({ steps: failingSteps, onError });
      assert.equal(response.isError, true, onError);
      const results = (
        response.structuredContent as {
          results?: Array<{ status?: string }>;
        }
      ).results;
      assert.deepEqual(
        results?.map(({ status }) => status),
        expectedStatuses,
        onError,
      );
    }
  });

  it("returns the exact static no-op checkpoint payload through the SDK wire", async () => {
    const expected = {
      repoId: REPO_ID,
      requested: false,
      pending: false,
      message: "No checkpoint-eligible buffers were pending.",
    };
    await client.listTools();

    const first = (await client.callTool({
      name: "sdl.buffer.checkpoint",
      arguments: { repoId: REPO_ID, reason: "wire-regression" },
    })) as ToolEnvelope;
    const second = (await client.callTool({
      name: "sdl.buffer.checkpoint",
      arguments: { repoId: REPO_ID, reason: "wire-regression" },
    })) as ToolEnvelope;

    assert.notEqual(first.isError, true);
    assert.notEqual(second.isError, true);
    assert.strictEqual(
      JSON.stringify(first.structuredContent),
      JSON.stringify(second.structuredContent),
    );
    assert.deepStrictEqual(first.structuredContent, expected);
    assert.deepStrictEqual(second.structuredContent, expected);
    BufferCheckpointResponseSchema.parse(first.structuredContent);
  });
});
