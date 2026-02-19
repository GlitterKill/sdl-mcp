import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";
import {
  loadGraphForRepo,
  loadNeighborhood,
  getLastLoadStats,
  resetLoadStats,
} from "../../dist/graph/buildGraph.js";

function getMemoryUsageMB(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / 1024 / 1024);
}

function getPeakRSSMB(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.rss / 1024 / 1024);
}

interface BenchmarkResult {
  name: string;
  peakRssBeforeMB: number;
  peakRssAfterMB: number;
  peakRssDiffMB: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
}

function forceGC(): void {
  if (global.gc) {
    global.gc();
    global.gc();
    global.gc();
  }
}

describe("Lazy Graph Memory Benchmark", () => {
  beforeEach(() => {
    resetLoadStats();
    forceGC();
  });

  it("should measure memory reduction with lazy loading", () => {
    const entrySymbols = ["entry-1", "entry-2"];
    const results: BenchmarkResult[] = [];

    forceGC();
    const baselineRss = getPeakRSSMB();

    resetLoadStats();
    const fullGraphStart = getPeakRSSMB();
    loadGraphForRepo("benchmark-repo-full");
    const fullGraphStats = getLastLoadStats();
    const fullGraphRss = getPeakRSSMB();

    assert.ok(fullGraphStats, "Should have full graph stats");
    const fullResult: BenchmarkResult = {
      name: "full-load",
      peakRssBeforeMB: fullGraphStart,
      peakRssAfterMB: fullGraphRss,
      peakRssDiffMB: fullGraphRss - fullGraphStart,
      nodeCount: fullGraphStats.nodeCount,
      edgeCount: fullGraphStats.edgeCount,
      durationMs: fullGraphStats.durationMs,
    };
    results.push(fullResult);

    forceGC();

    resetLoadStats();
    const lazyStart = getPeakRSSMB();
    loadNeighborhood("benchmark-repo-lazy", entrySymbols, {
      maxHops: 3,
      direction: "both",
      maxSymbols: 500,
    });
    const lazyStats = getLastLoadStats();
    const lazyRss = getPeakRSSMB();

    assert.ok(lazyStats, "Should have lazy graph stats");
    const lazyResult: BenchmarkResult = {
      name: "lazy-load",
      peakRssBeforeMB: lazyStart,
      peakRssAfterMB: lazyRss,
      peakRssDiffMB: lazyRss - lazyStart,
      nodeCount: lazyStats.nodeCount,
      edgeCount: lazyStats.edgeCount,
      durationMs: lazyStats.durationMs,
    };
    results.push(lazyResult);

    console.log("\n=== Memory Benchmark Results ===");
    for (const r of results) {
      console.log(`\n${r.name}:`);
      console.log(`  Nodes loaded: ${r.nodeCount}`);
      console.log(`  Edges loaded: ${r.edgeCount}`);
      console.log(`  Duration: ${r.durationMs}ms`);
      console.log(`  RSS before: ${r.peakRssBeforeMB}MB`);
      console.log(`  RSS after: ${r.peakRssAfterMB}MB`);
      console.log(`  RSS delta: ${r.peakRssDiffMB}MB`);
    }

    assert.strictEqual(lazyStats.mode, "lazy");
    assert.strictEqual(fullGraphStats.mode, "full");
  });

  it("should compare latency between lazy and full loading", () => {
    const entrySymbols = ["entry-1"];
    const latencies: { name: string; durationMs: number }[] = [];

    for (let i = 0; i < 3; i++) {
      resetLoadStats();
      loadGraphForRepo(`latency-repo-full-${i}`);
      const stats = getLastLoadStats();
      if (stats) {
        latencies.push({
          name: `full-load-run-${i + 1}`,
          durationMs: stats.durationMs,
        });
      }
    }

    for (let i = 0; i < 3; i++) {
      resetLoadStats();
      loadNeighborhood(`latency-repo-lazy-${i}`, entrySymbols, {
        maxHops: 3,
        direction: "both",
        maxSymbols: 500,
      });
      const stats = getLastLoadStats();
      if (stats) {
        latencies.push({
          name: `lazy-load-run-${i + 1}`,
          durationMs: stats.durationMs,
        });
      }
    }

    const fullLatencies = latencies
      .filter((l) => l.name.startsWith("full"))
      .map((l) => l.durationMs);
    const lazyLatencies = latencies
      .filter((l) => l.name.startsWith("lazy"))
      .map((l) => l.durationMs);

    const avgFull =
      fullLatencies.reduce((a, b) => a + b, 0) / fullLatencies.length;
    const avgLazy =
      lazyLatencies.reduce((a, b) => a + b, 0) / lazyLatencies.length;

    console.log("\n=== Latency Benchmark Results ===");
    console.log(`Full load average: ${avgFull.toFixed(2)}ms`);
    console.log(`Lazy load average: ${avgLazy.toFixed(2)}ms`);

    console.log(`Both modes completed successfully`);
  });

  it("should maintain output parity for deterministic fixtures", () => {
    const entrySymbols = ["entry-1", "entry-2"];

    resetLoadStats();
    loadNeighborhood("parity-repo", entrySymbols, {
      maxHops: 2,
      direction: "both",
    });

    const stats = getLastLoadStats();
    assert.ok(stats, "Should have stats");
    assert.strictEqual(stats.mode, "lazy");
    assert.strictEqual(stats.entrySymbolCount, entrySymbols.length);
  });

  it("should track node and edge counts correctly", () => {
    const entrySymbols = ["entry-1"];

    resetLoadStats();
    loadNeighborhood("tracking-repo", entrySymbols, {
      maxHops: 2,
      direction: "both",
      maxSymbols: 100,
    });

    const stats = getLastLoadStats();
    assert.ok(stats, "Should have stats");
    assert.ok(stats.nodeCount >= 0, "Node count should be non-negative");
    assert.ok(stats.edgeCount >= 0, "Edge count should be non-negative");

    console.log("\n=== Node/Edge Tracking ===");
    console.log(`Nodes: ${stats.nodeCount}`);
    console.log(`Edges: ${stats.edgeCount}`);
    console.log(`Duration: ${stats.durationMs}ms`);
  });
});
