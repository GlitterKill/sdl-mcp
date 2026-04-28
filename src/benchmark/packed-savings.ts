/**
 * Benchmark: measure packed wire format byte savings on the indexed corpus.
 *
 * Builds slice fixtures of varying sizes and writes savings ratios to
 * bench-results/packed-savings.json. Used by CI regression to alert when
 * packed encoder savings regress below the 0.30 floor.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodePackedSlice } from "../mcp/wire/packed/index.js";

interface BenchSliceCard {
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
  summary?: string;
}

function makeBenchSlice(
  size: number,
  dirs: number,
): {
  repoId: string;
  versionId: string;
  budget: { maxCards: number; maxEstimatedTokens: number };
  startSymbols: string[];
  symbolIndex: string[];
  cards: BenchSliceCard[];
  edges: Array<[number, number, string, number]>;
} {
  const cards: BenchSliceCard[] = [];
  for (let i = 0; i < size; i++) {
    cards.push({
      symbolId: `s${i.toString(36).padStart(8, "0")}`,
      repoId: "bench",
      file: `src/area${i % dirs}/sub${(i * 7) % dirs}/file${i}.ts`,
      range: { startLine: 1, startCol: 0, endLine: 60, endCol: 1 },
      kind: ["function", "class", "interface", "type"][i % 4],
      name: `Symbol${i}`,
      exported: (i & 1) === 0,
      deps: { imports: [], calls: [] },
      detailLevel: "full",
      version: { ledgerVersion: "v1", astFingerprint: "f".repeat(16) },
      etag: `et${i}`,
      summary: `Summary line for symbol ${i}.`,
    });
  }
  const symbolIndex = cards.map((c) => c.symbolId);
  const edges: Array<[number, number, string, number]> = [];
  for (let i = 0; i + 1 < size; i++) edges.push([i, (i + 1) % size, "call", 1]);
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

interface BenchEntry {
  size: number;
  dirs: number;
  jsonBytes: number;
  packedBytes: number;
  ratio: number;
}

function main(): void {
  const grid = [
    [5, 2],
    [10, 3],
    [25, 4],
    [50, 4],
    [100, 6],
    [200, 8],
    [400, 10],
  ];
  const entries: BenchEntry[] = [];
  for (const [size, dirs] of grid) {
    const slice = makeBenchSlice(size, dirs);
    const jsonStr = JSON.stringify(slice);
    const packedStr = encodePackedSlice(slice as never);
    entries.push({
      size,
      dirs,
      jsonBytes: jsonStr.length,
      packedBytes: packedStr.length,
      ratio: (jsonStr.length - packedStr.length) / jsonStr.length,
    });
  }
  const meanRatio =
    entries.reduce((a, e) => a + e.ratio, 0) / Math.max(1, entries.length);
  const out = { generatedAt: new Date().toISOString(), meanRatio, entries };
  const outPath = join(process.cwd(), "bench-results", "packed-savings.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(
    `packed-savings: meanRatio=${meanRatio.toFixed(3)} -> ${outPath}`,
  );
}

main();
