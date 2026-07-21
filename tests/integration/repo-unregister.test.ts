import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { InMemoryLiveIndexCoordinator } from "../../dist/live-index/coordinator.js";
import { handleBufferPush } from "../../dist/mcp/tools/buffer.js";
import { handleResponseGet } from "../../dist/mcp/tools/response.js";
import {
  _hasRepoStatusHealthCacheForTesting,
  _setRepoStatusHealthLoaderForTesting,
  handleRepoRegister,
  handleRepoStatus,
  handleRepoUnregister,
} from "../../dist/mcp/tools/repo.js";
import {
  getGraphSnapshot,
  setGraphSnapshot,
} from "../../dist/graph/graphSnapshotCache.js";
import { buildRepoOverview } from "../../dist/graph/overview.js";
import { symbolCardCache } from "../../dist/graph/cache.js";
import {
  getCachedSlice,
  getSliceCacheKey,
  setCachedSlice,
} from "../../dist/graph/sliceCache.js";
import {
  _setPrefetchEntryCreatedAtForTesting,
  consumePrefetchedKey,
  getPrefetchStats,
} from "../../dist/graph/prefetch.js";
import { recordPrefetchOutcome } from "../../dist/graph/prefetch-outcomes.js";
import {
  captureActiveRepoEpoch,
  resetRepoLifecycleForTests,
  withRepoMutation,
} from "../../dist/services/repo-lifecycle.js";
import {
  _setResponseArtifactRmForTesting,
  maybeStoreLargeResponse,
  readResponseArtifact,
} from "../../dist/runtime/response-artifacts.js";

const originalSdlConfig = process.env.SDL_CONFIG;

describe("repo.unregister integration", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "sdl-repo-unregister-"));
  const dbPath = join(tempRoot, "graph.lbug");
  const configPath = join(tempRoot, "config.json");
  const artifactBaseDir = join(tempRoot, "artifacts");

  function writeConfig(repoIds: string[] = []): void {
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: repoIds.map((repoId) => ({ repoId, rootPath: tempRoot })),
        policy: {},
        runtime: { artifactBaseDir },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();
  }

  async function seedRepo(repoId: string): Promise<void> {
    await withWriteConn((conn) =>
      ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: tempRoot,
        configJson: "{}",
        createdAt: "2026-07-17T00:00:00.000Z",
      }),
    );
  }

  it("cancels graph verification after closing mutation admission and before deleting graph state", () => {
    const source = readFileSync(
      new URL("../../src/mcp/tools/repo.ts", import.meta.url),
      "utf8",
    );
    const begin = source.indexOf("await beginRepoRemoval(repoId)");
    const cancel = source.indexOf(
      "await cancelAndWaitForGraphIntegrityVerifier(repoId)",
      begin,
    );
    const deletion = source.indexOf("await ladybugDb.deleteRepo(writeConn, repoId)", begin);

    assert.ok(begin >= 0 && cancel > begin);
    assert.ok(cancel < deletion, "verification must stop before repository deletion");
  });

  async function waitForRepoInactive(repoId: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (captureActiveRepoEpoch(repoId) !== undefined) {
      assert.ok(Date.now() < deadline, `Timed out waiting for ${repoId} removal`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  before(async () => {
    writeConfig();
    await closeLadybugDb();
    await initLadybugDb(dbPath);
  });

  after(async () => {
    _setRepoStatusHealthLoaderForTesting();
    await closeLadybugDb();
    if (originalSdlConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = originalSdlConfig;
    invalidateConfigCache();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("rejects a mismatched confirmation without mutation", async () => {
    writeConfig();
    await seedRepo("confirmation-repo");

    await assert.rejects(
      () =>
        handleRepoUnregister({
          repoId: "confirmation-repo",
          confirmRepoId: "other-repo",
        }),
      (error: unknown) =>
        (error as { code?: string }).code === "VALIDATION_ERROR",
    );
    assert.ok(await ladybugDb.getRepo(await getLadybugConn(), "confirmation-repo"));
  });

  it("classifies an unknown repo as NOT_FOUND before stale config ownership", async () => {
    writeConfig(["stale-config-repo"]);

    await assert.rejects(
      () =>
        handleRepoUnregister({
          repoId: "stale-config-repo",
          confirmRepoId: "stale-config-repo",
        }),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
  });

  it("rejects config-owned repositories with one SDL_CONFIG instruction and no mutation", async () => {
    await seedRepo("configured-repo");
    writeConfig(["configured-repo"]);

    await assert.rejects(
      () =>
        handleRepoUnregister({
          repoId: "configured-repo",
          confirmRepoId: "configured-repo",
        }),
      (error: unknown) => {
        const typed = error as { code?: string; message?: string };
        assert.strictEqual(typed.code, "CONFIG_ERROR");
        assert.strictEqual((typed.message?.match(/SDL_CONFIG/g) ?? []).length, 2);
        assert.match(typed.message ?? "", /Remove it from SDL_CONFIG before/);
        return true;
      },
    );
    assert.ok(await ladybugDb.getRepo(await getLadybugConn(), "configured-repo"));
  });

  it("serializes concurrent removals so only one reports success", async () => {
    writeConfig();
    await seedRepo("concurrent-repo");

    const results = await Promise.allSettled([
      handleRepoUnregister({
        repoId: "concurrent-repo",
        confirmRepoId: "concurrent-repo",
      }),
      handleRepoUnregister({
        repoId: "concurrent-repo",
        confirmRepoId: "concurrent-repo",
      }),
    ]);

    assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.strictEqual(
      (rejected as PromiseRejectedResult).reason.code,
      "NOT_FOUND",
    );
  });

  it("waits for an accepted push, observes its dirty draft, and rejects later pushes", async () => {
    writeConfig();
    const repoId = "push-removal-race";
    await seedRepo(repoId);
    let dirtyBuffers = 0;
    let releasePush!: () => void;
    let markPushEntered!: () => void;
    const pushEntered = new Promise<void>((resolve) => {
      markPushEntered = resolve;
    });
    const pushBlocked = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    const coordinator = {
      async pushBufferUpdate(input: {
        repoId: string;
        filePath: string;
        version: number;
      }) {
        return withRepoMutation(input.repoId, async () => {
          if (input.filePath === "src/accepted.ts") {
            markPushEntered();
            await pushBlocked;
          }
          dirtyBuffers = 1;
          return {
            accepted: true,
            repoId: input.repoId,
            overlayVersion: input.version,
            parseScheduled: true,
            checkpointScheduled: false,
            warnings: [],
          };
        });
      },
      async getLiveStatus() {
        return { dirtyBuffers };
      },
      async clearRepo() {
        dirtyBuffers = 0;
      },
    };

    const acceptedPush = handleBufferPush(
      {
        repoId,
        eventType: "change",
        filePath: "src/accepted.ts",
        content: "export const accepted = true;",
        version: 1,
        dirty: true,
        timestamp: "2026-07-17T00:00:00.000Z",
      },
      undefined,
      coordinator as never,
    );
    await pushEntered;

    let removalSettled = false;
    const removal = handleRepoUnregister(
      { repoId, confirmRepoId: repoId },
      undefined,
      coordinator as never,
    )
      .then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      )
      .finally(() => {
        removalSettled = true;
      });
    await waitForRepoInactive(repoId);
    assert.strictEqual(removalSettled, false);

    await assert.rejects(
      () =>
        handleBufferPush(
          {
            repoId,
            eventType: "change",
            filePath: "src/late.ts",
            content: "export const late = true;",
            version: 1,
            dirty: true,
            timestamp: "2026-07-17T00:00:00.000Z",
          },
          undefined,
          coordinator as never,
        ),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );

    releasePush();
    await acceptedPush;
    const removalOutcome = await removal;
    assert.strictEqual(
      (removalOutcome.error as { code?: string }).code,
      "VALIDATION_ERROR",
    );
    assert.strictEqual(dirtyBuffers, 1);
    assert.ok(await ladybugDb.getRepo(await getLadybugConn(), repoId));
  });

  it("keeps response handles valid when dirty unregister is rejected", async () => {
    writeConfig();
    const repoId = "dirty-rejection-handle";
    await seedRepo(repoId);
    const artifact = await maybeStoreLargeResponse({
      repoId,
      toolName: "test.dirty-rejection",
      payload: { value: "still-current" },
      responseMode: "handle",
      artifactBaseDir,
    });
    assert.strictEqual(artifact.responseMode, "handle");

    await assert.rejects(
      () =>
        handleRepoUnregister(
          { repoId, confirmRepoId: repoId },
          undefined,
          {
            async getLiveStatus() {
              return { dirtyBuffers: 1 };
            },
          } as never,
        ),
      (error: unknown) => (error as { code?: string }).code === "VALIDATION_ERROR",
    );
    assert.deepStrictEqual(
      (
        await readResponseArtifact({
          repoId,
          handle: artifact.payload.handle,
          artifactBaseDir,
          full: true,
        })
      ).content,
      { value: "still-current" },
    );
  });

  it("keeps response handles valid across registration no-op exits", async () => {
    writeConfig();
    const repoId = "registration-noop-handle";
    const initial = await handleRepoRegister({
      repoId,
      rootPath: tempRoot,
      updateExisting: true,
    });
    assert.strictEqual(initial.ok, true);
    const artifact = await maybeStoreLargeResponse({
      repoId,
      toolName: "test.registration-noop",
      payload: { value: "still-current" },
      responseMode: "handle",
      artifactBaseDir,
    });
    assert.strictEqual(artifact.responseMode, "handle");

    const assertReadable = async (): Promise<void> => {
      assert.deepStrictEqual(
        (
          await readResponseArtifact({
            repoId,
            handle: artifact.payload.handle,
            artifactBaseDir,
            full: true,
          })
        ).content,
        { value: "still-current" },
      );
    };

    const dryRun = await handleRepoRegister({
      repoId,
      rootPath: tempRoot,
      dryRun: true,
    });
    assert.strictEqual(dryRun.dryRun, true);
    await assertReadable();

    const noChange = await handleRepoRegister({ repoId, rootPath: tempRoot });
    assert.strictEqual(noChange.changed, false);
    await assertReadable();

    const updateRefused = await handleRepoRegister({
      repoId,
      rootPath: tempRoot,
      maxFileBytes: 4096,
    });
    assert.strictEqual(updateRefused.ok, false);
    assert.strictEqual(updateRefused.requiresUpdateExisting, true);
    await assertReadable();
  });

  it("keeps response handles valid after a pre-commit unregister error", async () => {
    writeConfig();
    const repoId = "precommit-error-handle";
    await seedRepo(repoId);
    const artifact = await maybeStoreLargeResponse({
      repoId,
      toolName: "test.precommit-error",
      payload: { value: "still-current" },
      responseMode: "handle",
      artifactBaseDir,
    });
    assert.strictEqual(artifact.responseMode, "handle");

    await assert.rejects(
      () =>
        handleRepoUnregister(
          { repoId, confirmRepoId: repoId },
          undefined,
          {
            async getLiveStatus() {
              throw new Error("forced pre-commit failure");
            },
          } as never,
        ),
      /forced pre-commit failure/,
    );
    assert.deepStrictEqual(
      (
        await readResponseArtifact({
          repoId,
          handle: artifact.payload.handle,
          artifactBaseDir,
          full: true,
        })
      ).content,
      { value: "still-current" },
    );
  });

  it("does not reactivate registration beneath an unsettled removal lease", async () => {
    writeConfig();
    const repoId = "register-removal-race";
    await seedRepo(repoId);
    let releaseMutation!: () => void;
    let markMutationEntered!: () => void;
    const mutationEntered = new Promise<void>((resolve) => {
      markMutationEntered = resolve;
    });
    const mutationBlocked = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutation = withRepoMutation(repoId, async () => {
      markMutationEntered();
      await mutationBlocked;
    });
    await mutationEntered;

    const removal = handleRepoUnregister({ repoId, confirmRepoId: repoId });
    await waitForRepoInactive(repoId);

    await assert.rejects(
      () =>
        handleRepoRegister({
          repoId,
          rootPath: tempRoot,
          updateExisting: true,
        }),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );

    releaseMutation();
    await mutation;
    assert.deepStrictEqual(await removal, { ok: true, repoId, removed: true });
    assert.strictEqual(await ladybugDb.getRepo(await getLadybugConn(), repoId), null);

    const registered = await handleRepoRegister({
      repoId,
      rootPath: tempRoot,
      updateExisting: true,
    });
    assert.strictEqual(registered.ok, true);
    assert.ok(await ladybugDb.getRepo(await getLadybugConn(), repoId));
    assert.equal(typeof captureActiveRepoEpoch(repoId), "number");
  });

  it("does not let an in-flight health load repopulate after removal", async () => {
    writeConfig();
    const repoId = "health-publication-race";
    await seedRepo(repoId);
    let releaseHealth!: () => void;
    let markHealthEntered!: () => void;
    const healthEntered = new Promise<void>((resolve) => {
      markHealthEntered = resolve;
    });
    const healthBlocked = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    _setRepoStatusHealthLoaderForTesting(async () => {
      markHealthEntered();
      await healthBlocked;
      return {
        repoId,
        score: 100,
        available: true,
        components: {
          freshness: 1,
          coverage: 1,
          errorRate: 1,
          edgeQuality: 1,
          callResolution: 1,
          embeddingFailures: 0,
        },
        indexedFiles: 0,
        indexedSymbols: 0,
        totalEligibleFiles: 0,
        totalCallEdges: 0,
        resolvedCallEdges: 0,
        minutesSinceLastIndex: 0,
      };
    });

    const status = handleRepoStatus({ repoId, detail: "standard" }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await healthEntered;
    assert.deepStrictEqual(
      await handleRepoUnregister({ repoId, confirmRepoId: repoId }),
      { ok: true, repoId, removed: true },
    );
    releaseHealth();
    await status;

    assert.strictEqual(_hasRepoStatusHealthCacheForTesting(repoId), false);
    _setRepoStatusHealthLoaderForTesting();
  });

  it("keeps a handle denied after restart when physical cleanup fails", async () => {
    writeConfig();
    const repoId = "artifact-cleanup-failure";
    await seedRepo(repoId);
    const artifact = await maybeStoreLargeResponse({
      repoId,
      toolName: "test.cleanup-failure",
      payload: { value: "must-stay-denied" },
      responseMode: "handle",
      artifactBaseDir,
    });
    assert.strictEqual(artifact.responseMode, "handle");

    _setResponseArtifactRmForTesting(
      (async () => {
        throw new Error("forced response artifact cleanup failure");
      }) as never,
    );
    try {
      assert.deepStrictEqual(
        await handleRepoUnregister({ repoId, confirmRepoId: repoId }),
        { ok: true, repoId, removed: true },
      );
      assert.strictEqual(await ladybugDb.getRepo(await getLadybugConn(), repoId), null);

      // Simulate a fresh process: the in-memory epoch returns to zero while the
      // deliberately undeleted manifest remains on disk.
      resetRepoLifecycleForTests();
      assert.deepStrictEqual(
        (
          await readResponseArtifact({
            repoId,
            handle: artifact.payload.handle,
            artifactBaseDir,
            full: true,
          })
        ).content,
        { value: "must-stay-denied" },
      );
      await assert.rejects(
        () =>
          handleResponseGet({
            repoId,
            handle: artifact.payload.handle,
            full: true,
          }),
        (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
      );
    } finally {
      _setResponseArtifactRmForTesting();
    }
  });

  it("requires dirty-buffer opt-in, then clears repo-scoped runtime state", async () => {
    writeConfig();
    const repoId = "runtime-remove";
    const keepRepoId = "runtime-keep";
    await seedRepo(repoId);
    await seedRepo(keepRepoId);
    await withWriteConn(async (conn) => {
      await ladybugDb.upsertFile(conn, {
        fileId: "runtime-remove-file",
        repoId,
        relPath: "src/remove.ts",
        contentHash: "remove-hash",
        language: "typescript",
        byteSize: 1,
        lastIndexedAt: "2026-07-17T00:00:00.000Z",
      });
      await ladybugDb.upsertFile(conn, {
        fileId: "runtime-keep-file",
        repoId: keepRepoId,
        relPath: "src/keep.ts",
        contentHash: "keep-hash",
        language: "typescript",
        byteSize: 1,
        lastIndexedAt: "2026-07-17T00:00:00.000Z",
      });
    });
    _setRepoStatusHealthLoaderForTesting(async (statusRepoId) => ({
      repoId: statusRepoId,
      score: 100,
      available: true,
      components: {
        freshness: 1,
        coverage: 1,
        errorRate: 1,
        edgeQuality: 1,
        callResolution: 1,
        embeddingFailures: 0,
      },
      indexedFiles: 1,
      indexedSymbols: 1,
      totalEligibleFiles: 1,
      totalCallEdges: 0,
      resolvedCallEdges: 0,
      minutesSinceLastIndex: 0,
    }));
    await handleRepoStatus({ repoId, detail: "standard" });
    assert.strictEqual(_hasRepoStatusHealthCacheForTesting(repoId), true);
    const coordinator = new InMemoryLiveIndexCoordinator({
      debounceMs: 60_000,
      sweepIntervalMs: 0,
    });
    await coordinator.pushBufferUpdate({
      repoId,
      eventType: "change",
      filePath: "src/dirty.ts",
      content: "export const dirty = true;",
      version: 1,
      dirty: true,
      timestamp: "2026-07-17T00:00:00.000Z",
    });

    await assert.rejects(
      () =>
        handleRepoUnregister(
          { repoId, confirmRepoId: repoId },
          undefined,
          coordinator,
        ),
      (error: unknown) =>
        (error as { code?: string }).code === "VALIDATION_ERROR",
    );
    assert.ok(await ladybugDb.getRepo(await getLadybugConn(), repoId));

    const fakeGraph = (id: string) => ({
      repoId: id,
      symbols: new Map(),
      edges: [],
      adjacencyOut: new Map(),
      adjacencyIn: new Map(),
      clusters: new Map(),
    });
    setGraphSnapshot(repoId, fakeGraph(repoId) as never);
    setGraphSnapshot(keepRepoId, fakeGraph(keepRepoId) as never);
    assert.strictEqual(
      (await buildRepoOverview({ repoId, level: "stats" })).stats.fileCount,
      1,
    );
    assert.strictEqual(
      (await buildRepoOverview({ repoId: keepRepoId, level: "stats" })).stats
        .fileCount,
      1,
    );
    const targetSliceKey = getSliceCacheKey({ repoId, versionId: "v1" });
    const keepSliceKey = getSliceCacheKey({ repoId: keepRepoId, versionId: "v1" });
    setCachedSlice(targetSliceKey, { repoId } as never);
    setCachedSlice(keepSliceKey, { repoId: keepRepoId } as never);
    await symbolCardCache.set(repoId, "target-symbol", "v1", { repoId } as never);
    await symbolCardCache.set(keepRepoId, "keep-symbol", "v1", { repoId: keepRepoId } as never);
    _setPrefetchEntryCreatedAtForTesting(repoId, "card:target", Date.now());
    _setPrefetchEntryCreatedAtForTesting(keepRepoId, "card:keep", Date.now());
    recordPrefetchOutcome({
      repoId,
      strategy: "test",
      resourceKind: "card",
      resourceKey: "target",
      outcome: "offered",
      persist: false,
    });
    recordPrefetchOutcome({
      repoId: keepRepoId,
      strategy: "test",
      resourceKind: "card",
      resourceKey: "keep",
      outcome: "offered",
      persist: false,
    });
    assert.ok(getPrefetchStats(repoId).outcomeSamples > 0);
    assert.ok(getPrefetchStats(keepRepoId).outcomeSamples > 0);
    const targetArtifact = await maybeStoreLargeResponse({
      repoId,
      toolName: "test.target",
      payload: { value: "target" },
      responseMode: "handle",
      artifactBaseDir,
    });
    const keepArtifact = await maybeStoreLargeResponse({
      repoId: keepRepoId,
      toolName: "test.keep",
      payload: { value: "keep" },
      responseMode: "handle",
      artifactBaseDir,
    });
    assert.strictEqual(targetArtifact.responseMode, "handle");
    assert.strictEqual(keepArtifact.responseMode, "handle");

    const response = await handleRepoUnregister(
      { repoId, confirmRepoId: repoId, discardDrafts: true },
      undefined,
      coordinator,
    );

    assert.deepStrictEqual(response, { ok: true, repoId, removed: true });
    assert.deepStrictEqual(Object.keys(response), ["ok", "repoId", "removed"]);
    assert.strictEqual(await ladybugDb.getRepo(await getLadybugConn(), repoId), null);
    assert.strictEqual((await coordinator.getLiveStatus(repoId)).pendingBuffers, 0);
    assert.strictEqual(_hasRepoStatusHealthCacheForTesting(repoId), false);
    assert.strictEqual(getGraphSnapshot(repoId), null);
    assert.ok(getGraphSnapshot(keepRepoId));
    assert.strictEqual(
      (await buildRepoOverview({ repoId, level: "stats" })).stats.fileCount,
      0,
    );
    assert.strictEqual(
      (await buildRepoOverview({ repoId: keepRepoId, level: "stats" })).stats
        .fileCount,
      1,
    );
    assert.strictEqual(getCachedSlice(targetSliceKey), null);
    assert.ok(getCachedSlice(keepSliceKey));
    assert.strictEqual(symbolCardCache.get(repoId, "target-symbol", "v1"), undefined);
    assert.ok(symbolCardCache.get(keepRepoId, "keep-symbol", "v1"));
    assert.strictEqual(consumePrefetchedKey(repoId, "card:target"), false);
    assert.strictEqual(consumePrefetchedKey(keepRepoId, "card:keep"), true);
    assert.strictEqual(getPrefetchStats(repoId).outcomeSamples, 0);
    assert.deepStrictEqual(getPrefetchStats(repoId).topStrategies, []);
    assert.ok(getPrefetchStats(keepRepoId).outcomeSamples > 0);
    await assert.rejects(() =>
      readResponseArtifact({
        repoId,
        handle: targetArtifact.payload.handle,
        artifactBaseDir,
      }),
    );
    assert.deepStrictEqual(
      (
        await readResponseArtifact({
          repoId: keepRepoId,
          handle: keepArtifact.payload.handle,
          artifactBaseDir,
          full: true,
        })
      ).content,
      { value: "keep" },
    );
    _setRepoStatusHealthLoaderForTesting();
    coordinator.reset();
  });
});
