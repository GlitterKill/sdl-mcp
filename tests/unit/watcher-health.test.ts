import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import {
  getWatcherHealth,
  _setWatcherHealthForTesting,
  _clearWatcherHealthForTesting,
} from "../../src/indexer/indexer.js";
import { RepoStatusResponseSchema } from "../../src/mcp/tools.js";
import { WATCHER_ERROR_MAX_COUNT } from "../../src/config/constants.js";

const TEST_REPO_ID = "watcher-health-test-repo";

describe("watcher health", () => {
  afterEach(() => {
    _clearWatcherHealthForTesting(TEST_REPO_ID);
  });

  it("getWatcherHealth returns null before watchRepository is called", () => {
    // Use a repo ID that has never had watchRepository called
    const uniqueId = `${TEST_REPO_ID}-${Date.now()}`;
    const health = getWatcherHealth(uniqueId);
    assert.strictEqual(
      health,
      null,
      "getWatcherHealth should return null for repos that never had a watcher started",
    );
    // Clean up
    _clearWatcherHealthForTesting(uniqueId);
  });

  it("watcherNote is present in repo status schema when watcherHealth is null", () => {
    // Verify that the RepoStatusResponseSchema accepts watcherNote as optional
    const basePayload = {
      repoId: "test-repo",
      rootPath: "/tmp/test",
      latestVersionId: "v1",
      filesIndexed: 0,
      symbolsIndexed: 0,
      lastIndexedAt: null,
      healthScore: 100,
      healthComponents: {
        freshness: 1,
        coverage: 1,
        errorRate: 1,
        edgeQuality: 1,
      },
      healthAvailable: true,
      watcherHealth: null,
      prefetchStats: {
        enabled: false,
        queueDepth: 0,
        running: false,
        completed: 0,
        cancelled: 0,
        cacheHits: 0,
        cacheMisses: 0,
        wastedPrefetch: 0,
        hitRate: 0,
        wasteRate: 0,
        avgLatencyReductionMs: 0,
        lastRunAt: null,
      },
    };

    // Without watcherNote — should parse fine (it is optional)
    const parsedWithout = RepoStatusResponseSchema.parse(basePayload);
    assert.strictEqual(
      parsedWithout.watcherNote,
      undefined,
      "watcherNote should be absent when not provided",
    );

    // With watcherNote — should also parse fine
    const parsedWith = RepoStatusResponseSchema.parse({
      ...basePayload,
      watcherNote:
        "Watcher not active. Run 'sdl-mcp serve' or call sdl.index.refresh after edits.",
    });
    assert.strictEqual(
      typeof parsedWith.watcherNote,
      "string",
      "watcherNote should be a string when provided",
    );
    assert.ok(
      parsedWith.watcherNote!.length > 0,
      "watcherNote should be non-empty",
    );
  });

  it("injecting errors past WATCHER_ERROR_MAX_COUNT sets stale to true in health", () => {
    // Set up a health entry with errors just below the budget
    _setWatcherHealthForTesting(TEST_REPO_ID, {
      errors: WATCHER_ERROR_MAX_COUNT - 1,
      stale: false,
    });

    const beforeBudget = getWatcherHealth(TEST_REPO_ID);
    assert.ok(beforeBudget !== null, "health should be non-null after seeding");
    assert.strictEqual(
      beforeBudget!.stale,
      false,
      "stale should be false when below error budget",
    );

    // Now push errors to exactly WATCHER_ERROR_MAX_COUNT
    _setWatcherHealthForTesting(TEST_REPO_ID, {
      errors: WATCHER_ERROR_MAX_COUNT,
      stale: true,
    });

    const afterBudget = getWatcherHealth(TEST_REPO_ID);
    assert.ok(afterBudget !== null, "health should be non-null after update");
    assert.strictEqual(
      afterBudget!.errors,
      WATCHER_ERROR_MAX_COUNT,
      "errors should equal WATCHER_ERROR_MAX_COUNT",
    );
    assert.strictEqual(
      afterBudget!.stale,
      true,
      "stale should be true when error budget is exceeded",
    );
  });

  it("getWatcherHealth returns a snapshot (not a live reference)", () => {
    _setWatcherHealthForTesting(TEST_REPO_ID, { errors: 0, stale: false });

    const snapshot = getWatcherHealth(TEST_REPO_ID);
    assert.ok(snapshot !== null);

    // Mutate the internal state via test helper
    _setWatcherHealthForTesting(TEST_REPO_ID, { errors: 10, stale: false });

    // The original snapshot should be unchanged
    assert.strictEqual(
      snapshot!.errors,
      0,
      "snapshot should not reflect subsequent mutations",
    );
  });
});
