import { computeForceLayout } from "../../dist/graph/layout/force-layout.js";
import { computeNativeLayoutJson, isNativeLayoutEngineAvailable } from "../../dist/graph/layout/native-engine.js";
import { fnv1a32, mulberry32 } from "../../dist/graph/layout/prng.js";
import { serializeLayoutResult } from "../../dist/graph/layout/serializer.js";
import type { LayoutInput } from "../../dist/graph/layout/types.js";

let passed = 0;
let failed = 0;

function assertEqual(actual: string | null, expected: string, label: string): void {
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    console.error("FAIL: " + label);
    if (actual === null) {
      console.error("  native result: null");
    } else {
      console.error("  expected prefix: " + expected.slice(0, 240));
      console.error("  actual prefix:   " + actual.slice(0, 240));
    }
  }
}

function goldenInput(): LayoutInput {
  return {
    nodes: Array.from({ length: 12 }, (_, index) => ({ id: "n" + String(index).padStart(2, "0"), size: 1 + (index % 4) })),
    edges: Array.from({ length: 18 }, (_, index) => ({
      from: "n" + String(index % 12).padStart(2, "0"),
      to: "n" + String((index * 5 + 3) % 12).padStart(2, "0"),
      weight: 1 + (index % 3),
    })),
  };
}

function generatedInput(count: number): LayoutInput {
  const rng = mulberry32(0xdecafbad);
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: "g" + String(index).padStart(5, "0"),
    size: 1 + Math.floor(rng() * 8),
  }));
  const edges = Array.from({ length: count * 2 }, (_, index) => {
    const from = Math.floor(rng() * count);
    const to = Math.floor(rng() * count);
    return {
      from: nodes[from].id,
      to: nodes[to === from ? (to + 1) % count : to].id,
      weight: 0.5 + Math.floor(rng() * 5),
    };
  });
  return { nodes, edges };
}

async function check(input: LayoutInput, iterations: number, label: string): Promise<void> {
  const seed = fnv1a32(label);
  const expected = serializeLayoutResult(await computeForceLayout(input, seed, iterations));
  const actual = computeNativeLayoutJson(input, seed, iterations);
  assertEqual(actual, expected, label);
}

async function main(): Promise<void> {
  console.log("=== SDL-MCP Layout Parity Tests ===\n");
  const available = isNativeLayoutEngineAvailable();
  console.log("Native layout engine available: " + available);
  if (!available) {
    console.log("\nSkipping layout parity: native addon not built.");
    process.exit(0);
  }

  await check(goldenInput(), 60, "golden-12-node-graph");
  await check(generatedInput(2_000), 8, "generated-2000-node-graph");

  console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
