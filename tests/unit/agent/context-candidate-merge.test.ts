import assert from "node:assert/strict";
import test from "node:test";

import { mergeContextSeedCandidates } from "../../../dist/agent/context-ranking.js";

test("merges duplicate context candidates without losing provenance", () => {
  const merged = mergeContextSeedCandidates([
    {
      contextRef: "symbol:shared",
      source: "semantic",
      score: 0.64,
      rawScore: 0.7,
      sourceRank: 6,
      expandedFrom: "cluster:transport",
      expansionReason: "cluster",
    },
    {
      contextRef: "symbol:shared",
      source: "semantic",
      score: 0.5,
      rawScore: 0.95,
      sourceRank: 1,
      expandedFrom: "cluster:transport",
      expansionReason: "cluster",
    },
    {
      contextRef: "symbol:shared",
      source: "lexical",
      score: 0.4,
      rawScore: 0.3,
      sourceRank: 2,
      provenance: [
        {
          source: "graph",
          score: 0.4,
          rawScore: 0.2,
          sourceRank: 2,
          expandedFrom: "symbol:request",
          expansionReason: "edge",
        },
      ],
    },
    {
      contextRef: "symbol:shared",
      source: "lexical",
      score: 0.8,
      rawScore: 0.9,
      sourceRank: 4,
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.score, 0.8);
  assert.equal(merged[0]?.sourceRank, 2);
  assert.equal(merged[0]?.rawScore, 0.9);
  assert.deepEqual(merged[0]?.provenance, [
    {
      source: "graph",
      score: 0.4,
      rawScore: 0.2,
      sourceRank: 2,
      expandedFrom: "symbol:request",
      expansionReason: "edge",
    },
    {
      source: "lexical",
      score: 0.8,
      rawScore: 0.9,
      sourceRank: 2,
    },
    {
      source: "semantic",
      score: 0.64,
      rawScore: 0.95,
      sourceRank: 1,
      expandedFrom: "cluster:transport",
      expansionReason: "cluster",
    },
  ]);
});
