import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  configurePrefetchPolicy,
  getPrefetchPolicyAggregate,
  getPrefetchPolicyDecision,
  getTopPrefetchStrategySummaries,
  recordPrefetchOutcome,
  resetPrefetchOutcomeStateForTests,
} from "../../dist/graph/prefetch-outcomes.js";
import { upsertPrefetchOutcomeAndAggregate } from "../../dist/db/ladybug-prefetch-outcomes.js";
import type { Connection } from "kuzu";

const BASE = {
  repoId: "repo-a",
  taskType: "implement",
  clientKey: "client-a",
  strategy: "search-cards",
  resourceKind: "card" as const,
  resourceKey: "card:symbol-a",
};

function makeQueryResult(): {
  getAll: () => Promise<unknown[]>;
  close: () => void;
} {
  return {
    getAll: async () => [],
    close: () => {},
  };
}

describe("prefetch outcome policy", () => {
  beforeEach(() => {
    resetPrefetchOutcomeStateForTests();
    configurePrefetchPolicy({
      enabled: true,
      mode: "safe",
      minSamples: 3,
      boostHitRate: 0.35,
      suppressionWasteRate: 0.8,
      retentionDays: 14,
    });
  });

  it("aggregates offered, used, accepted, and wasted outcomes once", () => {
    recordPrefetchOutcome({ ...BASE, outcome: "offered" });
    recordPrefetchOutcome({
      ...BASE,
      outcome: "used",
      latencySavedMs: 35,
      tokensSavedEstimate: 120,
    });
    recordPrefetchOutcome({ ...BASE, outcome: "accepted" });
    recordPrefetchOutcome({
      ...BASE,
      outcome: "wasted",
      resourceKey: "card:symbol-b",
    });

    const aggregate = getPrefetchPolicyAggregate(BASE);
    assert.ok(aggregate);
    assert.equal(aggregate.offered, 1);
    assert.equal(aggregate.used, 1);
    assert.equal(aggregate.accepted, 1);
    assert.equal(aggregate.wasted, 1);
    assert.equal(aggregate.latencySavedMs, 35);
    assert.equal(aggregate.tokensSavedEstimate, 120);
    assert.ok(aggregate.score > 0);
  });

  it("persists outcome rows and policy aggregates in one transaction", async () => {
    const statements: string[] = [];
    const conn = {
      prepare: async (statement: string) => statement,
      execute: async (prepared: unknown) => {
        statements.push(String(prepared));
        return makeQueryResult();
      },
    } as unknown as Connection;

    await upsertPrefetchOutcomeAndAggregate(
      conn,
      {
        outcomeId: "outcome-1",
        prefetchId: "prefetch-1",
        aggregateKey: "repo-a|implement|client-a|search-cards|card",
        repoId: "repo-a",
        taskType: "implement",
        clientKey: "client-a",
        strategy: "search-cards",
        resourceKind: "card",
        resourceKey: "card:symbol-a",
        outcome: "offered",
        latencySavedMs: 0,
        tokensSavedEstimate: 0,
        plannedCost: 200,
        createdAt: "2026-05-19T00:00:00.000Z",
      },
      {
        aggregateKey: "repo-a|implement|client-a|search-cards|card",
        repoId: "repo-a",
        taskType: "implement",
        clientKey: "client-a",
        strategy: "search-cards",
        resourceKind: "card",
        offered: 1,
        used: 0,
        accepted: 0,
        wasted: 0,
        suppressed: 0,
        latencySavedMs: 0,
        tokensSavedEstimate: 0,
        score: 0,
        scoreEwma: 0,
        hitRateEwma: 0,
        acceptedRateEwma: 0,
        wasteRateEwma: 0,
        ewmaSamples: 0,
        lastOutcomeAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
      },
    );

    assert.equal(statements[0], "BEGIN TRANSACTION");
    assert.match(statements[1], /MERGE \(p:PrefetchOutcome/);
    assert.match(statements[2], /MERGE \(p:PrefetchPolicyAggregate/);
    assert.equal(statements[3], "COMMIT");
  });

  it("counts repeated prefetches of the same resource as separate samples", () => {
    for (let i = 0; i < 3; i++) {
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `prefetch-${i}`,
        outcome: "offered",
      });
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `prefetch-${i}`,
        outcome: "used",
      });
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `prefetch-${i}`,
        outcome: "accepted",
      });
    }

    const aggregate = getPrefetchPolicyAggregate(BASE);
    assert.ok(aggregate);
    assert.equal(aggregate.offered, 3);
    assert.equal(aggregate.used, 3);
    assert.equal(aggregate.accepted, 3);
    assert.equal(getPrefetchPolicyDecision(BASE).reason, "boosted-positive-outcomes");
  });

  it("dedupes repeated terminal outcomes for the same prefetch entry", () => {
    recordPrefetchOutcome({
      ...BASE,
      prefetchId: "prefetch-dup",
      outcome: "offered",
    });
    recordPrefetchOutcome({
      ...BASE,
      prefetchId: "prefetch-dup",
      outcome: "wasted",
    });
    recordPrefetchOutcome({
      ...BASE,
      prefetchId: "prefetch-dup",
      outcome: "wasted",
    });

    const aggregate = getPrefetchPolicyAggregate(BASE);
    assert.ok(aggregate);
    assert.equal(aggregate.offered, 1);
    assert.equal(aggregate.wasted, 1);
  });

  it("lets recent useful outcomes recover a high-waste policy through EWMA", () => {
    for (let i = 0; i < 3; i++) {
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `waste-${i}`,
        resourceKey: "card:hot",
        outcome: "offered",
      });
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `waste-${i}`,
        resourceKey: "card:hot",
        outcome: "wasted",
      });
    }

    assert.equal(getPrefetchPolicyDecision(BASE).allowed, false);

    for (let i = 0; i < 3; i++) {
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `hit-${i}`,
        resourceKey: "card:hot",
        outcome: "offered",
      });
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `hit-${i}`,
        resourceKey: "card:hot",
        outcome: "used",
      });
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `hit-${i}`,
        resourceKey: "card:hot",
        outcome: "accepted",
      });
    }

    const aggregate = getPrefetchPolicyAggregate(BASE);
    assert.ok(aggregate);
    assert.ok(aggregate.scoreEwma > 0);
    assert.equal(getPrefetchPolicyDecision(BASE).allowed, true);
  });

  it("does not let outcomes beyond retention keep suppressing a strategy", () => {
    configurePrefetchPolicy({
      enabled: true,
      mode: "safe",
      minSamples: 3,
      retentionDays: 1,
      suppressionWasteRate: 0.8,
    });
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();

    for (let i = 0; i < 3; i++) {
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `old-waste-${i}`,
        resourceKey: `card:old-${i}`,
        outcome: "offered",
        createdAt: old,
      });
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `old-waste-${i}`,
        resourceKey: `card:old-${i}`,
        outcome: "wasted",
        createdAt: old,
      });
    }

    const decision = getPrefetchPolicyDecision(BASE);
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, "insufficient-samples");
  });

  it("does not suppress from old aggregates after a recent retention sweep", () => {
    configurePrefetchPolicy({
      enabled: true,
      mode: "safe",
      minSamples: 3,
      retentionDays: 1,
      suppressionWasteRate: 0.8,
    });
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();

    recordPrefetchOutcome({
      ...BASE,
      prefetchId: "sweep-primer",
      resourceKey: "card:sweep-primer",
      outcome: "offered",
      createdAt: old,
    });

    for (let i = 0; i < 3; i++) {
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `post-sweep-old-waste-${i}`,
        resourceKey: `card:post-sweep-old-${i}`,
        outcome: "offered",
        createdAt: old,
      });
      recordPrefetchOutcome({
        ...BASE,
        prefetchId: `post-sweep-old-waste-${i}`,
        resourceKey: `card:post-sweep-old-${i}`,
        outcome: "wasted",
        createdAt: old,
      });
    }

    recordPrefetchOutcome({
      ...BASE,
      prefetchId: "fresh-after-old-waste",
      resourceKey: "card:fresh-after-old-waste",
      outcome: "offered",
    });

    const decision = getPrefetchPolicyDecision(BASE);
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, "insufficient-samples");
    assert.equal(getPrefetchPolicyAggregate(BASE)?.offered, 1);
  });

  it("scopes learned policy by repo, task type, and client", () => {
    for (let i = 0; i < 3; i++) {
      recordPrefetchOutcome({
        ...BASE,
        resourceKey: `card:good-${i}`,
        outcome: "offered",
      });
      recordPrefetchOutcome({
        ...BASE,
        resourceKey: `card:good-${i}`,
        outcome: "used",
      });
      recordPrefetchOutcome({
        ...BASE,
        resourceKey: `card:good-${i}`,
        outcome: "accepted",
      });
      recordPrefetchOutcome({
        ...BASE,
        clientKey: "client-b",
        resourceKey: `card:waste-${i}`,
        outcome: "offered",
      });
      recordPrefetchOutcome({
        ...BASE,
        clientKey: "client-b",
        resourceKey: `card:waste-${i}`,
        outcome: "wasted",
      });
    }

    const goodDecision = getPrefetchPolicyDecision(BASE);
    const wasteDecision = getPrefetchPolicyDecision({
      ...BASE,
      clientKey: "client-b",
    });

    assert.equal(goodDecision.allowed, true);
    assert.ok(goodDecision.priorityBoost > 0);
    assert.equal(wasteDecision.allowed, false);
    assert.equal(
      getPrefetchPolicyAggregate({ ...BASE, clientKey: "client-b" })?.used,
      0,
    );
  });

  it("does not suppress strategies before the minimum sample count", () => {
    recordPrefetchOutcome({ ...BASE, outcome: "offered" });
    recordPrefetchOutcome({ ...BASE, outcome: "wasted" });

    const decision = getPrefetchPolicyDecision(BASE);
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, "insufficient-samples");
  });

  it("summarizes the highest impact strategies for status surfaces", () => {
    for (let i = 0; i < 3; i++) {
      recordPrefetchOutcome({
        ...BASE,
        resourceKey: `card:${i}`,
        outcome: "offered",
      });
      recordPrefetchOutcome({
        ...BASE,
        resourceKey: `card:${i}`,
        outcome: "used",
      });
      recordPrefetchOutcome({
        ...BASE,
        resourceKey: `card:${i}`,
        outcome: "accepted",
      });
    }

    const summaries = getTopPrefetchStrategySummaries(BASE.repoId, 3);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].strategy, "search-cards");
    assert.equal(summaries[0].taskType, "implement");
    assert.equal(summaries[0].clientKey, "client-a");
    assert.equal(summaries[0].samples, 3);
    assert.ok(summaries[0].score > 0);
  });
});
