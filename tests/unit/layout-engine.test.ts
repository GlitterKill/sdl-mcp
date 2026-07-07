import assert from "node:assert";
import { describe, it } from "node:test";

import { computeForceLayout } from "../../dist/graph/layout/force-layout.js";
import { effectiveIterations, planWarmStart } from "../../dist/graph/layout/layout-service.js";
import { fnv1a32, mulberry32 } from "../../dist/graph/layout/prng.js";
import { serializeLayoutResult } from "../../dist/graph/layout/serializer.js";
import type { LayoutInput } from "../../dist/graph/layout/types.js";

const GOLDEN_INPUT: LayoutInput = {
  nodes: Array.from({ length: 12 }, (_, index) => ({ id: "n" + String(index).padStart(2, "0"), size: 1 + (index % 4) })),
  edges: Array.from({ length: 18 }, (_, index) => ({
    from: "n" + String(index % 12).padStart(2, "0"),
    to: "n" + String((index * 5 + 3) % 12).padStart(2, "0"),
    weight: 1 + (index % 3),
  })),
};

const GOLDEN_SNAPSHOT =
  '{"layoutSchemaVersion":1,"seed":2397891364,"iterations":30,"inputHash":"b78386bcbc40156fab1062233a41eed4fe458132f1df827e907a74f0121b1675",' +
  '"positions":[{"id":"n00","x":254.338726,"y":-139.207637,"z":-481.891551},{"id":"n01","x":232.390724,"y":-195.553455,"z":483.921052},' +
  '{"id":"n02","x":261.278456,"y":-186.828979,"z":430.131748},{"id":"n03","x":234.791041,"y":-51.077657,"z":-448.415512},' +
  '{"id":"n04","x":-346.132468,"y":318.957573,"z":7.293654},{"id":"n05","x":-290.685223,"y":351.979656,"z":0.649732},' +
  '{"id":"n06","x":196.713051,"y":-37.929913,"z":-537.04504},{"id":"n07","x":269.168663,"y":-279.77401,"z":425.777737},' +
  '{"id":"n08","x":231.886214,"y":-268.551974,"z":493.879062},{"id":"n09","x":149.763974,"y":-141.852593,"z":-525.403243},' +
  '{"id":"n10","x":-280.265085,"y":334.314919,"z":91.737434},{"id":"n11","x":-350.488815,"y":303.953798,"z":77.290104}]}';

function assertNoNaN(serialized: string): void {
  assert(!serialized.includes("NaN"), "layout output must not contain NaN");
  assert(!serialized.includes("Infinity"), "layout output must not contain Infinity");
}

describe("layout engine", () => {
  it("keeps fnv1a32 and mulberry32 vectors stable", () => {
    assert.equal(fnv1a32(""), 2166136261);
    assert.equal(fnv1a32("sdl-mcp"), 210320563);
    assert.equal(fnv1a32("unicode-🚀"), 1117605722);
    const rng = mulberry32(123456789);
    assert.equal(rng(), 0.2577907438389957);
    assert.equal(rng(), 0.9707721115555614);
    assert.equal(rng(), 0.7853280142880976);
  });

  it("serializes deterministic layout JSON byte-stably", async () => {
    const seed = fnv1a32("golden:layout");
    const first = serializeLayoutResult(await computeForceLayout(GOLDEN_INPUT, seed, 30));
    const second = serializeLayoutResult(await computeForceLayout(GOLDEN_INPUT, seed, 30));
    assert.equal(first, second);
    assert.match(first, /^{"layoutSchemaVersion":1,"seed":/);
    assertNoNaN(first);
  });

  it("matches the committed golden snapshot exactly", async () => {
    const seed = fnv1a32("golden:layout");
    const serialized = serializeLayoutResult(await computeForceLayout(GOLDEN_INPUT, seed, 30));
    assert.equal(serialized, GOLDEN_SNAPSHOT);
  });

  it("produces no NaN for degenerate inputs", async () => {
    const seed = fnv1a32("degenerate");
    const empty = await computeForceLayout({ nodes: [], edges: [] }, seed, 10);
    assert.deepEqual(empty.positions, []);

    const single = await computeForceLayout({ nodes: [{ id: "only", size: 1 }], edges: [] }, seed, 10);
    assertNoNaN(serializeLayoutResult(single));

    const noEdges = await computeForceLayout(
      { nodes: [{ id: "a", size: 1 }, { id: "b", size: 2 }, { id: "c", size: 3 }], edges: [] },
      seed,
      25,
    );
    assertNoNaN(serializeLayoutResult(noEdges));

    const identicalStart = await computeForceLayout(
      {
        nodes: [{ id: "a", size: 1 }, { id: "b", size: 1 }],
        edges: [{ from: "a", to: "b", weight: 1 }],
        initialPositions: { a: { x: 5, y: 5, z: 5 }, b: { x: 5, y: 5, z: 5 } },
      },
      seed,
      25,
    );
    assertNoNaN(serializeLayoutResult(identicalStart));

    const disconnected = await computeForceLayout(
      {
        nodes: [{ id: "a", size: 1 }, { id: "b", size: 1 }, { id: "c", size: 1 }, { id: "d", size: 1 }],
        edges: [{ from: "a", to: "b", weight: 2 }],
      },
      seed,
      25,
    );
    assertNoNaN(serializeLayoutResult(disconnected));

    const unknownEndpoint = await computeForceLayout(
      { nodes: [{ id: "a", size: 1 }], edges: [{ from: "a", to: "ghost", weight: 1 }] },
      seed,
      10,
    );
    assertNoNaN(serializeLayoutResult(unknownEndpoint));
  });

  it("warm-starts incrementally: survivors keep positions, newcomers spawn near the centroid", async () => {
    const seed = fnv1a32("warm-start");
    const base = await computeForceLayout(GOLDEN_INPUT, seed, 30);
    const cached = {
      result: base,
      inputSizes: Object.fromEntries(GOLDEN_INPUT.nodes.map((node) => [node.id, node.size])),
    };
    const grown: LayoutInput = {
      nodes: [...GOLDEN_INPUT.nodes, { id: "n12", size: 2 }],
      edges: [...GOLDEN_INPUT.edges, { from: "n12", to: "n00", weight: 1 }],
    };
    const plan = planWarmStart(cached, grown, seed, 30);
    assert(plan, "warm start plan expected when survivors exist");
    assert.equal(plan.iterations, 15);
    for (const position of base.positions) {
      assert.deepEqual(plan.initialPositions[position.id], { x: position.x, y: position.y, z: position.z });
    }
    const cx = base.positions.reduce((sum, p) => sum + p.x, 0) / base.positions.length;
    const cy = base.positions.reduce((sum, p) => sum + p.y, 0) / base.positions.length;
    const cz = base.positions.reduce((sum, p) => sum + p.z, 0) / base.positions.length;
    const spawned = plan.initialPositions.n12;
    assert(Math.abs(spawned.x - cx) <= 20.000001);
    assert(Math.abs(spawned.y - cy) <= 20.000001);
    assert(Math.abs(spawned.z - cz) <= 20.000001);

    // Warm-started layout keeps surviving nodes near their cached positions.
    const warm = await computeForceLayout(
      { ...grown, initialPositions: plan.initialPositions },
      seed,
      plan.iterations,
    );
    const before = new Map(base.positions.map((p) => [p.id, p]));
    let maxDrift = 0;
    for (const position of warm.positions) {
      const prev = before.get(position.id);
      if (!prev) continue;
      maxDrift = Math.max(
        maxDrift,
        Math.hypot(position.x - prev.x, position.y - prev.y, position.z - prev.z),
      );
    }
    const width = Math.max(100, Math.sqrt(grown.nodes.length) * 100);
    assert(maxDrift < width, `warm-start drift ${maxDrift} should stay below layout width ${width}`);
  });

  it("scales iterations down deterministically for large graphs", () => {
    assert.equal(effectiveIterations(100, 300), 300);
    assert.equal(effectiveIterations(1500, 300), 300);
    assert.equal(effectiveIterations(3000, 300), Math.max(50, Math.floor((300 * 1500 * 1500) / (3000 * 3000))));
    assert.equal(effectiveIterations(5000, 300), 50);
    assert.equal(effectiveIterations(20000, 300), 50);
  });

  it("lays out 5,000 nodes / 8,000 edges within the CI bound", async () => {
    const rng = mulberry32(0xfeedf00d);
    const count = 5000;
    const nodes = Array.from({ length: count }, (_, index) => ({
      id: "p" + String(index).padStart(5, "0"),
      size: 1 + Math.floor(rng() * 5),
    }));
    const edges = Array.from({ length: 8000 }, () => {
      const from = Math.floor(rng() * count);
      let to = Math.floor(rng() * count);
      if (to === from) to = (to + 1) % count;
      return { from: nodes[from].id, to: nodes[to].id, weight: 1 };
    });
    const iterations = effectiveIterations(count, 300);
    const startedAt = Date.now();
    const result = await computeForceLayout({ nodes, edges }, fnv1a32("perf-guard"), iterations);
    const elapsedMs = Date.now() - startedAt;
    console.log(`layout perf guard: ${count} nodes / ${edges.length} edges / ${iterations} iterations in ${elapsedMs}ms`);
    assert.equal(result.positions.length, count);
    assert(elapsedMs < 15_000, `tier-2 layout took ${elapsedMs}ms; CI bound is 15000ms`);
  });
});
