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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
const FIXTURE_REPO = resolve(__dirname, fixtures.fixtureRepo);
const TEST_ROOT = mkdtempSync(join(tmpdir(), "sdl-determinism-"));
const GRAPH_DB_PATH = join(TEST_ROOT, "graph.lbug");
const CONFIG_PATH = join(TEST_ROOT, "sdl-determinism.config.json");
const DIFF_DIR = resolve(process.cwd(), ".determinism-diffs");

interface ServerHandle {
  client: Client;
  close: () => Promise<void>;
}

interface Leg {
  toolsCanonical: string;
  results: Map<string, string[]>;
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

async function setupFixtureRepo(client: Client): Promise<void> {
  await callToolStrict(client, "sdl.repo.register", {
    repoId: REPO_ID,
    rootPath: FIXTURE_REPO,
    updateExisting: true,
    languages: ["ts", "tsx", "js", "jsx", "py", "go", "java", "cs", "c", "cpp", "rs", "kt", "php", "sh"],
    maxFileBytes: 2_000_000,
  });

  await callToolStrict(client, "sdl.index.refresh", {
    repoId: REPO_ID,
    mode: "full",
  });
}

async function runLeg(repeats: number, options: { setup: boolean }): Promise<Leg> {
  const server = await spawnServer();
  try {
    if (options.setup) {
      await setupFixtureRepo(server.client);
    }

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

    return { toolsCanonical: canonical(tools), results };
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
