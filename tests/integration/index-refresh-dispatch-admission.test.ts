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
        timer = setTimeout(() => reject(new Error(message)), 10_000);
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
      arguments: { repoId: REPO_A, mode: "full" },
    });
    await blocker.started;
    const second = client.callTool({
      name: "sdl.index.refresh",
      arguments: { repoId: REPO_B, mode: "full" },
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
      arguments: { repoId: REPO_A, action: "index.refresh", mode: "full" },
    });
    await blocker.started;
    const second = client.callTool({
      name: "sdl.repo",
      arguments: { repoId: REPO_A, action: "index.refresh", mode: "full" },
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
            { fn: "indexRefresh", args: { mode: "full" } },
            { fn: "indexRefresh", args: { mode: "full" } },
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
        steps: [{ fn: "index.refresh", args: { mode: "full" } }],
      },
    });
    await blocker.started;
    const second = client.callTool({
      name: "sdl.workflow",
      arguments: {
        repoId: REPO_B,
        steps: [{ fn: "index.refresh", args: { mode: "full" } }],
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
        arguments: { repoId: REPO_A, mode: "full", async: true },
      }),
      "async refresh did not return its operation response",
    );
    await blocker.started;
    assertSucceeded(backgroundResponse as ToolEnvelope, "async refresh response");

    const second = client.callTool({
      name: "sdl.index.refresh",
      arguments: { repoId: REPO_B, mode: "full" },
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

  it("gives async full refresh a synthetic lease that drains an active graph read before reset", async (t) => {
    await clearReadPoolStatementCaches();
    const statements = new WeakMap<object, string>();
    const readStarted = deferred();
    const releaseRead = deferred();
    const backgroundLookupStarted = deferred();
    const releaseBackgroundLookup = deferred();
    const resetStarted = deferred();
    const releaseReset = deferred();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    let blockedRead = false;
    let blockedBackgroundLookup = false;
    let blockedReset = false;

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
          !blockedRead &&
          statement?.includes("MATCH (v:Version)") &&
          statement.includes("VERSION_OF_REPO")
        ) {
          blockedRead = true;
          readStarted.resolve();
          await releaseRead.promise;
        }
        if (
          blockedRead &&
          !blockedBackgroundLookup &&
          statement?.includes("MATCH (r:Repo {repoId: $repoId})") &&
          statement.includes("RETURN r.repoId AS repoId")
        ) {
          blockedBackgroundLookup = true;
          backgroundLookupStarted.resolve();
          await releaseBackgroundLookup.promise;
        }
        if (
          !blockedReset &&
          statement?.includes("MATCH (f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)") &&
          statement.includes("f.fileId IN $fileIds")
        ) {
          blockedReset = true;
          resetStarted.resolve();
          await releaseReset.promise;
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    const read = client.callTool({
      name: "sdl.symbol.search",
      arguments: { repoId: REPO_A, query: "value", semantic: false },
    });
    await readStarted.promise;
    const asyncResponse = await withTimeout(
      client.callTool({
        name: "sdl.index.refresh",
        arguments: { repoId: REPO_A, mode: "full", async: true },
      }),
      "async refresh response waited for background indexing",
    );
    assertSucceeded(asyncResponse as ToolEnvelope, "async refresh response");
    await backgroundLookupStarted.promise;
    releaseBackgroundLookup.resolve();

    try {
      await waitFor(
        () => getToolDispatchStats().queued === 1,
        "background refresh did not reserve a synthetic dispatch lease",
      );
    } catch (error) {
      releaseRead.resolve();
      releaseReset.resolve();
      await read.catch(() => undefined);
      await withTimeout(
        client.callTool({
          name: "sdl.index.refresh",
          arguments: { repoId: REPO_B, mode: "full" },
        }),
        "timed-out background refresh did not settle during regression cleanup",
      ).catch(() => undefined);
      throw error;
    }
    assert.equal(
      blockedReset,
      false,
      "async destructive reset crossed an active graph-read dispatch lease",
    );
    assert.equal(getToolDispatchStats().active, 1);
    assert.deepEqual(getToolDispatchStats().activeLabels, ["sdl.symbol.search"]);
    assert.equal(getToolDispatchStats().queued, 1);

    releaseRead.resolve();
    assertSucceeded((await read) as ToolEnvelope, "drained graph read");
    await resetStarted.promise;
    assert.deepEqual(
      getToolDispatchStats().activeLabels,
      ["tool-dispatch"],
      "background indexRepo owns the synthetic dispatch lease during reset",
    );
    releaseReset.resolve();

    // Public refresh admission remains retained until the detached index settles.
    const afterBackground = await withTimeout(
      client.callTool({
        name: "sdl.index.refresh",
        arguments: { repoId: REPO_B, mode: "full" },
      }),
      "refresh admission did not release after async indexing",
    );
    assertSucceeded(afterBackground as ToolEnvelope, "post-background refresh");
  });

  it("drains an existing graph read before reset and queues a new read until full refresh completes", async (t) => {
    await clearReadPoolStatementCaches();
    const statements = new WeakMap<object, string>();
    const firstReadStarted = deferred();
    const releaseFirstRead = deferred();
    const resetStarted = deferred();
    const releaseReset = deferred();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    let blockedRead = false;
    let blockedReset = false;
    let resetReleased = false;
    let secondReadSettled = false;

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
          !blockedRead &&
          statement?.includes("MATCH (v:Version)") &&
          statement.includes("VERSION_OF_REPO")
        ) {
          blockedRead = true;
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
        }
        if (
          !blockedReset &&
          statement?.includes("MATCH (f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)") &&
          statement.includes("f.fileId IN $fileIds")
        ) {
          blockedReset = true;
          resetStarted.resolve();
          await releaseReset.promise;
          resetReleased = true;
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    const firstRead = client.callTool({
      name: "sdl.symbol.search",
      arguments: { repoId: REPO_A, query: "value", semantic: false },
    });
    await firstReadStarted.promise;
    const refresh = client.callTool({
      name: "sdl.index.refresh",
      arguments: { repoId: REPO_A, mode: "full" },
    });
    await waitFor(
      () => getToolDispatchStats().active === 2,
      "refresh never reached the dispatch-drain boundary",
    );
    assert.equal(blockedReset, false, "destructive reset crossed an active graph read");
    releaseFirstRead.resolve();
    assertSucceeded((await firstRead) as ToolEnvelope, "pre-reset graph read");
    await resetStarted.promise;

    const secondRead = client
      .callTool({
        name: "sdl.symbol.search",
        arguments: { repoId: REPO_A, query: "value", semantic: false },
      })
      .then((response) => {
        secondReadSettled = true;
        return response;
      });
    try {
      await waitFor(
        () => getToolDispatchStats().queued === 1,
        "graph read did not queue behind destructive full reset",
      );
      assert.equal(secondReadSettled, false);
      assert.equal(resetReleased, false);
    } finally {
      releaseReset.resolve();
    }

    const [refreshResponse, secondReadResponse] = await withTimeout(
      Promise.all([refresh, secondRead]),
      "full refresh or queued graph read deadlocked",
    );
    assert.equal(resetReleased, true);
    assertSucceeded(refreshResponse as ToolEnvelope, "full refresh");
    assertSucceeded(secondReadResponse as ToolEnvelope, "post-reset graph read");
  });
});
