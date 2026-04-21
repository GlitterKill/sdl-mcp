import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  PlanStore,
  type PlannedFileEdit,
  type PlanPrecondition,
} from "../../dist/mcp/tools/search-edit/plan-store.js";

function makeEdit(rel: string): PlannedFileEdit {
  return {
    relPath: rel,
    absPath: `/tmp/${rel}`,
    newContent: "new",
    createBackup: true,
    fileExists: true,
    indexedSource: false,
    matchCount: 1,
    editMode: "overwrite",
  };
}

function makePrecondition(rel: string): PlanPrecondition {
  return {
    relPath: rel,
    absPath: `/tmp/${rel}`,
    sha256: "a".repeat(64),
    mtimeMs: 1000,
  };
}

describe("search-edit PlanStore", () => {
  const stores: PlanStore[] = [];
  after(() => {
    for (const s of stores) s.clear();
  });

  it("stores and retrieves a plan within TTL", () => {
    let now = 1_000_000;
    const store = new PlanStore({
      ttlMs: 5_000,
      capacity: 4,
      clock: () => now,
    });
    stores.push(store);
    const plan = store.create(
      "repo-a",
      [makeEdit("a.txt")],
      [makePrecondition("a.txt")],
      { filesMatched: 1 },
      true,
    );
    assert.ok(plan.planHandle.startsWith("se-"));
    assert.equal(store.size(), 1);
    const fetched = store.get(plan.planHandle);
    assert.ok(fetched);
    assert.equal(fetched.repoId, "repo-a");
    assert.equal(fetched.defaultCreateBackup, true);
  });

  it("expires plans after TTL", () => {
    let now = 1_000_000;
    const store = new PlanStore({
      ttlMs: 1_000,
      capacity: 4,
      clock: () => now,
    });
    stores.push(store);
    const plan = store.create(
      "repo-a",
      [makeEdit("a.txt")],
      [makePrecondition("a.txt")],
      {},
      false,
    );
    now += 1_001;
    const fetched = store.get(plan.planHandle);
    assert.equal(fetched, null);
    assert.equal(store.size(), 0);
  });

  it("evicts the oldest entry when capacity is reached (LRU on create)", () => {
    let now = 1_000_000;
    const store = new PlanStore({
      ttlMs: 60_000,
      capacity: 2,
      clock: () => now,
    });
    stores.push(store);
    const a = store.create(
      "repo-a",
      [makeEdit("a.txt")],
      [makePrecondition("a.txt")],
      {},
      true,
    );
    now += 10;
    const b = store.create(
      "repo-a",
      [makeEdit("b.txt")],
      [makePrecondition("b.txt")],
      {},
      true,
    );
    now += 10;
    const c = store.create(
      "repo-a",
      [makeEdit("c.txt")],
      [makePrecondition("c.txt")],
      {},
      true,
    );

    assert.equal(store.get(a.planHandle), null, "oldest evicted");
    assert.ok(store.get(b.planHandle));
    assert.ok(store.get(c.planHandle));
    assert.equal(store.size(), 2);
  });

  it("remove() drops a handle regardless of state", () => {
    const store = new PlanStore();
    stores.push(store);
    const plan = store.create(
      "repo-a",
      [makeEdit("a.txt")],
      [makePrecondition("a.txt")],
      {},
      true,
    );
    assert.equal(store.remove(plan.planHandle), true);
    assert.equal(store.remove(plan.planHandle), false);
    assert.equal(store.get(plan.planHandle), null);
  });

  it("clear() wipes all entries", () => {
    const store = new PlanStore();
    stores.push(store);
    store.create(
      "repo-a",
      [makeEdit("a.txt")],
      [makePrecondition("a.txt")],
      {},
      true,
    );
    store.create(
      "repo-b",
      [makeEdit("b.txt")],
      [makePrecondition("b.txt")],
      {},
      true,
    );
    store.clear();
    assert.equal(store.size(), 0);
  });

  it("assigns unique planHandle values across rapid creates", () => {
    const store = new PlanStore();
    stores.push(store);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = store.create(
        "repo-a",
        [makeEdit(`f${i}.txt`)],
        [makePrecondition(`f${i}.txt`)],
        {},
        true,
      );
      assert.ok(!seen.has(p.planHandle), "unique handle");
      seen.add(p.planHandle);
    }
  });

  it("throws when aggregate byte limit exceeded", () => {
    const store = new PlanStore({ capacity: 100 });
    stores.push(store);
    const bigContent = "x".repeat(64 * 1024 * 1024 + 1);
    assert.throws(
      () =>
        store.create(
          "repo-a",
          [{ ...makeEdit("big.txt"), newContent: bigContent }],
          [makePrecondition("big.txt")],
          {},
          true,
        ),
      /aggregate byte limit/,
    );
  });

  it("get() returns null for consumed plans", () => {
    const store = new PlanStore();
    stores.push(store);
    const plan = store.create(
      "repo-a",
      [makeEdit("a.txt")],
      [makePrecondition("a.txt")],
      {},
      true,
    );
    assert.ok(store.get(plan.planHandle), "before consume");
    store.markConsumed(plan.planHandle);
    assert.equal(store.get(plan.planHandle), null, "after consume");
    store.unmarkConsumed(plan.planHandle);
    assert.ok(store.get(plan.planHandle), "after unconsume");
  });

});
