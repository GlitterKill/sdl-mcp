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
import type { CodeModeConfig } from "../../dist/config/types.js";
import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";
import type { MCPServer } from "../../dist/server.js";
import {
  DeltaGetResponseSchema,
  IndexRefreshResponseSchema,
  RepoOverviewResponseSchema,
  RepoRegisterResponseSchema,
  SliceBuildResponseSchema,
  SliceRefreshResponseSchema,
} from "../../dist/mcp/tools.js";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ID = fixtures.repoId;
const SOURCE_FIXTURE_REPO = resolve(__dirname, fixtures.fixtureRepo);
const TEST_ROOT = mkdtempSync(join(tmpdir(), "sdl-determinism-"));
const FIXTURE_REPO = join(TEST_ROOT, "fixture-repo");
const GRAPH_DB_PATH = join(TEST_ROOT, "graph.lbug");
const CONFIG_PATH = join(TEST_ROOT, "sdl-determinism.config.json");
const DIFF_DIR = resolve(process.cwd(), ".determinism-diffs");

interface ServerHandle {
  client: Client;
  close: () => Promise<void>;
}

interface FixtureSetupResults {
  registrationChanged: unknown;
  registrationIdempotent: unknown;
  indexRefresh: unknown;
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
        codeMode: { enabled: false, exclusive: false },
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
      await client.close();
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
): Promise<unknown> {
  const response = await client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  });
  if ((response as { isError?: boolean }).isError) {
    assert.fail(`${name} failed: ${canonical(response)}`);
  }
  return response;
}
function parseStructuredContent<T>(
  schema: z.ZodType<T>,
  response: unknown,
): T {
  const structuredContent = (response as { structuredContent?: unknown })
    .structuredContent;
  assert.notStrictEqual(
    structuredContent,
    undefined,
    "public tool response must include structuredContent",
  );
  const parsed = schema.safeParse(structuredContent);
  assert.ok(
    parsed.success,
    `structuredContent schema mismatch: ${JSON.stringify({
      structuredContentKeys:
        structuredContent && typeof structuredContent === "object"
          ? Object.keys(structuredContent)
          : [],
      nestedSliceKeys:
        structuredContent &&
        typeof structuredContent === "object" &&
        "slice" in structuredContent &&
        structuredContent.slice &&
        typeof structuredContent.slice === "object"
          ? Object.keys(structuredContent.slice)
          : [],
      selectedValues:
        structuredContent && typeof structuredContent === "object"
          ? Object.fromEntries(
              ["notModified", "knownVersion", "currentVersion"].flatMap((key) =>
                key in structuredContent
                  ? [[key, structuredContent[key as keyof typeof structuredContent]]]
                  : [],
              ),
            )
          : {},
      nestedDeltaKeys:
        structuredContent &&
        typeof structuredContent === "object" &&
        "delta" in structuredContent &&
        structuredContent.delta &&
        typeof structuredContent.delta === "object"
          ? Object.keys(structuredContent.delta)
          : [],
      issues: parsed.error?.issues,
    })}`,
  );
  return parsed.data;
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
    const results = new Map<string, string[]>();

    for (const [ordinal, call] of fixtures.toolCalls.entries()) {
      const args = materializeArgs(call.args);
      const key = callKey(call.tool, args, ordinal);
      const runs: string[] = [];
      for (let i = 0; i < repeats; i++) {
        runs.push(canonical(await callToolStrict(server.client, call.tool, args)));
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
  writeConfig();
  rmSync(DIFF_DIR, { recursive: true, force: true });
  rmSync(GRAPH_DB_PATH, { recursive: true, force: true });

  legA = await runLeg(2, { setup: true });

  if (process.env.REBUILD_INDEX === "1") {
    rmSync(GRAPH_DB_PATH, { recursive: true, force: true });
  }

  legB = await runLeg(1, { setup: process.env.REBUILD_INDEX === "1" });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

test("INVARIANT 1: tool surface is byte-stable across processes", () => {
  if (legA.toolsCanonical !== legB.toolsCanonical) {
    assert.fail(reportMismatch("tools-list", legA.toolsCanonical, legB.toolsCanonical));
  }
});

test("INVARIANT 2a: exposed tools are covered or justified", () => {
  const exposed: string[] = JSON.parse(legA.toolsCanonical).tools.map(
    (tool: { name: string }) => tool.name,
  );
  const covered = new Set(fixtures.toolCalls.map((call) => call.tool));
  const allow = new Map(
    fixtures.uncoveredAllowlist.map((entry) => [entry.tool, entry.reason]),
  );

  const missing = exposed.filter((tool) => !covered.has(tool) && !allow.has(tool));
  const stale = [...allow.keys()].filter((tool) => !exposed.includes(tool));
  const reasonless = [...allow.entries()]
    .filter(([, reason]) => typeof reason !== "string" || reason.trim() === "")
    .map(([tool]) => tool);

  assert.deepEqual(
    missing,
    [],
    `Tools with no determinism fixture or allowlist reason: ${missing.join(", ")}`,
  );
  assert.deepEqual(stale, [], `Allowlist entries for non-exposed tools: ${stale.join(", ")}`);
  assert.deepEqual(reasonless, [], `Allowlist entries missing reasons: ${reasonless.join(", ")}`);
});

test("INVARIANT 2b: registered workflow uses resolved projection options deterministically", async () => {
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
    const displayed = projectToolResultForModelContent("sdl.workflow", response, workflowArgs) as {
      results: Array<{ result?: unknown }>;
    };
    assert.match(canonical(displayed.results[1].result), /durationMs/);
    return continuation;
  };

  const first = await run();
  assert.match(first, /stable-repository-data/);
  assert.equal(await run(), first);
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
      RepoOverviewResponseSchema,
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
