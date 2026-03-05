import { describe, it } from "node:test";
import assert from "node:assert";

import { calculateClusterCohesion } from "../../src/graph/score.js";

describe("cluster cohesion scoring", () => {
  it("returns 0 without cluster id", () => {
    const score = calculateClusterCohesion({
      symbolClusterId: null,
      entryClusterIds: new Set(["c1"]),
      relatedClusterIds: new Set(["c2"]),
    });
    assert.strictEqual(score, 0);
  });

  it("applies same-cluster boost", () => {
    const score = calculateClusterCohesion({
      symbolClusterId: "c1",
      entryClusterIds: new Set(["c1"]),
      relatedClusterIds: new Set(["c2"]),
    });
    assert.strictEqual(score, 0.15);
  });

  it("applies related-cluster boost", () => {
    const score = calculateClusterCohesion({
      symbolClusterId: "c2",
      entryClusterIds: new Set(["c1"]),
      relatedClusterIds: new Set(["c2"]),
    });
    assert.strictEqual(score, 0.05);
  });

  it("prioritizes same-cluster over related-cluster", () => {
    const score = calculateClusterCohesion({
      symbolClusterId: "c1",
      entryClusterIds: new Set(["c1"]),
      relatedClusterIds: new Set(["c1"]),
    });
    assert.strictEqual(score, 0.15);
  });
});

