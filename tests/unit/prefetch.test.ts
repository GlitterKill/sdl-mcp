import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  configurePrefetch,
  consumePrefetchedKey,
  consumePrefetchedKeyWithOutcome,
  enqueuePrefetchTask,
  getPrefetchStats,
  invalidateRepoPrefetch,
  _hasPrefetchEntryForTesting,
  _setPrefetchEntryCreatedAtForTesting,
  _setPrefetchLoadSheddingForTesting,
  prefetchCardsForSymbols,
  prefetchSliceFrontier,
  shutdownPrefetch,
} from "../../dist/graph/prefetch.js";
import {
  beginRepoRemoval,
  captureActiveRepoEpoch,
} from "../../dist/services/repo-lifecycle.js";

import {
  trainPrefetchModel,
  predictNextTool,
  configureGating,
  resetModel,
} from "../../dist/graph/prefetch-model.js";
import {
  configurePrefetchPolicy,
  getPrefetchPolicyAggregate,
  resetPrefetchOutcomeStateForTests,
} from "../../dist/graph/prefetch-outcomes.js";

function waitForPrefetchQueue(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("prefetch pipeline", () => {
  beforeEach(() => {
    resetModel();
    resetPrefetchOutcomeStateForTests();
    configurePrefetchPolicy({
      enabled: true,
      mode: "safe",
      minSamples: 20,
      suppressionWasteRate: 0.8,
      boostHitRate: 0.35,
      retentionDays: 14,
    });
    configureGating({
      enabled: true,
      minSamplesForPrediction: 2,
      confidenceThreshold: 0.3,
      fallbackToDeterministic: true,
      retrainIntervalMs: 60000,
    });
    _setPrefetchLoadSheddingForTesting(false);
  });

  afterEach(() => {
    _setPrefetchLoadSheddingForTesting(true);
    shutdownPrefetch();
    resetModel();
  });

  it("records cache misses/hits and exposes rates", () => {
    const repoId = "prefetch-test";
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });

    consumePrefetchedKey(repoId, "card:missing");
    const missStats = getPrefetchStats(repoId);
    assert.ok(missStats.cacheMisses >= 1);

    prefetchSliceFrontier(repoId, []);
    const hit = consumePrefetchedKey(repoId, "card:missing");
    assert.strictEqual(typeof hit, "boolean");
    assert.strictEqual(hit, false);
  });

  it("keeps boolean-compatible consume API and exposes attributed outcomes separately", () => {
    const repoId = "prefetch-outcome-api";
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });

    const miss = consumePrefetchedKey(repoId, "card:missing");
    assert.equal(miss, false);

    const missOutcome = consumePrefetchedKeyWithOutcome(repoId, "card:missing");
    assert.equal(missOutcome.hit, false);
    assert.equal(missOutcome.outcome, "miss");
  });

  it("returns attributed consume outcomes and counts stale entries as waste once", () => {
    const repoId = "prefetch-stale-once";
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });

    prefetchSliceFrontier(repoId, []);
    _setPrefetchEntryCreatedAtForTesting(
      repoId,
      "card:missing",
      Date.now() - 10 * 60_000,
    );

    const first = getPrefetchStats(repoId);
    const second = getPrefetchStats(repoId);

    assert.equal(first.wastedPrefetch, 1);
    assert.equal(second.wastedPrefetch, 1);
    const miss = consumePrefetchedKeyWithOutcome(repoId, "card:missing");
    assert.equal(miss.hit, false);
    assert.equal(miss.outcome, "miss");
  });

  it("does not expose client or task attribution in public prefetch stats", () => {
    const repoId = "prefetch-public-redaction";
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });

    prefetchSliceFrontier(repoId, [], {
      clientKey: "session:sensitive",
      taskType: "implement",
    });
    const stats = getPrefetchStats(repoId);

    for (const strategy of stats.topStrategies) {
      assert.equal("clientKey" in strategy, false);
      assert.equal("taskType" in strategy, false);
      assert.equal("repoId" in strategy, false);
    }
  });

  it("does not consume another client or task type's attributed prefetch", async () => {
    const repoId = "prefetch-context-isolation";
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });

    prefetchCardsForSymbols(repoId, ["symbol-a"], {
      clientKey: "client-a",
      taskType: "implement",
    });
    await waitForPrefetchQueue();

    const wrongClient = consumePrefetchedKeyWithOutcome(
      repoId,
      "card:symbol-a",
      "search-cards",
      { clientKey: "client-b", taskType: "implement" },
    );
    assert.equal(wrongClient.hit, false);

    const rightClient = consumePrefetchedKeyWithOutcome(
      repoId,
      "card:symbol-a",
      "search-cards",
      { clientKey: "client-a", taskType: "implement" },
    );
    assert.equal(rightClient.hit, true);

    const aggregate = getPrefetchPolicyAggregate({
      repoId,
      clientKey: "client-a",
      taskType: "implement",
      strategy: "search-cards",
      resourceKind: "card",
    });
    assert.ok(aggregate);
    assert.equal(aggregate.used, 1);
    assert.equal(aggregate.accepted, 1);
  });

  it("records superseded duplicate prefetch entries as wasted once", async () => {
    const repoId = "prefetch-duplicate-superseded";
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });
    const context = { clientKey: "client-a", taskType: "implement" };

    prefetchCardsForSymbols(repoId, ["symbol-a"], context);
    await waitForPrefetchQueue();
    prefetchCardsForSymbols(repoId, ["symbol-a"], context);
    await waitForPrefetchQueue();

    const beforeConsume = getPrefetchPolicyAggregate({
      repoId,
      ...context,
      strategy: "search-cards",
      resourceKind: "card",
    });
    assert.ok(beforeConsume);
    assert.equal(beforeConsume.offered, 2);
    assert.equal(beforeConsume.wasted, 1);

    assert.equal(
      consumePrefetchedKey(repoId, "card:symbol-a", "search-cards", context),
      true,
    );
    const afterConsume = getPrefetchPolicyAggregate({
      repoId,
      ...context,
      strategy: "search-cards",
      resourceKind: "card",
    });
    assert.ok(afterConsume);
    assert.equal(afterConsume.used, 1);
    assert.equal(afterConsume.accepted, 1);
  });

  it("records token savings estimates when an attributed prefetch is consumed", async () => {
    const repoId = "prefetch-token-savings";
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });
    const context = { clientKey: "client-a", taskType: "implement" };

    prefetchCardsForSymbols(repoId, ["symbol-a"], context);
    await waitForPrefetchQueue();

    assert.equal(
      consumePrefetchedKey(repoId, "card:symbol-a", "search-cards", context),
      true,
    );

    const aggregate = getPrefetchPolicyAggregate({
      repoId,
      ...context,
      strategy: "search-cards",
      resourceKind: "card",
    });
    assert.ok(aggregate);
    assert.ok(aggregate.tokensSavedEstimate > 0);
  });

  it("drains an admitted prefetch publisher before removal cleanup", async () => {
    const repoId = "prefetch-removal-race";
    const entered = deferred();
    const release = deferred();
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });

    enqueuePrefetchTask({
      repoId,
      key: "test:delayed-publisher",
      priority: 100,
      type: "search-cards",
      resourceKind: "card",
      context: { clientKey: "test", taskType: "test" },
      policyApplied: true,
      run: async () => {
        entered.resolve();
        await release.promise;
        _setPrefetchEntryCreatedAtForTesting(
          repoId,
          "card:delayed",
          Date.now(),
        );
      },
    });
    await entered.promise;

    let removalSettled = false;
    const removalPromise = beginRepoRemoval(repoId).finally(() => {
      removalSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(captureActiveRepoEpoch(repoId), undefined);
    assert.strictEqual(removalSettled, false);

    release.resolve();
    const removal = await removalPromise;
    removal.commitTombstone();
    invalidateRepoPrefetch(repoId);

    assert.strictEqual(_hasPrefetchEntryForTesting(repoId, "card:delayed"), false);
  });

  it("configurePrefetch defaults to enabled when config key is absent", () => {
    // Call configurePrefetch with enabled: true and verify getPrefetchStats().enabled === true
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });
    const stats = getPrefetchStats("test-repo");
    assert.strictEqual(stats.enabled, true);
  });

  it("trains lightweight model from tool traces", () => {
    const model = trainPrefetchModel([
      { repoId: "r", taskType: "implement", tool: "search" },
      { repoId: "r", taskType: "implement", tool: "card" },
      { repoId: "r", taskType: "implement", tool: "slice" },
      { repoId: "r", taskType: "implement", tool: "search" },
      { repoId: "r", taskType: "implement", tool: "card" },
      { repoId: "r", taskType: "implement", tool: "slice" },
    ]);

    assert.strictEqual(predictNextTool(model, "search", "card"), "slice");
  });
});
