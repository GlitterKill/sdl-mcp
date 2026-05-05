import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BeamExplainStore } from "../../dist/observability/beam-explain-store.js";

function makeEntry(symbolId: string, iteration: number) {
  return {
    symbolId,
    decision: "accepted" as const,
    totalScore: 1,
    components: {
      query: 1,
      stacktrace: 0,
      hotness: 0,
      structure: 0,
      kind: 0,
    },
    why: "test",
    iteration,
    timestamp: 1_700_000_000_000 + iteration,
  };
}

describe("BeamExplainStore", () => {
  it("keeps traces for different repos under separate quotas", () => {
    const store = new BeamExplainStore({
      capacity: 16,
      maxEntriesPerSlice: 8,
    });

    for (let i = 0; i < 16; i++) {
      store.publishTrace({
        repoId: "repo-a",
        sliceHandle: `slice-a-${i}`,
        builtAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        entries: [makeEntry(`sym-a-${i}`, i)],
        edgeWeights: {
          call: 1,
          import: 1,
          config: 1,
          implements: 1,
        },
        thresholds: { sliceScoreThreshold: 0.5, maxFrontier: 32 },
        truncated: false,
      });
    }

    store.publishTrace({
      repoId: "repo-b",
      sliceHandle: "slice-b-0",
      builtAt: new Date(1_700_000_020_000).toISOString(),
      entries: [makeEntry("sym-b-0", 0)],
      edgeWeights: {
        call: 1,
        import: 1,
        config: 1,
        implements: 1,
      },
      thresholds: { sliceScoreThreshold: 0.5, maxFrontier: 32 },
      truncated: false,
    });

    assert.strictEqual(store.size(), 9);
    assert.strictEqual(store.get("repo-a", "slice-a-0"), null);
    assert.ok(store.get("repo-a", "slice-a-15"));
    assert.ok(store.get("repo-b", "slice-b-0"));
  });
});
