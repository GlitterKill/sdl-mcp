import assert from "node:assert";
import { describe, it } from "node:test";

import {
  RepoUnregisterRequestSchema,
  RepoUnregisterResponseSchema,
} from "../../dist/mcp/tools.js";
import { RepoGatewaySchema, REPO_ACTIONS } from "../../dist/gateway/schemas.js";
import { InMemoryLiveIndexCoordinator } from "../../dist/live-index/coordinator.js";
import { symbolCardCache } from "../../dist/graph/cache.js";
import {
  getCachedSlice,
  getSliceCacheKey,
  invalidateRepoSliceCache,
  setCachedSlice,
} from "../../dist/graph/sliceCache.js";
import { invalidateRepoPrefetch } from "../../dist/graph/prefetch.js";
import {
  getPrefetchOutcomeSampleCount,
  recordPrefetchOutcome,
  resetPrefetchOutcomeStateForTests,
} from "../../dist/graph/prefetch-outcomes.js";

describe("repo.unregister contract", () => {
  it("requires exact confirmation and defaults draft discard off", () => {
    const parsed = RepoUnregisterRequestSchema.parse({
      repoId: "runtime-repo",
      confirmRepoId: "runtime-repo",
    });

    assert.deepStrictEqual(parsed, {
      repoId: "runtime-repo",
      confirmRepoId: "runtime-repo",
      discardDrafts: false,
    });
    assert.strictEqual(
      RepoUnregisterRequestSchema.safeParse({
        repoId: "runtime-repo",
        confirmRepoId: "other-repo",
      }).success,
      true,
      "schema accepts the two values so the handler can return one stable confirmation error",
    );
  });

  it("publishes the destructive action on the repository gateway", () => {
    const parsed = RepoGatewaySchema.parse({
      repoId: "runtime-repo",
      action: "repo.unregister",
      confirmRepoId: "runtime-repo",
    });

    assert.strictEqual(parsed.action, "repo.unregister");
    assert.ok(REPO_ACTIONS.includes("repo.unregister"));
  });

  it("keeps the response shape minimal and deterministic", () => {
    const parsed = RepoUnregisterResponseSchema.parse({
      ok: true,
      repoId: "runtime-repo",
      removed: true,
    });

    assert.deepStrictEqual(parsed, {
      ok: true,
      repoId: "runtime-repo",
      removed: true,
    });
  });

  it("clears only the selected repository from live-index state", async () => {
    const coordinator = new InMemoryLiveIndexCoordinator({
      debounceMs: 60_000,
      sweepIntervalMs: 0,
    });
    const timestamp = "2026-07-17T00:00:00.000Z";

    try {
      await coordinator.pushBufferUpdate({
        repoId: "remove-me",
        eventType: "change",
        filePath: "src/remove.ts",
        content: "export const removeMe = true;",
        version: 1,
        dirty: true,
        timestamp,
      });
      await coordinator.pushBufferUpdate({
        repoId: "keep-me",
        eventType: "change",
        filePath: "src/keep.ts",
        content: "export const keepMe = true;",
        version: 1,
        dirty: true,
        timestamp,
      });
      await coordinator.pushBufferUpdate({
        repoId: "remove-me:child",
        eventType: "change",
        filePath: "src/child.ts",
        content: "export const child = true;",
        version: 1,
        dirty: true,
        timestamp,
      });

      await coordinator.clearRepo("remove-me");

      assert.strictEqual((await coordinator.getLiveStatus("remove-me")).pendingBuffers, 0);
      assert.strictEqual((await coordinator.getLiveStatus("keep-me")).pendingBuffers, 1);
      assert.strictEqual(
        (await coordinator.getLiveStatus("remove-me:child")).pendingBuffers,
        1,
      );
    } finally {
      coordinator.reset();
    }
  });

  it("does not invalidate delimiter-prefixed card and slice cache owners", async () => {
    await symbolCardCache.set("repo", "symbol", "v1", { repoId: "repo" } as never);
    await symbolCardCache.set("repo:child", "symbol", "v1", {
      repoId: "repo:child",
    } as never);
    const targetSlice = getSliceCacheKey({ repoId: "repo", versionId: "v1" });
    const childSlice = getSliceCacheKey({ repoId: "repo:child", versionId: "v1" });
    setCachedSlice(targetSlice, { repoId: "repo" } as never);
    setCachedSlice(childSlice, { repoId: "repo:child" } as never);

    symbolCardCache.invalidateRepo("repo");
    invalidateRepoSliceCache("repo");

    assert.strictEqual(symbolCardCache.get("repo", "symbol", "v1"), undefined);
    assert.ok(symbolCardCache.get("repo:child", "symbol", "v1"));
    assert.strictEqual(getCachedSlice(targetSlice), null);
    assert.ok(getCachedSlice(childSlice));
  });

  it("clears repository-scoped prefetch learning without touching another repo", () => {
    resetPrefetchOutcomeStateForTests();
    recordPrefetchOutcome({
      repoId: "repo",
      strategy: "test",
      resourceKind: "card",
      resourceKey: "target",
      outcome: "offered",
      persist: false,
    });
    recordPrefetchOutcome({
      repoId: "repo:child",
      strategy: "test",
      resourceKind: "card",
      resourceKey: "child",
      outcome: "offered",
      persist: false,
    });

    invalidateRepoPrefetch("repo");

    assert.strictEqual(getPrefetchOutcomeSampleCount("repo"), 0);
    assert.strictEqual(getPrefetchOutcomeSampleCount("repo:child"), 1);
    resetPrefetchOutcomeStateForTests();
  });
});
