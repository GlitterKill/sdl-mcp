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
  resetToolDispatchLimiter,
  runToolDispatch,
} from "../../dist/mcp/dispatch-limiter.js";
import { withIndexingGate } from "../../dist/mcp/indexing-gate.js";
import { closeLadybugDbAfterDrainingWork } from "../../dist/startup/graceful-database-shutdown.js";

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
  if (graphDbPath && existsSync(graphDbPath)) {
    rmSync(graphDbPath, { recursive: true, force: true });
  }
  graphDbPath = "";
});

describe("graceful database shutdown", () => {
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
    for (const relativePath of ["src/main.ts", "src/cli/commands/serve.ts"]) {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");
      assert.match(
        source,
        /addCleanup\("graphIntegrityVerifier",[\s\S]*addCleanup\("db", closeLadybugDbAfterDrainingWork\)/,
        relativePath,
      );
    }
  });
});
