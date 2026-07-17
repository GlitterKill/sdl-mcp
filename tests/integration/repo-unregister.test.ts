import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import {
  _hasRepoStatusHealthCacheForTesting,
  _setRepoStatusHealthLoaderForTesting,
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
