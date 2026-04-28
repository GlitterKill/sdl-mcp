import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePackedSlice } from "../../dist/mcp/wire/packed/index.js";

interface BenchCard {
  symbolId: string;
  repoId: string;
  file: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
  kind: string;
  name: string;
  exported: boolean;
  deps: { imports: string[]; calls: string[] };
  detailLevel: string;
  version: { ledgerVersion: string; astFingerprint: string };
  etag: string;
  summary: string;
}

function makeFixture(
  size: number,
  dirs: number,
): {
  repoId: string;
  versionId: string;
  budget: { maxCards: number; maxEstimatedTokens: number };
  startSymbols: string[];
  symbolIndex: string[];
  cards: BenchCard[];
  edges: Array<[number, number, string, number]>;
} {
  const cards: BenchCard[] = [];
  for (let i = 0; i < size; i++) {
    const dirIdx = i % dirs;
    cards.push({
      symbolId: `sym${i.toString(16).padStart(8, "0")}`,
      repoId: "bench",
      file: `src/components/widgets/dir${dirIdx}/file${i}.ts`,
      range: { startLine: 1, startCol: 0, endLine: 50, endCol: 1 },
      kind: i % 3 === 0 ? "function" : i % 3 === 1 ? "class" : "interface",
      name: `Symbol${i}`,
      exported: i % 2 === 0,
      deps: { imports: [], calls: [] },
      detailLevel: "full",
      version: { ledgerVersion: "v1", astFingerprint: "a".repeat(16) },
      etag: `etag${i}`,
      summary: `Compact summary describing symbol ${i} purpose`,
    });
  }
  const symbolIndex = cards.map((c) => c.symbolId);
  const edges: Array<[number, number, string, number]> = [];
  for (let i = 0; i + 1 < size; i++) {
    edges.push([i, i + 1, "call", 1]);
  }
  return {
    repoId: "bench",
    versionId: "v1",
    budget: { maxCards: size, maxEstimatedTokens: 50000 },
    startSymbols: symbolIndex.slice(0, 1),
    symbolIndex,
    cards,
    edges,
  };
}

test("packed savings ≥ 0.30 on representative slice corpus", () => {
  const sizes = [5, 10, 20, 30, 40, 50, 60, 80, 100, 150];
  const ratios: number[] = [];
  for (const size of sizes) {
    const slice = makeFixture(size, 4);
    const jsonStr = JSON.stringify(slice);
    const packedStr = encodePackedSlice(slice as never);
    const ratio = (jsonStr.length - packedStr.length) / jsonStr.length;
    ratios.push(ratio);
  }
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const min = ratios.reduce((a, b) => Math.min(a, b), Infinity);
  assert.ok(
    mean >= 0.3,
    `Expected mean savings >= 0.30, got ${mean.toFixed(3)} (per-fixture: ${ratios.map((r) => r.toFixed(2)).join(", ")})`,
  );
  assert.ok(
    min >= 0.1,
    `No fixture should regress below 0.10 saved ratio; min=${min.toFixed(3)} (per-fixture: ${ratios.map((r) => r.toFixed(2)).join(", ")})`,
  );
});
