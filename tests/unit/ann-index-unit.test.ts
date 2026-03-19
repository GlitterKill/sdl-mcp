import { describe, it } from "node:test";
import assert from "node:assert";

import {
  DEFAULT_ANN_CONFIG,
  HnswIndex,
  type AnnConfig,
} from "../../src/indexer/ann-index.js";

describe("HnswIndex", () => {
  it("starts empty with default constructor", () => {
    const index = new HnswIndex();

    assert.strictEqual(index.size(), 0);
    assert.strictEqual(index.search([1, 0], 5).length, 0);
    assert.strictEqual(index.getVersionHash(), null);
    assert.strictEqual(index.getModel(), null);
    assert.strictEqual(index.getDimension(), 0);
  });

  it("accepts custom AnnConfig and still indexes/searches", () => {
    const config: AnnConfig = {
      ...DEFAULT_ANN_CONFIG,
      m: 4,
      efConstruction: 8,
      efSearch: 4,
      maxElements: 32,
    };
    const index = new HnswIndex(config);
    index.insert("sym-a", [1, 0]);

    const results = index.search([1, 0], 1);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.symbolId, "sym-a");
  });

  it("insert adds a single vector and increments size", () => {
    const index = new HnswIndex();
    index.insert("sym-a", [1, 2, 3]);

    assert.strictEqual(index.size(), 1);
    assert.strictEqual(index.getDimension(), 3);
  });

  it("insert ignores duplicate symbolId", () => {
    const index = new HnswIndex();
    index.insert("sym-a", [1, 0]);
    index.insert("sym-a", [0, 1]);

    assert.strictEqual(index.size(), 1);
    const result = index.search([1, 0], 1);
    assert.strictEqual(result[0]?.symbolId, "sym-a");
    assert.strictEqual(result[0]?.score, 1);
  });

  it("search returns [] for empty index", () => {
    const index = new HnswIndex();
    const results = index.search([0.2, 0.8], 3);

    assert.deepStrictEqual(results, []);
  });

  it("search returns at most k results sorted by score", () => {
    const index = new HnswIndex();
    index.insert("sym-x", [1, 0]);
    index.insert("sym-y", [0.8, 0.2]);
    index.insert("sym-z", [0, 1]);

    const results = index.search([1, 0], 2);
    assert.strictEqual(results.length, 2);
    assert.ok(results[0].score >= results[1].score);
  });

  it("finds the nearest neighbor for a known query", () => {
    const index = new HnswIndex();
    index.insert("origin-x", [1, 0, 0]);
    index.insert("origin-y", [0, 1, 0]);
    index.insert("origin-z", [0, 0, 1]);

    const results = index.search([0.95, 0.05, 0], 1);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.symbolId, "origin-x");
    assert.ok(results[0]?.score !== undefined && results[0].score > 0.95);
  });

  it("tracks dimension from first inserted vector", () => {
    const index = new HnswIndex();
    index.insert("sym-a", [0.5, 0.5, 0.5, 0.5]);
    index.insert("sym-b", [1, 0]);

    assert.strictEqual(index.getDimension(), 4);
  });

  it("supports versionHash and model metadata setters/getters", () => {
    const index = new HnswIndex();
    index.setVersionHash("hash-123");
    index.setModel("mini-embedding-v1");

    assert.strictEqual(index.getVersionHash(), "hash-123");
    assert.strictEqual(index.getModel(), "mini-embedding-v1");
  });

  it("clear resets graph data and metadata", () => {
    const index = new HnswIndex();
    index.insert("sym-a", [1, 0]);
    index.insert("sym-b", [0, 1]);
    index.setVersionHash("hash-123");
    index.setModel("mini-embedding-v1");

    index.clear();

    assert.strictEqual(index.size(), 0);
    assert.deepStrictEqual(index.search([1, 0], 5), []);
    assert.strictEqual(index.getVersionHash(), null);
    assert.strictEqual(index.getModel(), null);
  });
});
