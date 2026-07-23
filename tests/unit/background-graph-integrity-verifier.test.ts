import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { Connection } from "kuzu";

import {
  _resetGraphIntegrityVerifierForTesting,
  cancelAndWaitForAllGraphIntegrityVerifiers,
  cancelAndWaitForGraphIntegrityVerifier,
  notifyGraphIntegrityVerifier,
  runGraphIntegrityVerifierRecoverySweep,
  startGraphIntegrityVerifierRecovery,
  stopGraphIntegrityVerifierRecovery,
  waitForGraphIntegrityVerifier,
  withGraphIntegrityVerifierQuiesced,
} from "../../dist/indexer/provider-first/background-graph-integrity-verifier.js";
import {
  closeLadybugDb,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { withTransaction } from "../../dist/db/ladybug-core.js";
import * as derivedState from "../../dist/db/ladybug-derived-state.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  createGraphIntegrityExpectationFromManifest,
  createGraphIntegrityFileState,
  PersistedGraphIntegritySession,
} from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import { logger } from "../../dist/util/logger.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function symbolRow(repoId: string) {
  return {
    symbolId: `${repoId}:sym:alpha`,
    repoId,
    fileId: `${repoId}:src/alpha.ts`,
    kind: "function",
    name: "alpha",
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 3,
    rangeEndCol: 1,
    astFingerprint: `${repoId}:fingerprint-alpha`,
    signatureJson: '{"name":"alpha"}',
    summary: null,
    invariantsJson: null,
    sideEffectsJson: null,
    source: "scip",
    scipSymbol: `scip-typescript npm fixture 1.0.0 ${repoId}/alpha().`,
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}

async function seedPendingRevision(
  root: string,
  repoId: string,
): Promise<void> {
  const row = symbolRow(repoId);
  const file = createGraphIntegrityFileState(
    repoId,
    row.fileId,
    "src/alpha.ts",
    [row],
    [],
  );
  const expectation = createGraphIntegrityExpectationFromManifest([file], []);

  await withWriteConn((conn) =>
    withTransaction(conn, async () => {
      await ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-21T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: row.fileId,
        repoId,
        relPath: "src/alpha.ts",
        contentHash: "a".repeat(64),
        language: "typescript",
        byteSize: 10,
        lastIndexedAt: "2026-07-21T00:00:00.000Z",
      });
      await ladybugDb.upsertKnownFileSymbols(conn, [row]);
      await ladybugDb.createVersion(conn, {
        versionId: "v1",
        repoId,
        createdAt: "2026-07-21T00:00:00.000Z",
        reason: "test",
        prevVersionHash: null,
        versionHash: null,
      });
      await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
        files: [file],
        fileless: [],
      });
      await derivedState.beginGraphIntegrityVersion(
        conn,
        repoId,
        "v1",
        expectation.digest,
        true,
      );
      assert.equal(
        await derivedState.advanceGraphIntegrityRevisionInTransaction(
          conn,
          repoId,
          "v1",
          0,
        ),
        1,
      );
    }),
  );
}

async function advanceRevision(
  repoId: string,
  expectedRevision: number,
): Promise<number> {
  return withWriteConn((conn) =>
    withTransaction(conn, async () => {
      const revision =
        await derivedState.advanceGraphIntegrityRevisionInTransaction(
          conn,
          repoId,
          "v1",
          expectedRevision,
        );
      assert.equal(revision, expectedRevision + 1);
      return revision!;
    }),
  );
}

async function waitForState(
  repoId: string,
  predicate: (row: derivedState.DerivedStateRow | null) => boolean,
): Promise<derivedState.DerivedStateRow> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const row = await derivedState.getDerivedState(repoId);
    if (row && predicate(row)) return row;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for graph integrity state for ${repoId}`);
}

describe("background graph integrity verifier", () => {
  let root = "";

  afterEach(async () => {
    await stopGraphIntegrityVerifierRecovery();
    await closeLadybugDb().catch(() => {});
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
    root = "";
    _resetGraphIntegrityVerifierForTesting();
  });

  it("keeps a repository quiesced when a previously captured recovery sweep resumes", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-quiesce-race-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");

    const statements = new WeakMap<object, string>();
    const pendingCaptured = deferred();
    const releasePendingRead = deferred();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      const prepared = await originalPrepare.call(this, statement);
      statements.set(prepared, statement);
      return prepared;
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        const result = await originalExecute.call(
          this,
          prepared,
          params,
          progressCallback,
        );
        const statement = statements.get(prepared);
        if (
          statement?.includes("MATCH (d:DerivedState)") &&
          statement.includes("graphIntegrityVerifiedRevision")
        ) {
          pendingCaptured.resolve();
          await releasePendingRead.promise;
        }
        return result;
      },
    );

    const sweep = runGraphIntegrityVerifierRecoverySweep();
    await pendingCaptured.promise;
    await withGraphIntegrityVerifierQuiesced("repo", async () => {
      releasePendingRead.resolve();
      await sweep;
      assert.equal(notifyGraphIntegrityVerifier("repo"), false);
      assert.equal(
        (await derivedState.getDerivedState("repo"))?.graphIntegrityState,
        "verifying",
      );
    });

    assert.equal(notifyGraphIntegrityVerifier("repo"), true);
    await waitForState(
      "repo",
      (state) => state?.graphIntegrityVerifiedRevision === 1,
    );
  });

  it("waits for useful in-flight verification without cancelling it", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-wait-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");

    const statements = new WeakMap<object, string>();
    const pageStarted = deferred();
    const releasePage = deferred();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      const prepared = await originalPrepare.call(this, statement);
      statements.set(prepared, statement);
      return prepared;
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        if (
          statements
            .get(prepared)
            ?.includes("OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]")
        ) {
          pageStarted.resolve();
          await releasePage.promise;
        }
        return originalExecute.call(
          this,
          prepared,
          params,
          progressCallback,
        );
      },
    );

    assert.equal(notifyGraphIntegrityVerifier("repo"), true);
    await pageStarted.promise;
    let settled = false;
    const waiter = waitForGraphIntegrityVerifier("repo").then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    releasePage.resolve();
    await waiter;
    assert.equal(
      (await derivedState.getDerivedState("repo"))?.graphIntegrityState,
      "verified",
    );
  });

  it("recovers a durable pending revision whose wakeup was lost", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-lost-wakeup-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");

    await waitForGraphIntegrityVerifier("repo");

    const state = await derivedState.getDerivedState("repo");
    assert.equal(state?.graphIntegrityState, "verified");
    assert.equal(state?.graphIntegrityVerifiedRevision, 1);
  });

  it("awaits an in-flight recovery sweep and blocks late notifications during global stop", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-stop-race-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");

    const statements = new WeakMap<object, string>();
    const pendingCaptured = deferred();
    const releasePendingRead = deferred();
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      const prepared = await originalPrepare.call(this, statement);
      statements.set(prepared, statement);
      return prepared;
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        const result = await originalExecute.call(
          this,
          prepared,
          params,
          progressCallback,
        );
        const statement = statements.get(prepared);
        if (
          statement?.includes("MATCH (d:DerivedState)") &&
          statement.includes("graphIntegrityVerifiedRevision")
        ) {
          pendingCaptured.resolve();
          await releasePendingRead.promise;
        }
        return result;
      },
    );

    const recovery = startGraphIntegrityVerifierRecovery();
    await pendingCaptured.promise;
    let stopped = false;
    const stopping = stopGraphIntegrityVerifierRecovery().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, "global stop must drain the captured sweep");

    releasePendingRead.resolve();
    await recovery;
    await stopping;
    assert.equal(notifyGraphIntegrityVerifier("repo"), false);
    assert.equal(
      (await derivedState.getDerivedState("repo"))?.graphIntegrityState,
      "verifying",
    );
  });

  it("keeps recovery terminal when a late startup continuation runs after stop", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-terminal-stop-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");
    await stopGraphIntegrityVerifierRecovery();

    let pendingReads = 0;
    const originalPrepare = Connection.prototype.prepare;
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      if (
        statement.includes("MATCH (d:DerivedState)") &&
        statement.includes("graphIntegrityVerifiedRevision")
      ) {
        pendingReads += 1;
      }
      return originalPrepare.call(this, statement);
    });

    await startGraphIntegrityVerifierRecovery();

    assert.equal(pendingReads, 0, "late startup must not query recovery state");
    assert.equal(notifyGraphIntegrityVerifier("repo"), false);
    assert.doesNotThrow(
      () => _resetGraphIntegrityVerifierForTesting(),
      "late startup must not recreate the recovery timer or a worker",
    );
  });

  it("starts immediately and reloads durable work after successful publication", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-immediate-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");

    const statements = new WeakMap<object, string>();
    let pendingReads = 0;
    const pendingRepoIds: unknown[] = [];
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
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
          pendingRepoIds.push(
            (params as Record<string, unknown> | undefined)?.repoId,
          );
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    notifyGraphIntegrityVerifier("repo");
    const row = await waitForState(
      "repo",
      (state) =>
        state?.graphIntegrityState === "verified" &&
        state.graphIntegrityVerifiedRevision === 1 &&
        pendingReads >= 2,
    );

    assert.equal(row.graphIntegrityRevision, 1);
    assert.deepEqual(
      [...new Set(pendingRepoIds)],
      ["repo"],
      "workers must query only their current repository",
    );
  });

  it("coalesces rapid notifications to the newest durable revision and cancels only after an in-flight page returns", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-coalesce-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");

    const statements = new WeakMap<object, string>();
    const firstPageStarted = deferred();
    const releaseFirstPage = deferred();
    let pageQueries = 0;
    let activePageQueries = 0;
    let maxActivePageQueries = 0;
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
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
        if (statement?.includes("OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]")) {
          pageQueries += 1;
          activePageQueries += 1;
          maxActivePageQueries = Math.max(maxActivePageQueries, activePageQueries);
          try {
            if (pageQueries === 1) {
              firstPageStarted.resolve();
              await releaseFirstPage.promise;
            }
            return await originalExecute.call(
              this,
              prepared,
              params,
              progressCallback,
            );
          } finally {
            activePageQueries -= 1;
          }
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    notifyGraphIntegrityVerifier("repo");
    await firstPageStarted.promise;
    await advanceRevision("repo", 1);
    notifyGraphIntegrityVerifier("repo");
    await advanceRevision("repo", 2);
    notifyGraphIntegrityVerifier("repo");

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(activePageQueries, 1, "native query must not be interrupted");
    releaseFirstPage.resolve();

    const row = await waitForState(
      "repo",
      (state) =>
        state?.graphIntegrityState === "verified" &&
        state.graphIntegrityVerifiedRevision === 3,
    );
    assert.equal(row.graphIntegrityRevision, 3);
    assert.ok(pageQueries >= 2, "worker must reload after cancellation");
    assert.equal(maxActivePageQueries, 1, "only one revision may scan per repo");
  });

  it("publishes a sanitized failure after bounded retry exhaustion", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-retry-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");

    const statements = new WeakMap<object, string>();
    let failures = 0;
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
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
          failures < 4 &&
          statement?.includes("OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]")
        ) {
          failures += 1;
          throw new Error("secret C:\\private\\graph.lbug query detail");
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    notifyGraphIntegrityVerifier("repo");
    const row = await waitForState(
      "repo",
      (state) => state?.graphIntegrityState === "failed",
    );

    assert.equal(failures, 4);
    assert.equal(row.graphIntegrityRevision, 1);
    assert.equal(row.graphIntegrityVerifiedRevision, 0);
    assert.equal(
      row.graphIntegrityError,
      "Persisted graph integrity verification failed",
    );
    assert.doesNotMatch(row.graphIntegrityError ?? "", /secret|private|\.lbug/i);
  });

  it("publishes deterministic manifest corruption without retrying", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-corrupt-manifest-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");
    await withWriteConn((conn) =>
      ladybugDb.exec(
        conn,
        `MATCH (f:GraphIntegrityFileState {stateId: $stateId})
         SET f.fileId = 'corrupt-file-id'`,
        { stateId: JSON.stringify(["repo", "repo:src/alpha.ts"]) },
      ),
    );

    const statements = new WeakMap<object, string>();
    let manifestReads = 0;
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    t.mock.method(Connection.prototype, "prepare", async function (statement) {
      const prepared = await originalPrepare.call(this, statement);
      statements.set(prepared, statement);
      return prepared;
    });
    t.mock.method(
      Connection.prototype,
      "execute",
      async function (prepared, params, progressCallback) {
        if (
          statements
            .get(prepared)
            ?.includes("GRAPH_INTEGRITY_FILE_STATE_IN_REPO")
        ) {
          manifestReads += 1;
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    notifyGraphIntegrityVerifier("repo");
    const row = await waitForState(
      "repo",
      (state) => state?.graphIntegrityState === "failed",
    );

    assert.equal(manifestReads, 1);
    assert.equal(
      row.graphIntegrityError,
      "Persisted graph integrity verification failed",
    );
  });

  it("reloads the newest durable revision after a stale success CAS", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-stale-success-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");

    const statements = new WeakMap<object, string>();
    let successPublications = 0;
    let pageQueries = 0;
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
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
        if (statement?.includes("OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]")) {
          pageQueries += 1;
        }
        if (
          statement?.includes("SET d.graphIntegrityState = 'verified'") &&
          statement.includes("d.graphIntegrityRevision = $revision")
        ) {
          successPublications += 1;
          if (successPublications === 1) {
            const result = await this.query(
              `MATCH (d:DerivedState {repoId: 'repo'})
               SET d.graphIntegrityState = 'verifying',
                   d.graphIntegrityRevision = 2`,
            );
            for (const item of Array.isArray(result) ? result : [result]) {
              item.close();
            }
          }
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    notifyGraphIntegrityVerifier("repo");
    const row = await waitForState(
      "repo",
      (state) =>
        state?.graphIntegrityState === "verified" &&
        state.graphIntegrityVerifiedRevision === 2,
    );

    assert.equal(row.graphIntegrityRevision, 2);
    assert.equal(successPublications, 2);
    assert.ok(pageQueries >= 2, "stale CAS must reload durable work");
  });

  it("does not let a stale retry-exhaustion failure poison a newer revision", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-stale-failure-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");

    const statements = new WeakMap<object, string>();
    let scanFailures = 0;
    let failurePublications = 0;
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
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
          scanFailures < 4 &&
          statement?.includes("OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]")
        ) {
          scanFailures += 1;
          throw new Error("transient scan failure");
        }
        if (
          statement?.includes("SET d.graphIntegrityState = 'failed'") &&
          statement.includes("d.graphIntegrityRevision = $revision")
        ) {
          failurePublications += 1;
          const result = await this.query(
            `MATCH (d:DerivedState {repoId: 'repo'})
             SET d.graphIntegrityState = 'verifying',
                 d.graphIntegrityRevision = 2`,
          );
          for (const item of Array.isArray(result) ? result : [result]) {
            item.close();
          }
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    notifyGraphIntegrityVerifier("repo");
    const row = await waitForState(
      "repo",
      (state) =>
        state?.graphIntegrityState === "verified" &&
        state.graphIntegrityVerifiedRevision === 2,
    );

    assert.equal(scanFailures, 4);
    assert.equal(failurePublications, 1);
    assert.equal(row.graphIntegrityRevision, 2);
    assert.equal(row.graphIntegrityError, null);
  });

  it("cancelAndWait and cancelAndWaitAll resolve only after active pages and exclusive leases release", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-cancel-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo-a");
    await seedPendingRevision(root, "repo-b");

    const statements = new WeakMap<object, string>();
    const pagesStarted = deferred();
    const releasePages = deferred();
    let started = 0;
    let closed = 0;
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
    const originalClose = Connection.prototype.close;
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
        if (statement?.includes("OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]")) {
          started += 1;
          if (started === 2) pagesStarted.resolve();
          await releasePages.promise;
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );
    t.mock.method(Connection.prototype, "close", async function () {
      await originalClose.call(this);
      closed += 1;
    });

    notifyGraphIntegrityVerifier("repo-a");
    notifyGraphIntegrityVerifier("repo-b");
    await pagesStarted.promise;

    let oneSettled = false;
    const cancelOne = cancelAndWaitForGraphIntegrityVerifier("repo-a").then(
      () => {
        oneSettled = true;
      },
    );
    const cancelAll = cancelAndWaitForAllGraphIntegrityVerifiers();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(oneSettled, false);
    assert.equal(closed, 0);

    releasePages.resolve();
    await Promise.all([cancelOne, cancelAll]);
    assert.equal(closed, 2);
  });

  it("does not let recovery claim a staged synchronous revision", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-sync-owner-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await withWriteConn((conn) =>
      ladybugDb.upsertRepo(conn, {
        repoId: "repo",
        rootPath: root,
        configJson: "{}",
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    );
    const session = new PersistedGraphIntegritySession("repo", "full", true);
    await session.begin("v1");
    assert.equal(await session.stageManifest("v1"), 0);

    assert.equal(notifyGraphIntegrityVerifier("repo"), false);
    await runGraphIntegrityVerifierRecoverySweep();
    const staged = await derivedState.getDerivedState("repo");
    assert.equal(staged?.graphIntegrityState, "verifying");
    assert.equal(staged?.graphIntegrityRevision, 0);
    assert.equal(staged?.graphIntegrityVerifiedRevision, null);

    await session.complete("v1");
    const completed = await derivedState.getDerivedState("repo");
    assert.equal(completed?.graphIntegrityState, "verified");
    assert.equal(completed?.graphIntegrityVerifiedRevision, 0);
  });

  it("startup and the fixed five-second sweep recover runtime-registered repositories", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-recovery-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "runtime-a");

    let scheduledSweep: (() => void) | undefined;
    let cleared = false;
    t.mock.method(
      globalThis,
      "setInterval",
      ((callback: () => void, delay: number) => {
        assert.equal(delay, 5_000);
        scheduledSweep = callback;
        return { unref() {} } as NodeJS.Timeout;
      }) as typeof setInterval,
    );
    t.mock.method(
      globalThis,
      "clearInterval",
      (() => {
        cleared = true;
      }) as typeof clearInterval,
    );

    await startGraphIntegrityVerifierRecovery();
    await startGraphIntegrityVerifierRecovery();
    await waitForState(
      "runtime-a",
      (state) => state?.graphIntegrityVerifiedRevision === 1,
    );

    await seedPendingRevision(root, "runtime-b");
    assert.ok(scheduledSweep);
    scheduledSweep();
    await waitForState(
      "runtime-b",
      (state) => state?.graphIntegrityVerifiedRevision === 1,
    );

    await runGraphIntegrityVerifierRecoverySweep();
    stopGraphIntegrityVerifierRecovery();
    assert.equal(cleared, true);
  });

  it("keeps startup recovery retryable after an initial sanitized failure", async (t) => {
    root = mkdtempSync(join(tmpdir(), "sdl-bg-integrity-startup-retry-"));
    await initLadybugDb(join(root, "graph.lbug"));
    await seedPendingRevision(root, "repo");

    const statements = new WeakMap<object, string>();
    let pendingFailures = 0;
    const originalPrepare = Connection.prototype.prepare;
    const originalExecute = Connection.prototype.execute;
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
          pendingFailures === 0 &&
          statement?.includes("MATCH (d:DerivedState)") &&
          statement.includes("graphIntegrityVerifiedRevision")
        ) {
          pendingFailures += 1;
          throw new Error("secret C:\\private\\startup.lbug query detail");
        }
        return originalExecute.call(this, prepared, params, progressCallback);
      },
    );

    let intervalStarts = 0;
    t.mock.method(
      globalThis,
      "setInterval",
      ((callback: () => void, delay: number) => {
        assert.equal(delay, 5_000);
        intervalStarts += 1;
        return { unref() {}, callback } as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
    );
    const errors: Array<{
      message: string;
      meta: Record<string, unknown> | undefined;
    }> = [];
    t.mock.method(
      logger,
      "error",
      (message: string, meta?: Record<string, unknown>) => {
        errors.push({ message, meta });
      },
    );

    await startGraphIntegrityVerifierRecovery();
    assert.equal(intervalStarts, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /recovery sweep failed/i);
    assert.doesNotMatch(JSON.stringify(errors[0]), /secret|private|\.lbug/i);

    await startGraphIntegrityVerifierRecovery();
    await waitForState(
      "repo",
      (state) => state?.graphIntegrityVerifiedRevision === 1,
    );
    await startGraphIntegrityVerifierRecovery();
    assert.equal(intervalStarts, 1, "restarts must not install another interval");
  });
});
