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
import {
  closeLadybugDb,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import { resetSearchEditPlanStore } from "../../dist/mcp/tools/search-edit/plan-store.js";
import {
  AgentContextOutputSchema,
  BufferCheckpointResponseSchema,
  CodeNeedWindowResponseSchema,
  FileReadResponseSchema,
  FileWriteResponseSchema,
  InfoResponseSchema,
  RepoOverviewResponseSchema,
  SearchEditResponseSchema,
  SemanticEnrichmentRefreshResponseSchema,
  SemanticEnrichmentStatusResponseSchema,
  SymbolEditResponseSchema,
  SymbolGetCardResponseSchema,
} from "../../dist/mcp/tools.js";
import {
  createMCPServer,
  type MCPServer,
} from "../../dist/server.js";

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
          memory: { enabled: false },
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
      gatewayConfig: { enabled: false, emitLegacyTools: true },
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
    await client?.close();
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
      const success = (await client.callTool({
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

        const diagnosticsResponse = (await client.callTool({
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

      const failure = (await client.callTool({
        name: wireCase.name,
        arguments: wireCase.errorArgs(),
      })) as ToolEnvelope;

      assert.equal(failure.isError, true, wireCase.name);
      assertConciseText(failure, `${wireCase.name} error`);
      assert.match(responseText(failure), wireCase.errorTextPattern);
      GenericStructuredErrorSchema.parse(failure.structuredContent);
    });
  }

  it("keeps retrieve code variants schema-valid across inline and handle delivery", async () => {
    const callRetrieve = async (
      op: "codeSkeleton" | "codeHotPath",
      args: Record<string, unknown>,
      responseMode: "inline" | "handle",
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
      const recovered = (await client.callTool({
        name: "sdl.response.get",
        arguments: {
          repoId: REPO_ID,
          handle: artifact.handle,
          view: "model",
          full: true,
        },
      })) as ToolEnvelope;
      assert.notEqual(recovered.isError, true, JSON.stringify(recovered));
      const page = recovered.structuredContent as {
        complete?: boolean;
        content?: unknown;
      };
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
      const restore = (await client.callTool({
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
      const restore = (await client.callTool({
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
