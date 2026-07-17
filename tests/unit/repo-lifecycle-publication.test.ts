import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { symbolCardCache } from "../../dist/graph/cache.js";
import {
  clearGraphSnapshots,
  getGraphSnapshot,
  setGraphSnapshot,
} from "../../dist/graph/graphSnapshotCache.js";
import {
  clearSliceCache,
  getCachedSlice,
  getSliceCacheKey,
  setCachedSlice,
} from "../../dist/graph/sliceCache.js";
import {
  getPrefetchOutcomeSampleCount,
  recordPrefetchOutcome,
  resetPrefetchOutcomeStateForTests,
} from "../../dist/graph/prefetch-outcomes.js";
import {
  beginRepoRemoval,
  captureActiveRepoEpoch,
  resetRepoLifecycleForTests,
} from "../../dist/services/repo-lifecycle.js";
import {
  _setResponseArtifactBeforePublishForTesting,
  maybeStoreLargeResponse,
} from "../../dist/runtime/response-artifacts.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeGraph(repoId: string) {
  return {
    repoId,
    symbols: new Map(),
    edges: [],
    adjacencyOut: new Map(),
    adjacencyIn: new Map(),
    clusters: new Map(),
  } as never;
}

async function tombstone(repoId: string): Promise<void> {
  const removal = await beginRepoRemoval(repoId);
  removal.commitTombstone();
}

describe("repository epoch publication fences", () => {
  beforeEach(() => {
    resetRepoLifecycleForTests();
    clearGraphSnapshots();
    symbolCardCache.clear();
    clearSliceCache();
    resetPrefetchOutcomeStateForTests();
    _setResponseArtifactBeforePublishForTesting();
  });

  it("does not repopulate graph, card, or slice caches after tombstoning", async () => {
    const repoId = "cache-race";
    const epoch = captureActiveRepoEpoch(repoId)!;
    const release = deferred();
    const graphPublish = release.promise.then(() =>
      setGraphSnapshot(repoId, fakeGraph(repoId), epoch),
    );
    const cardPublish = release.promise.then(() =>
      symbolCardCache.set(
        repoId,
        "symbol",
        "v1",
        { repoId, symbolId: "symbol" } as never,
        epoch,
      ),
    );
    const sliceKey = getSliceCacheKey({ repoId, versionId: "v1" });
    const slicePublish = release.promise.then(() =>
      setCachedSlice(sliceKey, { repoId } as never, epoch),
    );

    await tombstone(repoId);
    release.resolve();
    await Promise.all([graphPublish, cardPublish, slicePublish]);

    assert.strictEqual(getGraphSnapshot(repoId), null);
    assert.strictEqual(symbolCardCache.get(repoId, "symbol", "v1"), undefined);
    assert.strictEqual(getCachedSlice(sliceKey), null);
  });

  it("does not publish prefetch outcomes from a stale producer", async () => {
    const repoId = "prefetch-race";
    const epoch = captureActiveRepoEpoch(repoId)!;
    const release = deferred();
    const publish = release.promise.then(() =>
      recordPrefetchOutcome(
        {
          repoId,
          strategy: "test",
          resourceKind: "card",
          resourceKey: "symbol",
          outcome: "offered",
          persist: false,
        },
        epoch,
      ),
    );

    await tombstone(repoId);
    release.resolve();
    await publish;

    assert.strictEqual(getPrefetchOutcomeSampleCount(repoId), 0);
  });

  it("removes a response artifact whose producer crosses tombstoning", async () => {
    const repoId = "artifact-race";
    const artifactBaseDir = mkdtempSync(join(tmpdir(), "sdl-artifact-race-"));
    const entered = deferred();
    const release = deferred();
    _setResponseArtifactBeforePublishForTesting(async () => {
      entered.resolve();
      await release.promise;
    });

    try {
      const store = maybeStoreLargeResponse({
        repoId,
        toolName: "test.race",
        payload: { value: "stale" },
        responseMode: "handle",
        artifactBaseDir,
      });
      await entered.promise;
      await tombstone(repoId);
      release.resolve();

      await assert.rejects(
        () => store,
        (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
      );
    } finally {
      _setResponseArtifactBeforePublishForTesting();
      rmSync(artifactBaseDir, { recursive: true, force: true });
    }
  });
});
