/**
 * Prompt-cache hygiene enforcement for SDL-MCP.
 *
 * Prompt caching is byte-exact: unstable tool definitions, unordered query
 * results, timestamps, and machine paths silently destroy cache hits. This
 * process-level test checks the high-leverage surfaces against a frozen
 * polyglot fixture repo.
 */


import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { registerCodeModeTools } from "../../dist/code-mode/index.js";
import { getContinuation } from "../../dist/code-mode/workflow-truncation.js";
import { SHUTDOWN_FORCE_EXIT_TIMEOUT_MS } from "../../dist/config/constants.js";
import { closeLadybugDb, initLadybugDb } from "../../dist/db/ladybug.js";
import type { CodeModeConfig } from "../../dist/config/types.js";
import {
  projectToolResultForModelContent,
  projectWorkflowChildResultForModel,
} from "../../dist/mcp/context-response-projection.js";
import { sessionContentLedger } from "../../dist/mcp/session-dedupe.js";
import { SDL_MCP_SERVER_INSTRUCTIONS } from "../../dist/mcp/server-instructions.js";
import { handleAgentContext } from "../../dist/mcp/tools/context.js";
import { handleSymbolGetCard } from "../../dist/mcp/tools/symbol.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import {
  buildToolResponseEnvelope,
  type MCPServer,
  type ToolContext,
} from "../../dist/server.js";
import { WORKFLOW_CHILD_ACTION_BINDINGS } from "../../dist/mcp/response-projection/registry.js";
import {
  DeltaGetResponseSchema,
  IndexRefreshResponseSchema,
  RepoOverviewResponseSchema,
  RepoRegisterResponseSchema,
  SliceBuildResponseSchema,
  SliceRefreshResponseSchema,
} from "../../dist/mcp/tools.js";
import { z } from "zod";
import { type ChildProcess, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  cpSync,
  readFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import fixtures from "./determinism.fixtures.json" with { type: "json" };
import {
  AGENT_OUTPUT_CASES,
} from "../fixtures/response-projection/agent-output-cases.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ID = fixtures.repoId;
const SOURCE_FIXTURE_REPO = resolve(__dirname, fixtures.fixtureRepo);
const TEST_ROOT = mkdtempSync(join(tmpdir(), "sdl-determinism-"));
const FIXTURE_REPO = join(TEST_ROOT, "fixture-repo");
const GRAPH_DB_PATH = join(TEST_ROOT, "graph.lbug");
const CONFIG_PATH = join(TEST_ROOT, "sdl-determinism.config.json");
const DIFF_DIR = resolve(process.cwd(), ".determinism-diffs");
const GRAPH_DB_FAMILY_PATHS = [
  GRAPH_DB_PATH,
  `${GRAPH_DB_PATH}.sdl-lineage.json`,
] as const;

function removeGraphDbFamily(): void {
  for (const path of GRAPH_DB_FAMILY_PATHS) {
    rmSync(path, { recursive: true, force: true });
  }
}

const PublicRepoOverviewFullResponseSchema = RepoOverviewResponseSchema.options[0]
  .pick({
    repoId: true,
    stats: true,
    directories: true,
    clusters: true,
    layers: true,
  })
  .strict();

interface ServerHandle {
  client: Client;
  close: () => Promise<void>;
}

interface FixtureSetupResults {
  registrationChanged: unknown;
  registrationIdempotent: unknown;
  indexRefresh: unknown;
}

interface FixtureToolCall {
  tool: string;
  args: unknown;
  expectError?: boolean;
  expectedErrorCode?: string;
}

interface Leg {
  toolsCanonical: string;
  results: Map<string, string[]>;
  setupResults?: FixtureSetupResults;
}

interface VolatileFinding {
  fatal: boolean;
  message: string;
}

function writeConfig(): void {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        repos: [],
        policy: {},
        graphDatabase: { path: GRAPH_DB_PATH },
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
        semanticEnrichment: { enabled: false, autoRunOnIndexRefresh: false },
        prefetch: { enabled: false, warmTopN: 0 },
        tracing: { enabled: false },
        gateway: { enabled: false, emitLegacyTools: true },
        codeMode: { enabled: true, exclusive: false },
        memory: { enabled: false },
        scip: { enabled: false, generator: { enabled: false } },
        observability: { enabled: false },
        security: { allowedRepoRoots: [FIXTURE_REPO] },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function ensureBuiltServer(): void {
  if (existsSync(resolve(process.cwd(), "dist/main.js"))) {
    return;
  }

  const result = spawnSync("npm", ["run", "build:runtime"], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });

  assert.equal(result.status, 0, "dist/main.js missing and build:runtime failed");
}

async function spawnServer(): Promise<ServerHandle> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/main.js"],
    env: {
      ...process.env,
      SDL_CONFIG: CONFIG_PATH,
      SDL_GRAPH_DB_PATH: GRAPH_DB_PATH,
      SDL_DB_PATH: GRAPH_DB_PATH,
      SDL_LOG_LEVEL: "error",
      SDL_MCP_DISABLE_NATIVE_ADDON: "1",
      TZ: "UTC",
      LC_ALL: "C",
      NO_COLOR: "1",
    },
  });

  const client = new Client({
    name: "sdl-mcp-determinism",
    version: "1.0.0",
  });
  await client.connect(transport);

  return {
    client,
    close: async () => {
      const child = (
        transport as unknown as { _process?: ChildProcess }
      )._process;
      if (!child) {
        await client.close();
        return;
      }

      // The SDK force-terminates after two seconds, but SDL-MCP reserves up to
      // 60 seconds for database checkpointing and its remaining cleanup.
      const closed = once(child, "close", {
        signal: AbortSignal.timeout(SHUTDOWN_FORCE_EXIT_TIMEOUT_MS + 5_000),
      });
      child.stdin?.end();
      try {
        await closed;
      } finally {
        await client.close();
      }
    },
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function callKey(tool: string, args: unknown, ordinal: number): string {
  return `${tool}#${ordinal}:${sha256(canonical(args)).slice(0, 12)}`;
}

function materializeArgs(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll("{REPO_ID}", REPO_ID)
      .replaceAll("{FIXTURE_REPO}", FIXTURE_REPO);
  }
  if (Array.isArray(value)) {
    return value.map(materializeArgs);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, materializeArgs(entry)]),
    );
  }
  return value;
}

async function callToolStrict(
  client: Client,
  name: string,
  args: unknown,
  expectError = false,
  expectedErrorCode?: string,
): Promise<unknown> {
  let response: Awaited<ReturnType<Client["callTool"]>>;
  try {
    response = await client.callTool({
      name,
      arguments: args as Record<string, unknown>,
    });
  } catch (error) {
    assert.fail(`${name} MCP call rejected: ${String(error)}`);
  }
  const structuredContent = (
    response as {
      structuredContent?: {
        isError?: boolean;
        error?: { code?: unknown };
      };
    }
  ).structuredContent;
  const isError =
    (response as { isError?: boolean }).isError === true
    || structuredContent?.isError === true;
  if (isError !== expectError) {
    assert.fail(
      `${name} ${expectError ? "did not return the expected error" : "failed"}: ${canonical(response)}`,
    );
  }
  if (expectError && expectedErrorCode !== undefined) {
    assert.equal(structuredContent?.error?.code, expectedErrorCode);
  }
  return response;
}
function parseStructuredContent<T>(
  schema: z.ZodType<T>,
  response: unknown,
): T {
  const structuredContent = (response as { structuredContent?: unknown })
    .structuredContent;
  assert.ok(
    structuredContent &&
      typeof structuredContent === "object" &&
      !Array.isArray(structuredContent),
    "public tool response must include object structuredContent",
  );
  const parsed = schema.parse(structuredContent);
  assert.deepStrictEqual(parsed, structuredContent);
  return parsed;
}

async function setupFixtureRepo(client: Client): Promise<FixtureSetupResults> {
  const registrationArgs = {
    repoId: REPO_ID,
    rootPath: FIXTURE_REPO,
    updateExisting: true,
    languages: ["ts", "tsx", "js", "jsx", "py", "go", "java", "cs", "c", "cpp", "rs", "kt", "php", "sh"],
    maxFileBytes: 2_000_000,
  };
  const registrationChanged = await callToolStrict(client, "sdl.repo.register", registrationArgs);
  const registrationIdempotent = await callToolStrict(
    client,
    "sdl.repo.register",
    registrationArgs,
  );

  const indexRefresh = await callToolStrict(client, "sdl.index.refresh", {
    repoId: REPO_ID,
    mode: "full",
  });

  return { registrationChanged, registrationIdempotent, indexRefresh };
}

async function runLeg(repeats: number, options: { setup: boolean }): Promise<Leg> {
  const server = await spawnServer();
  try {
    const setupResults = options.setup
      ? await setupFixtureRepo(server.client)
      : undefined;

    const tools = await server.client.listTools();
    const workflowInstructionIndexes = tools.tools.flatMap(
      (tool, index) =>
        tool.description
          ?.split(SDL_MCP_SERVER_INSTRUCTIONS)
          .slice(1)
          .map(() => index) ?? [],
    );
    assert.equal(
      workflowInstructionIndexes.length,
      fixtures.toolCatalogExpectations.workflowInstructionCopies,
    );
    assert.equal(
      workflowInstructionIndexes[0],
      fixtures.toolCatalogExpectations.workflowInstructionToolIndex,
    );
    const results = new Map<string, string[]>();

    for (const [ordinal, call] of (fixtures.toolCalls as FixtureToolCall[]).entries()) {
      const args = materializeArgs(call.args);
      const key = callKey(call.tool, args, ordinal);
      const runs: string[] = [];
      const argsObject =
        args !== null && typeof args === "object" && !Array.isArray(args)
          ? args as Record<string, unknown>
          : undefined;
      for (let i = 0; i < repeats; i++) {
        const response = await callToolStrict(
          server.client,
          call.tool,
          args,
          call.expectError,
          call.expectedErrorCode,
        );
        if (
          call.tool === "sdl.action.search"
          && argsObject?.query === "*"
          && argsObject.detail === "full"
          && argsObject.maxTokens === 2000
          && argsObject.includeSchemas === true
          && argsObject.includeExamples === true
          && argsObject.limit === 50
          && argsObject.offset === 0
        ) {
          assert.ok(
            response !== null && typeof response === "object" && !Array.isArray(response),
            "broad action search must return an object response",
          );
          const responseObject = response as Record<string, unknown>;
          const structuredContent = responseObject.structuredContent;
          assert.ok(
            structuredContent !== null
              && typeof structuredContent === "object"
              && !Array.isArray(structuredContent),
            "broad action search must return object structuredContent",
          );
          const payload = structuredContent as Record<string, unknown>;
          const actions = payload.actions;
          assert.ok(Array.isArray(actions), "broad action search must return an actions array");
          const responseLimit = payload.limit;
          assert.ok(typeof responseLimit === "number", "broad action search limit must be numeric");
          assert.ok(
            actions.length < responseLimit,
            "broad action search must truncate actions below its response limit",
          );
          assert.equal(payload.hasMore, true, "broad action search must exercise paging");
          const responseOffset = payload.offset;
          assert.ok(typeof responseOffset === "number", "broad action search offset must be numeric");
          assert.equal(payload.nextOffset, responseOffset + actions.length);
        }
        runs.push(canonical(response));
      }
      results.set(key, runs);
    }

    return { toolsCanonical: canonical(tools), results, setupResults };
  } finally {
    await server.close();
  }
}

function reportMismatch(label: string, a: string, b: string): string {
  mkdirSync(DIFF_DIR, { recursive: true });
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, "_");
  writeFileSync(resolve(DIFF_DIR, `${safe}.a.json`), a);
  writeFileSync(resolve(DIFF_DIR, `${safe}.b.json`), b);

  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }

  const context = (text: string) => text.slice(Math.max(0, i - 60), i + 60);
  return [
    `${label}: outputs diverge at char ${i}`,
    `  A: ...${context(a)}...`,
    `  B: ...${context(b)}...`,
    `  Full payloads written to ${DIFF_DIR}/${safe}.{a,b}.json`,
  ].join("\n");
}

function normalizePathForCompare(pathText: string): string {
  return pathText.replaceAll("\\\\", "\\").replaceAll("\\", "/");
}

function scanVolatile(label: string, payload: string): VolatileFinding[] {
  const findings: VolatileFinding[] = [];
  const isoToday = new Date().toISOString().slice(0, 10);

  if (payload.includes(isoToday)) {
    findings.push({
      fatal: true,
      message: `${label}: output contains today's date (${isoToday})`,
    });
  }

  const fixturePrefix = normalizePathForCompare(FIXTURE_REPO);
  const absolutePathPattern =
    /(?:\/home\/[^\s"']+|\/Users\/[^\s"']+|\/tmp\/[^\s"']+|[A-Z]:\\\\[^\s"']+)/g;
  for (const match of payload.matchAll(absolutePathPattern)) {
    const normalized = normalizePathForCompare(match[0]);
    if (!normalized.startsWith(fixturePrefix)) {
      findings.push({
        fatal: true,
        message: `${label}: machine-specific absolute path in output: ${match[0].slice(0, 120)}`,
      });
    }
  }

  const softPatterns: Array<[RegExp, string]> = [
    [/\b(?:took|elapsed|duration)\b[^,}\]]{0,24}\d/i, "possible timing metadata"],
    [/\b\d{10,13}\b/, "possible epoch timestamp"],
    [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "ISO 8601 datetime"],
  ];
  for (const [pattern, description] of softPatterns) {
    const match = payload.match(pattern);
    if (match) {
      findings.push({
        fatal: false,
        message: `${label}: ${description}: "${match[0].slice(0, 80)}"`,
      });
    }
  }

  return findings;
}

let legA: Leg;
let legB: Leg;

before(async () => {
  ensureBuiltServer();
  cpSync(SOURCE_FIXTURE_REPO, FIXTURE_REPO, { recursive: true });
  const contractTestDir = join(FIXTURE_REPO, "tests", "unit");
  mkdirSync(contractTestDir, { recursive: true });
  cpSync(
    resolve(__dirname, "../unit/code-mode-tool-validation.test.ts"),
    join(contractTestDir, "code-mode-tool-validation.test.ts"),
  );
  writeConfig();
  rmSync(DIFF_DIR, { recursive: true, force: true });
  removeGraphDbFamily();

  legA = await runLeg(2, { setup: true });

  if (process.env.REBUILD_INDEX === "1") {
    removeGraphDbFamily();
  }

  legB = await runLeg(1, { setup: process.env.REBUILD_INDEX === "1" });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

test("PROJECTION MATRIX: all compact/full fixtures are stable across process and unchanged index", () => {
  const projectionCases = fixtures.projectionCases as Array<{
    action: string;
    detail: string;
    includeDiagnostics: boolean;
  }>;
  const diagnosticAllowlist =
    fixtures.projectionDiagnosticVolatilityAllowlist as Array<{
      action: string;
      reason: string;
    }>;

  for (const fixture of AGENT_OUTPUT_CASES) {
    const declared = projectionCases
      .filter(({ action }) => action === fixture.action)
      .map(({ detail, includeDiagnostics }) => [detail, includeDiagnostics])
      .sort();
    assert.deepEqual(
      declared,
      [["compact", false], ["full", false]],
      fixture.action,
    );
  }

  const cases = projectionCases.map((entry) => {
    const fixture = AGENT_OUTPUT_CASES.find(({ action }) => action === entry.action);
    assert.ok(fixture, entry.action);
    return {
      entry,
      args: {
        ...fixture.publicRequest,
        detail: entry.detail,
        includeDiagnostics: entry.includeDiagnostics,
      },
      canonicalResult: fixture.canonicalResultFactory(),
    };
  });
  const serialize = () =>
    cases.map(({ entry, args, canonicalResult }) =>
      JSON.stringify(
        buildToolResponseEnvelope(
          canonicalResult,
          null,
          "",
          `sdl.${entry.action}`,
          args,
        ),
      ),
    );
  const baseline = serialize();
  assert.deepEqual(serialize(), baseline, "same-process repeated envelopes");

  for (const [index, fixtureCase] of cases.entries()) {
    const projected = projectToolResultForModelContent(
      fixtureCase.entry.action,
      fixtureCase.canonicalResult,
      fixtureCase.args,
    );
    const envelope = JSON.parse(baseline[index]) as { structuredContent?: unknown };
    const envelopeValue =
      projected !== null && typeof projected === "object" && !Array.isArray(projected)
        ? envelope.structuredContent
        : (envelope.structuredContent as { value?: unknown } | undefined)?.value;
    assert.deepEqual(envelopeValue, projected, fixtureCase.entry.action);

    const binding = Object.entries(WORKFLOW_CHILD_ACTION_BINDINGS).find(
      ([, candidate]) => candidate.action === fixtureCase.entry.action,
    );
    if (binding) {
      assert.deepEqual(
        projectWorkflowChildResultForModel(
          binding[0],
          fixtureCase.canonicalResult,
          fixtureCase.args,
        ),
        projected,
        `${fixtureCase.entry.action} workflow child routing`,
      );
    }
  }

  const childSource = [
    'import { buildToolResponseEnvelope } from "./dist/server.js";',
    'let source = "";',
    'for await (const chunk of process.stdin) source += chunk;',
    'const cases = JSON.parse(source);',
    'const values = cases.map(({ action, canonicalResult, args }) =>',
    '  JSON.stringify(buildToolResponseEnvelope(canonicalResult, null, "", "sdl." + action, args)),',
    ');',
    'await new Promise((resolve) => process.stdout.write(JSON.stringify(values), resolve));',
    'process.exit(0);',
  ].join("\n");
  const fresh = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", childSource],
    {
      cwd: process.cwd(),
      input: JSON.stringify(
        cases.map(({ entry, args, canonicalResult }) => ({
          action: entry.action,
          args,
          canonicalResult,
        })),
      ),
      encoding: "utf8",
      timeout: 30_000,
      env: process.env,
    },
  );
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(
    JSON.parse(fresh.stdout) as string[],
    baseline,
    "fresh-process envelopes",
  );

  let statusProofs = 0;
  for (const [ordinal, call] of (fixtures.toolCalls as FixtureToolCall[]).entries()) {
    if (call.tool !== "sdl.repo.status") continue;
    const args = materializeArgs(call.args);
    const key = callKey(call.tool, args, ordinal);
    assert.equal(legB.results.get(key)?.[0], legA.results.get(key)?.[0], key);
    statusProofs += 1;
  }
  assert.ok(statusProofs >= 2, "compact/full unchanged-index repo.status proof");
  assert.deepEqual(serialize(), baseline, "unchanged-index fixture envelopes");

  for (const entry of diagnosticAllowlist) {
    assert.ok(entry.reason.trim().length > 0, entry.action);
  }
});

test("INVARIANT 1: tool surface is byte-stable across processes", () => {
  if (legA.toolsCanonical !== legB.toolsCanonical) {
    assert.fail(reportMismatch("tools-list", legA.toolsCanonical, legB.toolsCanonical));
  }
});

test("INVARIANT 2a: every exposed tool has live handler determinism coverage or a named exclusion", () => {
  const exposed: string[] = JSON.parse(legA.toolsCanonical).tools.map(
    (tool: { name: string }) => tool.name,
  );
  const liveCovered = new Set(
    fixtures.toolCalls.map((call) => call.tool),
  );
  const exclusions = fixtures.handlerDeterminismExclusions as Record<
    string,
    string
  >;

  for (const [tool, reason] of Object.entries(exclusions)) {
    assert.ok(exposed.includes(tool), `excluded tool is not exposed: ${tool}`);
    assert.ok(reason.trim().length > 0, `missing exclusion reason: ${tool}`);
    assert.equal(
      liveCovered.has(tool),
      false,
      `live-covered tool must not be excluded: ${tool}`,
    );
  }

  const missing = exposed.filter(
    (tool) => !liveCovered.has(tool) && !Object.hasOwn(exclusions, tool),
  );
  assert.deepEqual(
    missing,
    [],
    `Tools with no live handler determinism fixture or named exclusion: ${missing.join(", ")}`,
  );
});

test("BYTE-STABILITY SCOPE: ref-compacting context calls disable session refs", () => {
  const refCompactingTools = new Set([
    "sdl.context",
    "sdl.symbol.getCard",
    "sdl.code.getSkeleton",
    "sdl.code.getHotPath",
    "sdl.code.needWindow",
  ]);
  const contextCalls = fixtures.toolCalls.filter((call) => refCompactingTools.has(call.tool));
  assert.ok(contextCalls.length > 0);

  for (const call of contextCalls) {
    const args = call.args as Record<string, unknown>;
    assert.equal(args.refsMode, "off", `${call.tool} must opt out of session refs`);
  }
});

test("SEMANTIC TEST CASE: persisted card retains the exact contract title", () => {
  const title =
    "keeps sdl.info callable and discoverable in exclusive Code Mode";
  const ordinal = fixtures.toolCalls.findIndex(
    (call) =>
      call.tool === "sdl.symbol.getCard" &&
      (call.args as { symbolRef?: { name?: string } }).symbolRef?.name === title,
  );
  assert.notEqual(ordinal, -1);
  const call = fixtures.toolCalls[ordinal];
  assert.ok(call);
  const args = materializeArgs(call.args);
  const serialized = legA.results.get(callKey(call.tool, args, ordinal))?.[0];
  assert.ok(serialized);
  const response = JSON.parse(serialized) as {
    structuredContent?: { card?: { testCase?: { title?: string } } };
  };
  assert.equal(response.structuredContent?.card?.testCase?.title, title);
});

test("SESSION BOUNDARY: refsMode auto may compact repeated evidence", async () => {
  const previousConfig = process.env.SDL_CONFIG;
  const previousConfigPath = process.env.SDL_CONFIG_PATH;
  process.env.SDL_CONFIG = CONFIG_PATH;
  process.env.SDL_CONFIG_PATH = CONFIG_PATH;
  try {
    await initLadybugDb(GRAPH_DB_PATH);
    const args = {
      repoId: REPO_ID,
      refsMode: "auto" as const,
      symbolRef: { name: "UserRepository", file: "src/typescript/models.ts" },
    };
    const context: ToolContext = {
      sessionId: `determinism-auto-refs-${process.pid}`,
      signal: new AbortController().signal,
      sendNotification: async () => undefined,
    };
    const first = await handleSymbolGetCard(args, context);
    const second = await handleSymbolGetCard(args, context);
    assert.ok("card" in first);
    assert.ok("card" in second);
    const fullCard = first.card as Record<string, unknown>;
    assert.equal(typeof fullCard.symbolId, "string");
    assert.equal(typeof fullCard.etag, "string");
    assert.ok(!("unchanged" in fullCard));
    assert.deepEqual(second.card, {
      ref: {
        key: `card:${REPO_ID}:${fullCard.symbolId}`,
        etag: fullCard.etag,
      },
      unchanged: true,
    });
  } finally {
    try {
      await closeLadybugDb();
    } finally {
      if (previousConfig === undefined) delete process.env.SDL_CONFIG;
      else process.env.SDL_CONFIG = previousConfig;
      if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
      else process.env.SDL_CONFIG_PATH = previousConfigPath;
    }
  }
});

test("SESSION BOUNDARY: context refs preserve identity across a no-op re-index", async () => {
  const previousConfig = process.env.SDL_CONFIG;
  const previousConfigPath = process.env.SDL_CONFIG_PATH;
  const sessionId = `determinism-context-refs-${process.pid}`;
  process.env.SDL_CONFIG = CONFIG_PATH;
  process.env.SDL_CONFIG_PATH = CONFIG_PATH;
  try {
    await initLadybugDb(GRAPH_DB_PATH);
    const args = {
      repoId: REPO_ID,
      taskType: "explain" as const,
      taskText: "Explain UserRepository findById behavior",
      budget: { maxTokens: 2_048 },
      focusSymbols: ["UserRepository", "findById"],
      refsMode: "auto" as const,
      responseMode: "inline" as const,
      wireFormat: "json" as const,
    };
    const context: ToolContext = {
      sessionId,
      signal: new AbortController().signal,
      sendNotification: async () => undefined,
    };
    const first = (await handleAgentContext(args, context)) as Record<
      string,
      unknown
    >;
    const second = (await handleAgentContext(args, context)) as Record<
      string,
      unknown
    >;
    const firstCards = (first.evidence as Array<Record<string, unknown>>).filter(
      (item) => item.rung === "card",
    );
    const secondCards = (
      second.evidence as Array<Record<string, unknown>>
    ).filter((item) => item.rung === "card");
    assert.ok(firstCards.length > 0);
    assert.deepStrictEqual(
      secondCards.map(({ content: _content, ref: _ref, unchanged: _unchanged, ...item }) => item),
      firstCards.map(({ content: _content, ref: _ref, unchanged: _unchanged, ...item }) => item),
    );
    assert.ok(secondCards.every((item) => item.unchanged === true && item.ref));
    assert.equal(second.etag, first.etag);

    const refresh = await indexRepo(REPO_ID, "incremental");
    assert.equal(refresh.changedFiles, 0);
    const third = (await handleAgentContext(args, context)) as Record<
      string,
      unknown
    >;
    const thirdCards = (third.evidence as Array<Record<string, unknown>>).filter(
      (item) => item.rung === "card",
    );
    assert.deepStrictEqual(thirdCards, secondCards);
    assert.equal(third.etag, first.etag);
  } finally {
    sessionContentLedger.clearSession(sessionId);
    try {
      await closeLadybugDb();
    } finally {
      if (previousConfig === undefined) delete process.env.SDL_CONFIG;
      else process.env.SDL_CONFIG = previousConfig;
      if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
      else process.env.SDL_CONFIG_PATH = previousConfigPath;
    }
  }
});

test("SESSION BOUNDARY: workflow projection is resolved before continuation storage", async () => {
  const rawOverview = {
    repoId: REPO_ID,
    generatedAt: "2026-07-18T12:00:00.000Z",
    durationMs: 42,
    stableRepositoryData: { marker: "stable-repository-data", body: "stable ".repeat(1_000) },
  };
  const handlers = new Map<string, (args: unknown) => unknown>();
  const server = {
    registerTool: (name: string, _description: string, _schema: unknown, handler: (args: unknown) => unknown) => {
      handlers.set(name, handler);
    },
  } as unknown as MCPServer;
  registerCodeModeTools(
    server,
    {},
    { etagCaching: false } as CodeModeConfig,
    {
      "repo.status": { schema: z.object({}).passthrough(), handler: async () => ({ flag: true }) },
      "repo.overview": {
        schema: z.object({ level: z.string(), includeTelemetry: z.boolean().optional() }).passthrough(),
        handler: async () => rawOverview,
      },
    },
  );
  const workflow = handlers.get("sdl.workflow");
  assert.ok(workflow);
  const workflowArgs = {
    repoId: REPO_ID,
    steps: [
      { fn: "repoStatus", args: {} },
      { fn: "repoOverview", args: { level: "stats", includeTelemetry: "$0.flag" }, maxResponseTokens: 100 },
    ],
  };
  const run = async (): Promise<string> => {
    const response = await workflow(workflowArgs) as {
      results: Array<{ result?: unknown; truncatedResponse?: { continuationHandle?: string } }>;
    };
    const handle = response.results[1].truncatedResponse?.continuationHandle;
    assert.ok(handle);
    const continuation = canonical(getContinuation(handle)?.data);
    assert.doesNotMatch(continuation, /generatedAt/);
    assert.match(continuation, /durationMs/);
    assert.match(continuation, /stable-repository-data/);
    const displayed = projectToolResultForModelContent("sdl.workflow", response, workflowArgs) as {
      results: Array<{
        result?: unknown;
        truncatedResponse?: { continuationHandle?: string };
      }>;
    };
    assert.equal(displayed.results[1].result, undefined);
    assert.equal(
      displayed.results[1].truncatedResponse?.continuationHandle,
      handle,
    );
    return handle;
  };

  // Continuation handles are process-local state, so validate each payload without byte-comparing handles.
  const firstHandle = await run();
  assert.notEqual(await run(), firstHandle);
});

test("INVARIANT 2c: compact repo status omits revisions while full diagnostics stay deterministic", () => {
  const canonicalStatus = {
    repoId: REPO_ID,
    rootAvailability: { status: "available" },
    latestVersionId: "v2",
    filesIndexed: 1,
    symbolsIndexed: 1,
    derivedState: {
      stale: false,
      graphIntegrityState: "verifying",
      graphIntegrityVersionId: "v2",
      graphIntegrityRevision: 2,
      graphIntegrityVerifiedRevision: 1,
      graphIntegrityDigest: "a".repeat(64),
    },
  };

  const compact = projectToolResultForModelContent(
    "sdl.repo.status",
    canonicalStatus,
  ) as { derivedState: Record<string, unknown> };
  assert.deepEqual(Object.keys(compact.derivedState), [
    "graphIntegrityState",
  ]);
  assert.equal("graphIntegrityRevision" in compact.derivedState, false);
  assert.equal("graphIntegrityDigest" in compact.derivedState, false);

  const diagnostic = projectToolResultForModelContent(
    "sdl.repo.status",
    canonicalStatus,
    { detail: "full", includeDiagnostics: true },
  ) as { derivedState: Record<string, unknown> };
  assert.deepEqual(Object.keys(diagnostic.derivedState), [
    "stale",
    "graphIntegrityState",
    "graphIntegrityVersionId",
    "graphIntegrityRevision",
    "graphIntegrityVerifiedRevision",
    "graphIntegrityDigest",
  ]);
  assert.equal(diagnostic.derivedState.graphIntegrityRevision, 2);
  assert.equal(diagnostic.derivedState.graphIntegrityDigest, "a".repeat(64));

  const retrieval = {
    matches: [{ symbolId: "symbol-1", name: "stable" }],
    total: 1,
  };
  assert.equal(
    canonical(projectToolResultForModelContent("sdl.symbol.search", retrieval)),
    canonical(retrieval),
  );
});

test("INVARIANT 2b: covered outputs are deterministic within and across processes", () => {
  const failures: string[] = [];

  for (const [key, runsA] of legA.results) {
    const [a1, a2] = runsA;
    const b1 = legB.results.get(key)?.[0];

    if (a1 !== a2) {
      failures.push(reportMismatch(`${key} (A1 vs A2)`, a1, a2));
    }
    if (b1 === undefined) {
      failures.push(`${key}: missing result in leg B`);
    } else if (a1 !== b1) {
      failures.push(reportMismatch(`${key} (A1 vs B1)`, a1, b1));
    }
  }

  assert.equal(failures.length, 0, "\n" + failures.join("\n\n"));
});

test("INVARIANT 3: covered outputs contain no fatal volatile content", () => {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const scanAll = (leg: Leg, legName: string): void => {
    for (const finding of scanVolatile(`${legName} tools-list`, leg.toolsCanonical)) {
      (finding.fatal ? fatal : warnings).push(finding.message);
    }
    for (const [key, runs] of leg.results) {
      for (const finding of scanVolatile(`${legName} ${key}`, runs[0])) {
        (finding.fatal ? fatal : warnings).push(finding.message);
      }
    }
  };

  scanAll(legA, "legA");
  scanAll(legB, "legB");

  for (const warning of warnings) {
    console.warn(`[volatile-scan warn] ${warning}`);
  }

  assert.equal(fatal.length, 0, "\n" + fatal.join("\n"));
});

test("PUBLIC DISPATCH: DB-backed responses conform to exported schemas", async () => {
  assert.ok(legA.setupResults, "leg A must capture setup responses");
  const registrationChanged = parseStructuredContent(
    RepoRegisterResponseSchema,
    legA.setupResults.registrationChanged,
  );
  assert.equal(registrationChanged.ok, true);
  assert.equal(registrationChanged.changed, true);

  const registrationIdempotent = parseStructuredContent(
    RepoRegisterResponseSchema,
    legA.setupResults.registrationIdempotent,
  );
  assert.equal(registrationIdempotent.ok, true);
  assert.equal(registrationIdempotent.changed, false);

  const initialRefresh = parseStructuredContent(
    IndexRefreshResponseSchema,
    legA.setupResults.indexRefresh,
  );
  assert.equal(initialRefresh.ok, true);
  assert.ok((initialRefresh.changedFiles ?? 0) > 0);




  const server = await spawnServer();
  try {
    const overview = parseStructuredContent(
      PublicRepoOverviewFullResponseSchema,
      await callToolStrict(server.client, "sdl.repo.overview", {
        repoId: REPO_ID,
        level: "full",
      }),
    );
    assert.equal(overview.repoId, REPO_ID);

    const sliceBuild = parseStructuredContent(
      SliceBuildResponseSchema,
      await callToolStrict(server.client, "sdl.slice.build", {
        repoId: REPO_ID,
        taskText: "Inspect UserRepository findById behavior",
        budget: { maxCards: 8, maxEstimatedTokens: 4_000 },
        wireFormat: "readable",
      }),
    );
    if (!("sliceHandle" in sliceBuild)) {
      assert.fail("slice.build returned an error response");
    }


    const initialSliceRefresh = parseStructuredContent(
      SliceRefreshResponseSchema,
      await callToolStrict(server.client, "sdl.slice.refresh", {
        repoId: REPO_ID,
        sliceHandle: sliceBuild.sliceHandle,
      }),
    );
    const sliceVersion = initialSliceRefresh.currentVersion;

    const notModified = parseStructuredContent(
      SliceRefreshResponseSchema,
      await callToolStrict(server.client, "sdl.slice.refresh", {
        repoId: REPO_ID,
        sliceHandle: sliceBuild.sliceHandle,
        knownVersion: sliceVersion,
      }),
    );
    assert.equal(notModified.notModified, true);
    assert.equal(notModified.currentVersion, sliceVersion);
    assert.equal(notModified.delta, null);

    const mutationFile = join(
      FIXTURE_REPO,
      "src",
      "typescript",
      "models.ts",
    );
    const originalSource = readFileSync(mutationFile, "utf8");
    const mutatedSource = originalSource.replace(
      "return this.users.get(id);",
      "return id.length > 0 ? this.users.get(id) : undefined;",
    );
    assert.notEqual(
      mutatedSource,
      originalSource,
      "controlled fixture mutation must change findById",
    );
    writeFileSync(mutationFile, mutatedSource, "utf8");

    const changedRefresh = parseStructuredContent(
      IndexRefreshResponseSchema,
      await callToolStrict(server.client, "sdl.index.refresh", {
        repoId: REPO_ID,
        mode: "incremental",
      }),
    );
    assert.equal(changedRefresh.ok, true);
    assert.ok((changedRefresh.changedFiles ?? 0) > 0);

    const changedSlice = parseStructuredContent(
      SliceRefreshResponseSchema,
      await callToolStrict(server.client, "sdl.slice.refresh", {
        repoId: REPO_ID,
        sliceHandle: sliceBuild.sliceHandle,
        knownVersion: sliceVersion,
      }),
    );
    assert.equal(changedSlice.notModified, false);
    assert.notEqual(changedSlice.currentVersion, sliceVersion);
    assert.ok(changedSlice.delta);
    assert.ok(changedSlice.delta.changedSymbols.length > 0);

    const delta = parseStructuredContent(
      DeltaGetResponseSchema,
      await callToolStrict(server.client, "sdl.delta.get", {
        repoId: REPO_ID,
        fromVersion: sliceVersion,
        toVersion: changedSlice.currentVersion,
        includeBlastRadius: true,
      }),
    );
    assert.equal(delta.delta.fromVersion, sliceVersion);
    assert.equal(delta.delta.toVersion, changedSlice.currentVersion);
    assert.ok(delta.delta.changedSymbols.length > 0);
  } finally {
    await server.close();
  }
});
