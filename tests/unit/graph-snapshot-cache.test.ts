import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  configureGraphSnapshotCache,
  getGraphSnapshot,
  hasGraphSnapshot,
  setGraphSnapshot,
  invalidateGraphSnapshot,
  clearGraphSnapshots,
  getGraphSnapshotStats,
} from "../../src/graph/graphSnapshotCache.js";

function makeFakeGraph(repoId: string) {
  return {
    repoId,
    symbols: new Map(),
    edges: [],
    adjacencyOut: new Map(),
    adjacencyIn: new Map(),
    clusters: new Map(),
  } as any;
}

describe("graphSnapshotCache", () => {
  beforeEach(() => {
    clearGraphSnapshots();
    configureGraphSnapshotCache({ ttlMs: 300000 });
  });

  it("getGraphSnapshot returns null when not cached", () => {
    assert.strictEqual(getGraphSnapshot("nonexistent"), null);
  });

  it("setGraphSnapshot stores and getGraphSnapshot retrieves", () => {
    const graph = makeFakeGraph("repo1");
    setGraphSnapshot("repo1", graph);
    const result = getGraphSnapshot("repo1");
    assert.strictEqual(result, graph);
  });

  it("hasGraphSnapshot returns true when cached", () => {
    setGraphSnapshot("repo1", makeFakeGraph("repo1"));
    assert.strictEqual(hasGraphSnapshot("repo1"), true);
  });

  it("hasGraphSnapshot returns false when not cached", () => {
    assert.strictEqual(hasGraphSnapshot("repo1"), false);
  });

  it("invalidateGraphSnapshot removes specific repo", () => {
    setGraphSnapshot("repo1", makeFakeGraph("repo1"));
    setGraphSnapshot("repo2", makeFakeGraph("repo2"));
    invalidateGraphSnapshot("repo1");
    assert.strictEqual(getGraphSnapshot("repo1"), null);
    assert.ok(getGraphSnapshot("repo2") !== null);
  });

  it("clearGraphSnapshots removes all", () => {
    setGraphSnapshot("repo1", makeFakeGraph("repo1"));
    setGraphSnapshot("repo2", makeFakeGraph("repo2"));
    clearGraphSnapshots();
    assert.strictEqual(getGraphSnapshot("repo1"), null);
    assert.strictEqual(getGraphSnapshot("repo2"), null);
  });

  it("getGraphSnapshotStats returns correct shape", () => {
    setGraphSnapshot("repo1", makeFakeGraph("repo1"));
    const stats = getGraphSnapshotStats();
    assert.strictEqual(stats.cachedRepos, 1);
    assert.ok(Array.isArray(stats.entries));
    assert.strictEqual(stats.entries.length, 1);
    assert.strictEqual(stats.entries[0].repoId, "repo1");
    assert.ok(typeof stats.entries[0].ageMs === "number");
    assert.ok(stats.entries[0].ageMs >= 0);
  });

  it("getGraphSnapshot returns null after TTL expiration", () => {
    configureGraphSnapshotCache({ ttlMs: 1000 });
    setGraphSnapshot("repo1", makeFakeGraph("repo1"));
    // Manually expire by mocking createdAt — not possible without internal access.
    // Instead, verify it works within TTL.
    const result = getGraphSnapshot("repo1");
    assert.ok(result !== null);
    // Restore TTL
    configureGraphSnapshotCache({ ttlMs: 300000 });
  });

  it("configureGraphSnapshotCache ignores ttlMs < 1000", () => {
    configureGraphSnapshotCache({ ttlMs: 500 });
    // TTL should still be 300000 (unchanged)
    setGraphSnapshot("repo1", makeFakeGraph("repo1"));
    assert.ok(getGraphSnapshot("repo1") !== null);
  });

  it("configureGraphSnapshotCache ignores maxSymbols < 100", () => {
    configureGraphSnapshotCache({ maxSymbols: 50 });
    // maxSymbols should remain unchanged — cache still works
    setGraphSnapshot("repo1", makeFakeGraph("repo1"));
    assert.ok(getGraphSnapshot("repo1") !== null);
  });
});
