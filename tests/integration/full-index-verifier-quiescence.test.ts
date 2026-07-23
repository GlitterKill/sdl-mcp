import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, type TestContext } from "node:test";

import { Connection } from "kuzu";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { withTransaction } from "../../dist/db/ladybug-core.js";
import * as derivedState from "../../dist/db/ladybug-derived-state.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { SafeRebuildRequiredError } from "../../dist/domain/errors.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import {
  _resetGraphIntegrityVerifierForTesting,
  cancelAndWaitForAllGraphIntegrityVerifiers,
  notifyGraphIntegrityVerifier,
} from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";

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

async function waitForPromise(
  promise: Promise<void>,
  message: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface VerifierBlock {
  events: string[];
  pageStarted: Promise<void>;
  releasePage: () => void;
  pageQueriesBeforeClose: () => number | undefined;
  pendingReads: () => number;
  checkpointCalls: () => number;
  resetReads: () => number;
}

function blockVerifierPage(
  t: TestContext,
  options: { failReset?: boolean } = {},
): VerifierBlock {
  const statements = new WeakMap<object, string>();
  const workerConnections = new WeakSet<object>();
  const pageStarted = deferred();
  const releasePage = deferred();
  const events: string[] = [];
  let pageQueries = 0;
  let pageQueriesBeforeClose: number | undefined;
  let pendingReads = 0;
  let checkpointCalls = 0;
  let resetReads = 0;
  let resetFailurePending = options.failReset === true;
  const originalPrepare = Connection.prototype.prepare;
  const originalExecute = Connection.prototype.execute;
  const originalClose = Connection.prototype.close;
  const originalQuery = Connection.prototype.query;

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
        statement?.includes("MATCH (d:DerivedState)") &&
        statement.includes("graphIntegrityVerifiedRevision")
      ) {
        pendingReads += 1;
      }
      if (statement?.includes("OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]")) {
        pageQueries += 1;
        workerConnections.add(this);
        if (pageQueries === 1) {
          events.push("worker:page");
          pageStarted.resolve();
          await releasePage.promise;
        }
      }
      if (
        statement?.includes("MATCH (f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)") &&
        statement.includes("f.fileId IN $fileIds")
      ) {
        resetReads += 1;
        events.push("index:reset");
        if (resetFailurePending) {
          resetFailurePending = false;
          throw new Error("injected full reset failure");
        }
      }
      return originalExecute.call(
        this,
        prepared,
        params,
        progressCallback,
      );
    },
  );
  t.mock.method(Connection.prototype, "close", async function () {
    await originalClose.call(this);
    if (workerConnections.has(this)) {
      pageQueriesBeforeClose ??= pageQueries;
      events.push("worker:close");
    }
  });
  t.mock.method(Connection.prototype, "query", async function (statement) {
    if (statement.trim() === "CHECKPOINT") {
      checkpointCalls += 1;
      events.push("index:checkpoint");
    }
    return originalQuery.call(this, statement);
  });

  return {
    events,
    pageStarted: pageStarted.promise,
    releasePage: releasePage.resolve,
    pageQueriesBeforeClose: () => pageQueriesBeforeClose,
    pendingReads: () => pendingReads,
    checkpointCalls: () => checkpointCalls,
    resetReads: () => resetReads,
  };
}

describe("full index verifier quiescence", () => {
  const previousConfig = process.env.SDL_CONFIG;
  const previousConfigPath = process.env.SDL_CONFIG_PATH;
  let dbRoot = "";
  let repoRoot = "";
  let configPath = "";
  let repoId = "";

  afterEach(async () => {
    await cancelAndWaitForAllGraphIntegrityVerifiers().catch(() => {});
    await closeLadybugDb().catch(() => {});
    _resetGraphIntegrityVerifierForTesting();
    invalidateConfigCache();
    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = previousConfigPath;
    for (const path of [dbRoot, repoRoot, configPath]) {
      if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    dbRoot = "";
    repoRoot = "";
    configPath = "";
    repoId = "";
  });

  async function initializeRepo(): Promise<void> {
    dbRoot = mkdtempSync(join(tmpdir(), "sdl-full-quiescence-db-"));
    repoRoot = mkdtempSync(join(tmpdir(), "sdl-full-quiescence-repo-"));
    configPath = join(
      tmpdir(),
      `sdl-full-quiescence-${Date.now()}-${Math.random()}.json`,
    );
    repoId = `full-quiescence-${Date.now()}-${Math.random()}`;
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(
      join(repoRoot, "src", "index.ts"),
      "export function value() { return 1; }\n",
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [],
        policy: {},
        indexing: {
          pipeline: "legacy",
          engine: "typescript",
          enableFileWatching: false,
        },
        semantic: { enabled: false, generateSummaries: false },
        scip: { enabled: false },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;
    invalidateConfigCache();

    await initLadybugDb(join(dbRoot, "graph.lbug"));
    await withWriteConn((conn) =>
      ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: repoRoot,
        configJson: JSON.stringify({
          repoId,
          rootPath: repoRoot,
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

  async function advancePendingRevision(): Promise<void> {
    const state = await derivedState.getDerivedState(repoId);
    assert.ok(state?.graphIntegrityVersionId);
    assert.equal(typeof state.graphIntegrityRevision, "number");
    await withWriteConn((conn) =>
      withTransaction(conn, async () => {
        const revision =
          await derivedState.advanceGraphIntegrityRevisionInTransaction(
            conn,
            repoId,
            state.graphIntegrityVersionId!,
            state.graphIntegrityRevision!,
          );
        assert.equal(revision, state.graphIntegrityRevision! + 1);
      }),
    );
  }

  it("refuses a populated active full refresh before checkpoint or reset", async (t) => {
    await initializeRepo();
    const originalQuery = Connection.prototype.query;
    const originalExecute = Connection.prototype.execute;
    const statements = new WeakMap<object, string>();
    const originalPrepare = Connection.prototype.prepare;
    let checkpointCalls = 0;
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
        return originalExecute.call(
          this,
          prepared,
          params,
          progressCallback,
        );
      },
    );
    t.mock.method(Connection.prototype, "query", async function (statement) {
      if (statement.trim() === "CHECKPOINT") checkpointCalls += 1;
      return originalQuery.call(this, statement);
    });

    await assert.rejects(
      indexRepo(repoId, "full"),
      (error: unknown) => error instanceof SafeRebuildRequiredError,
    );
    assert.equal(checkpointCalls, 0);
    assert.equal(resetReads, 0);
  });

  it("closes a verifier lease before an explicit legacy full reset begins", async (t) => {
    await initializeRepo();
    await advancePendingRevision();
    const block = blockVerifierPage(t);
    assert.equal(notifyGraphIntegrityVerifier(repoId), true);
    await block.pageStarted;

    const refresh = indexRepo(repoId, "full", undefined, undefined, {
      isolatedRebuild: true,
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(block.resetReads(), 0);
      block.releasePage();
      await refresh;

      assert.equal(block.pageQueriesBeforeClose(), 1);
      assert.ok(block.checkpointCalls() >= 1);
      assert.ok(block.resetReads() >= 1);
      assert.ok(
        block.events.indexOf("worker:close") <
          block.events.indexOf("index:checkpoint"),
        `expected worker close before checkpoint: ${block.events.join(", ")}`,
      );
      assert.ok(
        block.events.indexOf("worker:close") <
          block.events.indexOf("index:reset"),
        `expected worker close before reset: ${block.events.join(", ")}`,
      );
    } finally {
      block.releasePage();
      await Promise.allSettled([refresh]);
    }
  });

  it("quiesces an incremental run that upgrades to effective full mode", async (t) => {
    await initializeRepo();
    const conn = await getLadybugConn();
    const files = await ladybugDb.getFilesByRepo(conn, repoId);
    await withWriteConn((writeConn) =>
      ladybugDb.deleteFilesByIds(
        writeConn,
        files.map((file) => file.fileId),
      ),
    );
    await advancePendingRevision();
    const block = blockVerifierPage(t);
    assert.equal(notifyGraphIntegrityVerifier(repoId), true);
    await block.pageStarted;

    const refresh = indexRepo(repoId, "incremental");
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(block.checkpointCalls(), 0);
      block.releasePage();
      await refresh;

      assert.equal(block.pageQueriesBeforeClose(), 1);
      assert.ok(block.checkpointCalls() >= 1);
      assert.ok(
        block.events.indexOf("worker:close") <
          block.events.indexOf("index:checkpoint"),
        `expected upgraded full checkpoint after worker close: ${block.events.join(", ")}`,
      );
    } finally {
      block.releasePage();
      await Promise.allSettled([refresh]);
    }
  });

  it("releases verifier admission when an effective full run fails", async (t) => {
    await initializeRepo();
    await advancePendingRevision();
    const block = blockVerifierPage(t, { failReset: true });
    assert.equal(notifyGraphIntegrityVerifier(repoId), true);
    await block.pageStarted;

    const refresh = indexRepo(repoId, "full", undefined, undefined, {
      isolatedRebuild: true,
    });
    try {
      block.releasePage();
      await assert.rejects(refresh, /injected full reset failure/);
      const pendingReadsBeforeNotify = block.pendingReads();
      assert.equal(notifyGraphIntegrityVerifier(repoId), true);
      await waitFor(
        () => block.pendingReads() > pendingReadsBeforeNotify,
        "worker did not restart after failed full refresh",
      );
    } finally {
      block.releasePage();
      await Promise.allSettled([refresh]);
    }
  });

  it("does not quiesce an ordinary incremental run", async (t) => {
    await initializeRepo();
    const statements = new WeakMap<object, string>();
    const pendingReadStarted = deferred();
    const releasePendingRead = deferred();
    const indexModeResolved = deferred();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    let blockPendingRead = true;
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
          blockPendingRead &&
          statement?.includes("MATCH (d:DerivedState)") &&
          statement.includes("graphIntegrityVerifiedRevision")
        ) {
          blockPendingRead = false;
          const result = await originalExecute.call(
            this,
            prepared,
            params,
            progressCallback,
          );
          pendingReadStarted.resolve();
          await releasePendingRead.promise;
          return result;
        }
        if (
          statement?.includes("MATCH (r:Repo {repoId: $repoId})") &&
          statement.includes("RETURN count(f) AS count")
        ) {
          indexModeResolved.resolve();
        }
        return originalExecute.call(
          this,
          prepared,
          params,
          progressCallback,
        );
      },
    );

    assert.equal(notifyGraphIntegrityVerifier(repoId), true);
    await pendingReadStarted.promise;
    const refresh = indexRepo(repoId, "incremental");
    try {
      await waitForPromise(
        indexModeResolved.promise,
        "incremental run waited for verifier",
      );
      releasePendingRead.resolve();
      await refresh;
    } finally {
      releasePendingRead.resolve();
      await Promise.allSettled([refresh]);
    }
  });
});
