import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
  pushPpr,
  computePpr,
  _clearPprCache,
  _resetNativeBindingCache,
  DEFAULT_ALPHA,
  DEFAULT_EPSILON,
  DEFAULT_MAX_NODES_TOUCHED,
} from "../../../dist/retrieval/ppr.js";
import type { Graph } from "../../../dist/graph/buildGraph.js";

/**
 * Personalized PageRank unit tests.
 *
 * Covers the JS push backend on a tiny hand-computed graph plus the
 * orchestrator-facing `computePpr` wrapper. Native parity lives in
 * `tests/unit/retrieval/ppr-property.test.ts`.
 *
 * Run: node --import tsx --test tests/unit/retrieval/ppr.test.ts
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Six-node test graph (same topology as native push.rs `six_node_graph`):
 *   0 -> 1, 0 -> 2
 *   1 -> 3
 *   2 -> 3
 *   3 -> 4, 3 -> 5
 */
function sixNodeAdjacency(): Array<Array<[number, number]>> {
  return [
    [
      [1, 1.0],
      [2, 1.0],
    ],
    [[3, 1.0]],
    [[3, 1.0]],
    [
      [4, 1.0],
      [5, 1.0],
    ],
    [],
    [],
  ];
}

function buildMiniGraph(
  ids: string[],
  out: Map<string, Array<{ to: string; weight?: number; confidence?: number }>>,
): Graph {
  const symbols = new Map<string, { symbolId: string }>();
  for (const id of ids) symbols.set(id, { symbolId: id });

  const adjacencyOut = new Map<string, Array<unknown>>();
  const adjacencyIn = new Map<string, Array<unknown>>();
  for (const id of ids) {
    adjacencyOut.set(id, []);
    adjacencyIn.set(id, []);
  }

  for (const [fromId, edges] of out) {
    for (const e of edges) {
      const edge = {
        from_symbol_id: fromId,
        to_symbol_id: e.to,
        weight: e.weight ?? 1.0,
        confidence: e.confidence ?? 1.0,
      };
      adjacencyOut.get(fromId)!.push(edge);
      const inList = adjacencyIn.get(e.to) ?? [];
      inList.push(edge);
      adjacencyIn.set(e.to, inList);
    }
  }

  return {
    repoId: "test-repo" as Graph["repoId"],
    symbols: symbols as Graph["symbols"],
    edges: [] as Graph["edges"],
    adjacencyOut: adjacencyOut as Graph["adjacencyOut"],
    adjacencyIn: adjacencyIn as Graph["adjacencyIn"],
  } as Graph;
}

// ---------------------------------------------------------------------------
// pushPpr (JS backend)
// ---------------------------------------------------------------------------

describe("pushPpr (JS backend)", () => {
  it("dominates seed mass at the source node", () => {
    const adj = sixNodeAdjacency();
    const scores = pushPpr(
      adj,
      [[0, 1.0]],
      DEFAULT_ALPHA,
      DEFAULT_EPSILON,
      DEFAULT_MAX_NODES_TOUCHED,
    );
    assert.ok(scores[0] > 0, "seed node 0 should have non-zero score");
    assert.ok(
      scores[0] >= scores[3],
      `seed (0=${scores[0]}) should >= downstream (3=${scores[3]})`,
    );
  });

  it("yields symmetric scores for symmetric leaves", () => {
    const adj = sixNodeAdjacency();
    const scores = pushPpr(
      adj,
      [[0, 1.0]],
      DEFAULT_ALPHA,
      DEFAULT_EPSILON,
      DEFAULT_MAX_NODES_TOUCHED,
    );
    assert.ok(
      Math.abs(scores[4] - scores[5]) < 1e-9,
      `symmetric leaves should match: 4=${scores[4]} 5=${scores[5]}`,
    );
  });

  it("returns all-zero scores for empty seeds", () => {
    const adj = sixNodeAdjacency();
    const scores = pushPpr(
      adj,
      [],
      DEFAULT_ALPHA,
      DEFAULT_EPSILON,
      DEFAULT_MAX_NODES_TOUCHED,
    );
    for (let i = 0; i < scores.length; i++) {
      assert.equal(scores[i], 0, `node ${i} should have zero score`);
    }
  });

  it("ignores out-of-range seed indices", () => {
    const adj = sixNodeAdjacency();
    const scores = pushPpr(
      adj,
      [[99, 1.0]],
      DEFAULT_ALPHA,
      DEFAULT_EPSILON,
      DEFAULT_MAX_NODES_TOUCHED,
    );
    for (let i = 0; i < scores.length; i++) {
      assert.equal(scores[i], 0);
    }
  });

  it("respects linearity over personalization vector (within 1e-3)", () => {
    const adj = sixNodeAdjacency();
    const a = pushPpr(adj, [[0, 1.0]], 0.15, 1e-4, 2000);
    const b = pushPpr(adj, [[3, 1.0]], 0.15, 1e-4, 2000);
    const combined = pushPpr(
      adj,
      [
        [0, 0.5],
        [3, 0.5],
      ],
      0.15,
      1e-4,
      2000,
    );
    for (let i = 0; i < a.length; i++) {
      const expected = 0.5 * a[i] + 0.5 * b[i];
      assert.ok(
        Math.abs(combined[i] - expected) < 1e-3,
        `linearity at node ${i}: expected=${expected} actual=${combined[i]}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// computePpr (orchestrator-facing wrapper)
// ---------------------------------------------------------------------------

describe("computePpr", () => {
  // Disable native lookup so tests are deterministic in the absence of the addon.
  before(() => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    _resetNativeBindingCache();
    _clearPprCache();
  });

  it("returns empty result for empty seed map", async () => {
    const graph = buildMiniGraph(["a", "b"], new Map());
    const result = await computePpr({
      graph,
      snapshotCreatedAt: 1,
      repoId: "r",
      options: { seeds: new Map() },
    });
    assert.equal(result.scores.size, 0);
    assert.equal(result.touched, 0);
  });

  it("normalizes scores so max equals 1", async () => {
    const graph = buildMiniGraph(
      ["a", "b", "c"],
      new Map([
        ["a", [{ to: "b" }]],
        ["b", [{ to: "c" }]],
      ]),
    );
    const result = await computePpr({
      graph,
      snapshotCreatedAt: 2,
      repoId: "r",
      options: {
        seeds: new Map([["a", 1.0]]),
        direction: "out",
      },
    });
    assert.ok(result.scores.size > 0);
    let max = 0;
    for (const v of result.scores.values()) max = Math.max(max, v);
    assert.ok(Math.abs(max - 1) < 1e-9, `max should be 1, got ${max}`);
  });

  it("falls back to BFS when seed has no outbound edges", async () => {
    // Seed node has no out-edges in direction "out"; should engage BFS fallback.
    const graph = buildMiniGraph(
      ["sink", "downstream"],
      new Map([["downstream", [{ to: "sink" }]]]),
    );
    const result = await computePpr({
      graph,
      snapshotCreatedAt: 3,
      repoId: "r",
      options: {
        seeds: new Map([["sink", 1.0]]),
        direction: "out",
      },
    });
    assert.equal(result.backend, "fallback-bfs");
    assert.ok(result.scores.has("sink"));
  });

  it("seed missing from graph yields empty result without throwing", async () => {
    const graph = buildMiniGraph(["a"], new Map());
    const result = await computePpr({
      graph,
      snapshotCreatedAt: 4,
      repoId: "r",
      options: {
        seeds: new Map([["does-not-exist", 1.0]]),
      },
    });
    assert.equal(result.scores.size, 0);
  });

  it("direction=both unions out and in edges (3-node line graph)", async () => {
    // a -> b -> c, seed at b. direction=both should reach both a and c.
    const graph = buildMiniGraph(
      ["a", "b", "c"],
      new Map([
        ["a", [{ to: "b" }]],
        ["b", [{ to: "c" }]],
      ]),
    );
    const result = await computePpr({
      graph,
      snapshotCreatedAt: 5,
      repoId: "r",
      options: {
        seeds: new Map([["b", 1.0]]),
        direction: "both",
      },
    });
    assert.ok(result.scores.has("a"), "a should be reachable upstream");
    assert.ok(result.scores.has("c"), "c should be reachable downstream");
  });
});


