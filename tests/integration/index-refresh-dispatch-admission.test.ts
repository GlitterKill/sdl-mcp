import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Connection } from "kuzu";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { clearPreparedStatementCache } from "../../dist/db/ladybug-core.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import {
  _resetGraphIntegrityVerifierForTesting,
  cancelAndWaitForAllGraphIntegrityVerifiers,
} from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";
import {
  _getIndexRefreshAdmissionStatsForTesting,
  getToolDispatchStats,
  resetToolDispatchLimiter,
} from "../../dist/mcp/dispatch-limiter.js";
import { resetIndexingGateForTests } from "../../dist/mcp/indexing-gate.js";
import { createMCPServer, MCPServer } from "../../dist/server.js";

const TEMP_BASE =
  process.platform === "win32" ? join(homedir(), ".codex", "tmp") : tmpdir();
mkdirSync(TEMP_BASE, { recursive: true });
const TEST_ROOT = mkdtempSync(join(TEMP_BASE, "sdl-refresh-admission-"));
const DB_DIR = join(TEST_ROOT, "db");
const DB_PATH = join(DB_DIR, "graph.lbug");
const CONFIG_PATH = join(TEST_ROOT, "sdl.config.json");
const REPO_A = "refresh-admission-a";
const REPO_B = "refresh-admission-b";

interface ToolEnvelope {
  isError?: boolean;
  structuredContent?: unknown;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The guard proves an admission deadlock without mistaking two serialized,
// real full refreshes on a slower hosted Windows runner for one.
const DEADLOCK_TIMEOUT_MS = 30_000;

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(message)),
          DEADLOCK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function connect(server: MCPServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: `refresh-admission-${randomUUID()}`,
    version: "1.0.0",
  });
  await server.getServer().connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function clearReadPoolStatementCaches(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    clearPreparedStatementCache(await getLadybugConn());
  }
}

function blockFirstRepoLookup(
  t: TestContext,
  options: { failIfConcurrentDispatch?: boolean } = {},
): {
  started: Promise<void>;
  release: () => void;
} {
  const statements = new WeakMap<object, string>();
  const started = deferred();
  const release = deferred();
  const originalPrepare = Connection.prototype.prepare;
  const originalExecute = Connection.prototype.execute;
  let blocked = false;

  t.mock.method(Connection.prototype, "prepare", async function (statement) {
    const prepared = await originalPrepare.call(this, statement);
    statements.set(prepared, statement);
    return prepared;
  });
  t.mock.method(
    Connection.prototype,
    "execute",
    async function (prepared, params, progressCallback) {
      const statement = statements.get(prepared);
      if (
        !blocked &&
        statement?.includes("MATCH (r:Repo {repoId: $repoId})") &&
        statement.includes("RETURN r.repoId AS repoId")
      ) {
        blocked = true;
        started.resolve();
        await release.promise;
        if (
          options.failIfConcurrentDispatch === true &&
          getToolDispatchStats().active > 1
        ) {
          throw new Error("injected concurrent refresh dispatch proof");
        }
      }
      return originalExecute.call(this, prepared, params, progressCallback);
    },
  );

  return { started: started.promise, release: release.resolve };
}

function assertSucceeded(response: ToolEnvelope, label: string): void {
  assert.notEqual(
    response.isError,
    true,
    `${label}: ${JSON.stringify(response.structuredContent)}`,
  );
}

function assertSafeRebuildRequired(response: ToolEnvelope, label: string): void {
  assert.equal(response.isError, true, label);
  assert.match(
    JSON.stringify(response.structuredContent),
    /--safe-rebuild <absolute-new-path>/,
    label,
  );
}

describe("public index refresh dispatch admission", { concurrency: 1 }, () => {
  let server: MCPServer;
  let client: Client;
  const previousEnv = {
    config: process.env.SDL_CONFIG,
    graphDb: process.env.SDL_GRAPH_DB_PATH,
    graphDir: process.env.SDL_GRAPH_DB_DIR,
    db: process.env.SDL_DB_PATH,
    native: process.env.SDL_MCP_DISABLE_NATIVE_ADDON,
  };

  before(async () => {
    mkdirSync(DB_DIR, { recursive: true });
    for (const [repoId, value] of [
      [REPO_A, 1],
      [REPO_B, 2],
    ] as const) {
      const rootPath = join(TEST_ROOT, repoId);
      mkdirSync(join(rootPath, "src"), { recursive: true });
      writeFileSync(
        join(rootPath, "src", "index.ts"),
        `export function value() { return ${value}; }\n`,
        "utf8",
      );
    }
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        repos: [],
        policy: {},
        graphDatabase: { path: DB_PATH },
        indexing: {
          pipeline: "legacy",
          engine: "typescript",
          enableFileWatching: false,
        },
        semantic: { enabled: false, generateSummaries: false },
        scip: { enabled: false },
        liveIndex: { enabled: false },
        prefetch: { enabled: false },
        memory: { enabled: false },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = CONFIG_PATH;
    process.env.SDL_GRAPH_DB_PATH = DB_PATH;
    process.env.SDL_GRAPH_DB_DIR = DB_DIR;
    process.env.SDL_DB_PATH = DB_PATH;
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    invalidateConfigCache();
    await closeLadybugDb();
    await initLadybugDb(DB_PATH);

    for (const repoId of [REPO_A, REPO_B]) {
      const rootPath = join(TEST_ROOT, repoId);
      await withWriteConn((conn) =>
        ladybugDb.upsertRepo(conn, {
          repoId,
          rootPath,
          configJson: JSON.stringify({
            repoId,
            rootPath,
            ignore: [],
            languages: ["ts"],
            maxFileBytes: 2_000_000,
            includeNodeModulesTypes: true,
          }),
          createdAt: "2026-07-21T00:00:00.000Z",
        }),
      );
      await indexRepo(repoId, "full");
    }

    resetToolDispatchLimiter();
    resetIndexingGateForTests();
    server = await createMCPServer({
      gatewayConfig: {
        enabled: true,
        emitLegacyTools: true,
        toolNameFormat: "canonical",
      },
      codeModeConfig: {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 60_000,
        ladderValidation: "warn",
        etagCaching: false,
      },
    });
    client = await connect(server);
  });

  after(async () => {
    await client?.close();
    await server?.stop();
    await cancelAndWaitForAllGraphIntegrityVerifiers().catch(() => {});
    _resetGraphIntegrityVerifierForTesting();
    resetToolDispatchLimiter();
    resetIndexingGateForTests();
    await closeLadybugDb();
    if (previousEnv.config === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousEnv.config;
    if (previousEnv.graphDb === undefined) delete process.env.SDL_GRAPH_DB_PATH;
    else process.env.SDL_GRAPH_DB_PATH = previousEnv.graphDb;
    if (previousEnv.graphDir === undefined) delete process.env.SDL_GRAPH_DB_DIR;
    else process.env.SDL_GRAPH_DB_DIR = previousEnv.graphDir;
    if (previousEnv.db === undefined) delete process.env.SDL_DB_PATH;
    else process.env.SDL_DB_PATH = previousEnv.db;
    if (previousEnv.native === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousEnv.native;
    }
    invalidateConfigCache();
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("serializes concurrent flat refreshes for different repos before dispatch", async (t) => {
    await clearReadPoolStatementCaches();
    const blocker = blockFirstRepoLookup(t);
    const first = client.callTool({
      name: "sdl.index.refresh",
      arguments: { repoId: REPO_A, mode: "incremental" },
    });
    await blocker.started;
    const second = client.callTool({
      name: "sdl.index.refresh",
      arguments: { repoId: REPO_B, mode: "incremental" },
    });
    try {
      await waitFor(
        () => _getIndexRefreshAdmissionStatsForTesting().queued === 1,
        "second flat refresh never queued at pre-dispatch admission",
      );
      assert.equal(getToolDispatchStats().active, 1);
    } finally {
      blocker.release();
    }
    const [firstResponse, secondResponse] = await withTimeout(
      Promise.all([first, second]),
      "concurrent different-repo refreshes deadlocked",
    );
    assertSucceeded(firstResponse as ToolEnvelope, "first flat refresh");
    assertSucceeded(secondResponse as ToolEnvelope, "second flat refresh");
  });

  it("serializes concurrent gateway refreshes for one repo before its repo lock", async (t) => {
    await clearReadPoolStatementCaches();
    const blocker = blockFirstRepoLookup(t);
    const first = client.callTool({
      name: "sdl.repo",
      arguments: { repoId: REPO_A, action: "index.refresh", mode: "incremental" },
    });
    await blocker.started;
    const second = client.callTool({
      name: "sdl.repo",
      arguments: { repoId: REPO_A, action: "index.refresh", mode: "incremental" },
    });
    try {
      await waitFor(
        () => _getIndexRefreshAdmissionStatsForTesting().queued === 1,
        "second gateway refresh never queued before the repo lock",
      );
      assert.equal(getToolDispatchStats().active, 1);
    } finally {
      blocker.release();
    }
    const [firstResponse, secondResponse] = await withTimeout(
      Promise.all([first, second]),
      "concurrent same-repo gateway refreshes deadlocked",
    );
    assertSucceeded(firstResponse as ToolEnvelope, "first gateway refresh");
    assertSucceeded(secondResponse as ToolEnvelope, "second gateway refresh");
  });

  it("admits multiple indexRefresh workflow steps before the one outer dispatch slot", async () => {
    const response = await withTimeout(
      client.callTool({
        name: "sdl.workflow",
        arguments: {
          repoId: REPO_A,
          steps: [
            { fn: "indexRefresh", args: { mode: "incremental" } },
            { fn: "indexRefresh", args: { mode: "incremental" } },
          ],
        },
      }),
      "workflow indexRefresh self-deadlocked on its outer dispatch slot",
    );
    assertSucceeded(response as ToolEnvelope, "workflow refresh");
    const results = (response as {
      structuredContent?: { results?: unknown[] };
    }).structuredContent?.results;
    assert.equal(results?.length, 2);
  });

  it("serializes concurrent canonical index.refresh workflows before dispatch", async (t) => {
    await clearReadPoolStatementCaches();
    const blocker = blockFirstRepoLookup(t, {
      failIfConcurrentDispatch: true,
    });
    const first = client.callTool({
      name: "sdl.workflow",
      arguments: {
        repoId: REPO_A,
        steps: [{ fn: "index.refresh", args: { mode: "incremental" } }],
      },
    });
    await blocker.started;
    const second = client.callTool({
      name: "sdl.workflow",
      arguments: {
        repoId: REPO_B,
        steps: [{ fn: "index.refresh", args: { mode: "incremental" } }],
      },
    });

    let queuedAtAdmission = false;
    try {
      await waitFor(
        () => {
          queuedAtAdmission =
            _getIndexRefreshAdmissionStatsForTesting().queued === 1;
          return queuedAtAdmission || getToolDispatchStats().active > 1;
        },
        "canonical workflows reached neither refresh admission nor concurrent dispatch",
      );
    } finally {
      blocker.release();
    }
    const responses = await withTimeout(
      Promise.all([first, second]),
      "concurrent canonical index.refresh workflows deadlocked",
    );
    assert.equal(
      queuedAtAdmission,
      true,
      "canonical index.refresh workflow bypassed pre-dispatch admission",
    );
    for (const [index, response] of responses.entries()) {
      assertSucceeded(response as ToolEnvelope, `canonical workflow ${index + 1}`);
    }
  });

  it("transfers async refresh admission ownership to the background index promise", async (t) => {
    await clearReadPoolStatementCaches();
    const blocker = blockFirstRepoLookup(t);
    const backgroundResponse = await withTimeout(
      client.callTool({
        name: "sdl.index.refresh",
        arguments: { repoId: REPO_A, mode: "incremental", async: true },
      }),
      "async refresh did not return its operation response",
    );
    await blocker.started;
    assertSucceeded(backgroundResponse as ToolEnvelope, "async refresh response");

    const second = client.callTool({
      name: "sdl.index.refresh",
      arguments: { repoId: REPO_B, mode: "incremental" },
    });
    try {
      await waitFor(
        () => _getIndexRefreshAdmissionStatsForTesting().queued === 1,
        "sync refresh crossed the detached async refresh admission lease",
      );
      assert.equal(getToolDispatchStats().active, 0);
    } finally {
      blocker.release();
    }
    const response = await withTimeout(
      second,
      "refresh queued behind async background indexing deadlocked",
    );
    assertSucceeded(response as ToolEnvelope, "post-async refresh");
  });

  it("rejects async full refresh before acknowledging a background operation", async () => {
    const response = await client.callTool({
      name: "sdl.index.refresh",
      arguments: { repoId: REPO_A, mode: "full", async: true },
    });

    assertSafeRebuildRequired(response as ToolEnvelope, "async full refresh");
  });

  it("rejects sync full refresh before destructive reset and preserves graph reads", async (t) => {
    await clearReadPoolStatementCaches();
    const statements = new WeakMap<object, string>();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    let resetReads = 0;

    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      const prepared = await originalPrepare.call(this, statement);
      statements.set(prepared, statement);
      return prepared;
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        const statement = statements.get(prepared);
        if (
          statement?.includes("MATCH (f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)") &&
          statement.includes("f.fileId IN $fileIds")
        ) {
          resetReads += 1;
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    const response = await client.callTool({
      name: "sdl.index.refresh",
      arguments: { repoId: REPO_A, mode: "full" },
    });
    assertSafeRebuildRequired(response as ToolEnvelope, "sync full refresh");
    assert.equal(resetReads, 0);

    const read = await client.callTool({
      name: "sdl.symbol.search",
      arguments: { repoId: REPO_A, query: "value", semantic: false },
    });
    assertSucceeded(read as ToolEnvelope, "graph read after rejected full refresh");
  });
});
