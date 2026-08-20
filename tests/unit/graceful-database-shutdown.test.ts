import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugDbPath,
  initLadybugDb,
  runWalCheckpoint,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { markDerivedStateDirty } from "../../dist/db/ladybug-derived-state.js";
import {
  enableDerivedRefreshQueue,
  enqueueDerivedRefresh,
  shutdownDerivedRefreshQueue,
  _setDerivedRefreshHooksForTesting,
} from "../../dist/indexer/derived-refresh-queue.js";
import {
  configureToolDispatchLimiter,
  getToolDispatchLimiter,
  resetToolDispatchLimiter,
  runToolDispatch,
} from "../../dist/mcp/dispatch-limiter.js";
import { withIndexingGate } from "../../dist/mcp/indexing-gate.js";
import {
  configureDefaultLiveIndexCoordinator,
  getDefaultLiveIndexCoordinator,
} from "../../dist/live-index/coordinator.js";
import {
  closeLadybugDbAfterDrainingWork,
  drainLadybugWork,
} from "../../dist/startup/graceful-database-shutdown.js";

let graphDbPath = "";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await shutdownDerivedRefreshQueue();
  _setDerivedRefreshHooksForTesting(null);
  enableDerivedRefreshQueue();
  resetToolDispatchLimiter();
  await closeLadybugDb();
  if (graphDbPath) rmSync(graphDbPath + ".sdl-lineage.json", { recursive: true, force: true });
  if (graphDbPath && existsSync(graphDbPath)) {
    rmSync(graphDbPath, { recursive: true, force: true });
  }
  graphDbPath = "";
});

describe("graceful database shutdown", () => {
  it("drains accepted default live-index work", async () => {
    await configureDefaultLiveIndexCoordinator({
      debounceMs: 0,
      sweepIntervalMs: 0,
    });
    const coordinator = getDefaultLiveIndexCoordinator();
    const parseEntered = deferred();
    const releaseParse = deferred();
    const internals = coordinator as unknown as {
      loadRepoRoot: (repoId: string) => Promise<string>;
    };
    internals.loadRepoRoot = async () => {
      parseEntered.resolve();
      await releaseParse.promise;
      return process.cwd();
    };
    await coordinator.pushBufferUpdate({
      repoId: "shutdown-live-index",
      eventType: "change",
      filePath: "src/example.ts",
      content: "export const value = 1;",
      language: "typescript",
      version: 1,
      dirty: true,
      timestamp: "2026-03-07T12:00:00.000Z",
    });
    await parseEntered.promise;

    let drainSettled = false;
    const draining = drainLadybugWork({
      dispatchTimeoutMs: 2_000,
      pollMs: 0,
    }).then(() => {
      drainSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drainSettled, false);

    releaseParse.resolve();
    await draining;
  });

  it("drains accepted work without closing the database and is repeatable", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-work-drain-"));
    await initLadybugDb(graphDbPath);
    configureToolDispatchLimiter({ maxConcurrency: 1, queueTimeoutMs: 1_000 });
    const entered = deferred();
    const release = deferred();
    let drainSettled = false;
    const foreground = runToolDispatch(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const draining = drainLadybugWork({
      dispatchTimeoutMs: 2_000,
      pollMs: 2,
    }).then(() => {
      drainSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(drainSettled, false);

    release.resolve();
    await foreground;
    await draining;
    assert.notStrictEqual(getLadybugDbPath(), null);

    await drainLadybugWork({ dispatchTimeoutMs: 2_000, pollMs: 2 });
    assert.notStrictEqual(getLadybugDbPath(), null);
    await closeLadybugDbAfterDrainingWork({
      dispatchTimeoutMs: 2_000,
      pollMs: 2,
    });
    assert.strictEqual(getLadybugDbPath(), null);
  });

  it("waits for indexing launched as an accepted dispatch releases", async () => {
    configureToolDispatchLimiter({ maxConcurrency: 1, queueTimeoutMs: 1_000 });
    const dispatchEntered = deferred();
    const dispatchWaitEntered = deferred();
    const dispatchIdleObserved = deferred();
    const launchIndexing = deferred();
    const indexingEntered = deferred();
    const releaseIndexing = deferred();
    let indexing: Promise<void> | undefined;
    let drainSettled = false;
    let observeDrain = false;
    const limiter = getToolDispatchLimiter();
    const originalGetStats = limiter.getStats;
    limiter.getStats = () => {
      const stats = originalGetStats.call(limiter);
      if (observeDrain && stats.active > 0) dispatchWaitEntered.resolve();
      if (observeDrain && stats.active === 0) dispatchIdleObserved.resolve();
      return stats;
    };
    const dispatch = runToolDispatch(async () => {
      dispatchEntered.resolve();
      await launchIndexing.promise;
      indexing = withIndexingGate(async () => {
        indexingEntered.resolve();
        await releaseIndexing.promise;
      });
    });
    await dispatchEntered.promise;

    observeDrain = true;
    const draining = drainLadybugWork({
      dispatchTimeoutMs: 2_000,
      pollMs: 0,
    }).then(() => {
      drainSettled = true;
    });
    await dispatchWaitEntered.promise;

    launchIndexing.resolve();
    await indexingEntered.promise;
    await dispatch;
    await dispatchIdleObserved.promise;
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(
        drainSettled,
        false,
        "dispatch drain must include detached indexing it admitted",
      );
    } finally {
      releaseIndexing.resolve();
      await indexing;
      await draining;
      limiter.getStats = originalGetStats;
    }
  });

  it("aborts derived work and drains foreground dispatch before closing", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-graceful-db-shutdown-"));
    await initLadybugDb(graphDbPath);
    const repoId = "graceful-shutdown-repo";
    const versionId = "graceful-shutdown-version";
    const refreshEntered = deferred();
    const foregroundEntered = deferred();
    const releaseForeground = deferred();
    let refreshAborted = false;
    let shutdownSettled = false;

    await markDerivedStateDirty(repoId, versionId, {
      clusters: true,
      processes: true,
      algorithms: true,
      summaries: false,
      embeddings: false,
    });
    configureToolDispatchLimiter({ maxConcurrency: 2, queueTimeoutMs: 1_000 });
    _setDerivedRefreshHooksForTesting({
      refresh: async ({ signal }) => {
        refreshEntered.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            refreshAborted = true;
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              refreshAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    enqueueDerivedRefresh(repoId, versionId);
    await refreshEntered.promise;
    const foreground = runToolDispatch(async () => {
      foregroundEntered.resolve();
      await releaseForeground.promise;
    });
    await foregroundEntered.promise;

    const shutdown = closeLadybugDbAfterDrainingWork({
      dispatchTimeoutMs: 2_000,
      pollMs: 5,
    }).then(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(refreshAborted, true, "derived refresh should be aborted");
    assert.strictEqual(
      shutdownSettled,
      false,
      "database close must wait for active foreground dispatch",
    );

    releaseForeground.resolve();
    await foreground;
    await shutdown;
    assert.strictEqual(getLadybugDbPath(), null, "database should close after drain");
  });

  it("fails closed while abort-insensitive derived work remains active", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-stubborn-derived-shutdown-"));
    await initLadybugDb(graphDbPath);
    const entered = deferred();
    const release = deferred();
    await markDerivedStateDirty("stubborn-repo", "v1", { algorithms: true });
    _setDerivedRefreshHooksForTesting({
      refresh: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    enqueueDerivedRefresh("stubborn-repo", "v1");
    await entered.promise;

    try {
      await assert.rejects(
        closeLadybugDbAfterDrainingWork({ dispatchTimeoutMs: 30, pollMs: 2 }),
        /derived refresh/i,
      );
      assert.notStrictEqual(
        getLadybugDbPath(),
        null,
        "database must remain open while underlying refresh work can still write",
      );
    } finally {
      release.resolve();
      await shutdownDerivedRefreshQueue();
    }
  });

  it("fails closed while non-dispatch indexing work remains active", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-active-index-shutdown-"));
    await initLadybugDb(graphDbPath);
    const entered = deferred();
    const release = deferred();
    const indexing = withIndexingGate(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    try {
      await assert.rejects(
        closeLadybugDbAfterDrainingWork({ dispatchTimeoutMs: 30, pollMs: 2 }),
        /indexing/i,
      );
      assert.notStrictEqual(
        getLadybugDbPath(),
        null,
        "database must remain open while indexing work can still write",
      );
    } finally {
      release.resolve();
      await indexing;
    }
  });

  it("serializes WAL checkpoints behind active mutations", async () => {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-checkpoint-serialization-"));
    await initLadybugDb(graphDbPath);
    const writeEntered = deferred();
    const releaseWrite = deferred();
    let checkpointCompleted = false;

    const write = withWriteConn(async () => {
      writeEntered.resolve();
      await releaseWrite.promise;
    });
    await writeEntered.promise;
    const checkpoint = runWalCheckpoint("held-derived-mutation", 2_000).then(
      (result) => {
        checkpointCompleted = true;
        return result;
      },
    );

    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(
        checkpointCompleted,
        false,
        "checkpoint must not overlap the active mutation lease",
      );
    } finally {
      releaseWrite.resolve();
      await write;
    }
    assert.strictEqual(await checkpoint, true);
  });

  it("wires both long-lived entrypoints through the drained close boundary", () => {
    const main = readFileSync(join(process.cwd(), "src/main.ts"), "utf8");
    assert.match(
      main,
      /addCleanup\("graphIntegrityVerifier",[\s\S]*addCleanup\("db", closeLadybugDbAfterDrainingWork\)/,
    );
    const serve = readFileSync(
      join(process.cwd(), "src/cli/commands/serve.ts"),
      "utf8",
    );
    assert.match(
      serve,
      /addCleanup\("graphIntegrityVerifier",[\s\S]*registerServeFinalCleanups\(shutdownMgr/,
    );
  });
});
