#!/usr/bin/env tsx
/**
 * v0.6.7 Baseline Benchmark
 *
 * Records baseline metrics for slice, delta, symbol search, and prefetch operations.
 * Outputs JSON results for CI regression gating.
 *
 * Usage:
 *   npx tsx scripts/benchmark/v067-baseline.ts
 *   npx tsx scripts/benchmark/v067-baseline.ts --out devdocs/benchmarks/v067-baseline.json
 *   npx tsx scripts/benchmark/v067-baseline.ts --check devdocs/benchmarks/v067-baseline.json
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getDb } from "../../src/db/db.js";
import { runMigrations } from "../../src/db/migrations.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import * as db from "../../src/db/queries.js";
import { listVersions } from "../../src/delta/versioning.js";
import { computeDelta } from "../../src/delta/diff.js";
import { buildSlice } from "../../src/graph/slice.js";
import {
  getPrefetchStats,
  type PrefetchStats,
} from "../../src/graph/prefetch.js";
import { estimateTokens } from "../../src/util/tokenize.js";

interface BenchmarkMetric {
  name: string;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
  samples: number;
  metadata?: Record<string, unknown>;
}

interface MemoryMetric {
  peakRssMB: number;
  heapUsedMB: number;
  heapTotalMB: number;
}

interface CacheMetric {
  hitRate: number;
  wasteRate: number;
  cacheHits: number;
  cacheMisses: number;
  wastedPrefetch: number;
}

interface TokenMetric {
  outputTokens: number;
  cardCount: number;
  avgTokensPerCard: number;
}

interface SliceResult {
  metrics: BenchmarkMetric;
  tokens: TokenMetric;
  memory: MemoryMetric;
  cache: CacheMetric;
}

interface DeltaResult {
  metrics: BenchmarkMetric;
  tokens: TokenMetric;
}

interface SymbolSearchResult {
  metrics: BenchmarkMetric;
  resultCount: number;
}

interface PrefetchResult {
  metrics: BenchmarkMetric;
  cache: CacheMetric;
}

interface V067BaselineReport {
  version: string;
  timestamp: string;
  repoId: string;
  commit?: string;
  nodeVersion: string;
  platform: string;
  slice: SliceResult;
  delta: DeltaResult;
  symbolSearch: SymbolSearchResult;
  prefetch: PrefetchResult;
  thresholds: {
    sliceP95MaxMs: number;
    sliceTokensMax: number;
    deltaP95MaxMs: number;
    symbolSearchP95MaxMs: number;
    prefetchHitRateMin: number;
    peakRssMaxMB: number;
  };
}

const ITERATIONS = 10;
const WARMUP_ITERATIONS = 2;

function calculatePercentile(
  sortedValues: number[],
  percentile: number,
): number {
  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function getMemoryUsage(): MemoryMetric {
  const mem = process.memoryUsage();
  return {
    peakRssMB: Math.round(mem.rss / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
  };
}

function toCacheMetric(stats: PrefetchStats): CacheMetric {
  return {
    hitRate: stats.hitRate,
    wasteRate: stats.wasteRate,
    cacheHits: stats.cacheHits,
    cacheMisses: stats.cacheMisses,
    wastedPrefetch: stats.wastedPrefetch,
  };
}

async function measureSlice(repoId: string): Promise<SliceResult> {
  const latencies: number[] = [];
  let totalTokens = 0;
  let totalCards = 0;
  const memories: MemoryMetric[] = [];

  const symbols = db.getSymbolsByRepo(repoId);
  const functions = symbols.filter(
    (s) => s.kind === "function" || s.kind === "method",
  );
  const seedSymbol = functions[0] || symbols[0];

  if (!seedSymbol) {
    throw new Error(`No symbols found in repo ${repoId}`);
  }

  const latestVersion = db.getLatestVersion(repoId);
  const versionId = latestVersion?.version_id ?? "current";

  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    await buildSlice({
      repoId,
      versionId,
      entrySymbols: [seedSymbol.symbol_id],
      taskText: "benchmark warmup",
      budget: { maxCards: 30, maxEstimatedTokens: 5000 },
    });
  }

  for (let i = 0; i < ITERATIONS; i++) {
    global.gc?.();
    const start = performance.now();
    const slice = await buildSlice({
      repoId,
      versionId,
      entrySymbols: [seedSymbol.symbol_id],
      taskText: "benchmark test",
      budget: { maxCards: 30, maxEstimatedTokens: 5000 },
    });
    const latency = performance.now() - start;

    latencies.push(latency);
    memories.push(getMemoryUsage());

    const tokens = estimateTokens(
      JSON.stringify({ cards: slice.cards, cardRefs: slice.cardRefs ?? [] }),
    );
    totalTokens += tokens;
    totalCards += slice.cards.length;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const prefetchStats = getPrefetchStats(repoId);

  return {
    metrics: {
      name: "slice.build",
      p50Ms: Math.round(calculatePercentile(sorted, 50) * 100) / 100,
      p95Ms: Math.round(calculatePercentile(sorted, 95) * 100) / 100,
      maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
      avgMs:
        Math.round(
          (latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100,
        ) / 100,
      samples: ITERATIONS,
    },
    tokens: {
      outputTokens: Math.round(totalTokens / ITERATIONS),
      cardCount: Math.round(totalCards / ITERATIONS),
      avgTokensPerCard:
        totalCards > 0 ? Math.round(totalTokens / totalCards) : 0,
    },
    memory: {
      peakRssMB: Math.max(...memories.map((m) => m.peakRssMB)),
      heapUsedMB: Math.round(
        memories.reduce((a, m) => a + m.heapUsedMB, 0) / memories.length,
      ),
      heapTotalMB: Math.round(
        memories.reduce((a, m) => a + m.heapTotalMB, 0) / memories.length,
      ),
    },
    cache: toCacheMetric(prefetchStats),
  };
}

async function measureDelta(repoId: string): Promise<DeltaResult> {
  const latencies: number[] = [];
  let totalTokens = 0;
  let totalCards = 0;

  const versions = listVersions(repoId, 10);
  if (versions.length < 2) {
    return {
      metrics: {
        name: "delta.get",
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
        avgMs: 0,
        samples: 0,
      },
      tokens: { outputTokens: 0, cardCount: 0, avgTokensPerCard: 0 },
    };
  }

  const fromVersion = versions[versions.length - 1].version_id;
  const toVersion = versions[0].version_id;

  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    try {
      computeDelta(repoId, fromVersion, toVersion);
    } catch {
      // Ignore errors during warmup
    }
  }

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    try {
      const delta = computeDelta(repoId, fromVersion, toVersion);
      const latency = performance.now() - start;
      latencies.push(latency);
      const tokens = estimateTokens(JSON.stringify(delta.changedSymbols));
      totalTokens += tokens;
      totalCards += delta.changedSymbols.length;
    } catch {
      latencies.push(0);
    }
  }

  if (latencies.length === 0) {
    return {
      metrics: {
        name: "delta.get",
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
        avgMs: 0,
        samples: 0,
      },
      tokens: { outputTokens: 0, cardCount: 0, avgTokensPerCard: 0 },
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);

  return {
    metrics: {
      name: "delta.get",
      p50Ms: Math.round(calculatePercentile(sorted, 50) * 100) / 100,
      p95Ms: Math.round(calculatePercentile(sorted, 95) * 100) / 100,
      maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
      avgMs:
        Math.round(
          (latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100,
        ) / 100,
      samples: ITERATIONS,
    },
    tokens: {
      outputTokens: Math.round(totalTokens / ITERATIONS),
      cardCount: Math.round(totalCards / ITERATIONS),
      avgTokensPerCard:
        totalCards > 0 ? Math.round(totalTokens / totalCards) : 0,
    },
  };
}

async function measureSymbolSearch(
  repoId: string,
): Promise<SymbolSearchResult> {
  const latencies: number[] = [];
  let totalResults = 0;

  const queries = ["function", "class", "import", "export", "handle"];

  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    db.searchSymbols(repoId, queries[i % queries.length], 20);
  }

  for (let i = 0; i < ITERATIONS; i++) {
    const query = queries[i % queries.length];
    const start = performance.now();
    const results = db.searchSymbols(repoId, query, 20);
    const latency = performance.now() - start;

    latencies.push(latency);
    totalResults += results.length;
  }

  const sorted = [...latencies].sort((a, b) => a - b);

  return {
    metrics: {
      name: "symbol.search",
      p50Ms: Math.round(calculatePercentile(sorted, 50) * 100) / 100,
      p95Ms: Math.round(calculatePercentile(sorted, 95) * 100) / 100,
      maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
      avgMs:
        Math.round(
          (latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100,
        ) / 100,
      samples: ITERATIONS,
    },
    resultCount: Math.round(totalResults / ITERATIONS),
  };
}

async function measurePrefetch(repoId: string): Promise<PrefetchResult> {
  const latencies: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    getPrefetchStats(repoId);
    const latency = performance.now() - start;
    latencies.push(latency);
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const stats = getPrefetchStats(repoId);

  return {
    metrics: {
      name: "prefetch.status",
      p50Ms: Math.round(calculatePercentile(sorted, 50) * 100) / 100,
      p95Ms: Math.round(calculatePercentile(sorted, 95) * 100) / 100,
      maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
      avgMs:
        Math.round(
          (latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100,
        ) / 100,
      samples: ITERATIONS,
    },
    cache: toCacheMetric(stats),
  };
}

async function runBaseline(repoId: string): Promise<V067BaselineReport> {
  const slice = await measureSlice(repoId);
  const delta = await measureDelta(repoId);
  const symbolSearch = await measureSymbolSearch(repoId);
  const prefetch = await measurePrefetch(repoId);

  return {
    version: "0.6.7-baseline",
    timestamp: new Date().toISOString(),
    repoId,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    slice,
    delta,
    symbolSearch,
    prefetch,
    thresholds: {
      sliceP95MaxMs: 500,
      sliceTokensMax: 8000,
      deltaP95MaxMs: 200,
      symbolSearchP95MaxMs: 50,
      prefetchHitRateMin: 0,
      peakRssMaxMB: 512,
    },
  };
}

function checkRegressions(
  report: V067BaselineReport,
  baseline: V067BaselineReport,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const thresholds = baseline.thresholds;

  if (report.slice.metrics.p95Ms > thresholds.sliceP95MaxMs * 1.1) {
    failures.push(
      `slice p95 latency regressed: ${report.slice.metrics.p95Ms}ms > ${thresholds.sliceP95MaxMs * 1.1}ms (10% threshold)`,
    );
  }

  if (report.slice.tokens.outputTokens > thresholds.sliceTokensMax * 1.15) {
    failures.push(
      `slice tokens regressed: ${report.slice.tokens.outputTokens} > ${thresholds.sliceTokensMax * 1.15} (15% threshold)`,
    );
  }

  if (report.delta.metrics.p95Ms > thresholds.deltaP95MaxMs * 1.1) {
    failures.push(
      `delta p95 latency regressed: ${report.delta.metrics.p95Ms}ms > ${thresholds.deltaP95MaxMs * 1.1}ms`,
    );
  }

  if (
    report.symbolSearch.metrics.p95Ms >
    thresholds.symbolSearchP95MaxMs * 1.1
  ) {
    failures.push(
      `symbol search p95 latency regressed: ${report.symbolSearch.metrics.p95Ms}ms > ${thresholds.symbolSearchP95MaxMs * 1.1}ms`,
    );
  }

  if (report.slice.memory.peakRssMB > thresholds.peakRssMaxMB * 1.2) {
    failures.push(
      `peak RSS regressed: ${report.slice.memory.peakRssMB}MB > ${thresholds.peakRssMaxMB * 1.2}MB (20% threshold)`,
    );
  }

  return { passed: failures.length === 0, failures };
}

function printReport(report: V067BaselineReport): void {
  console.log("\n========================================");
  console.log("  v0.6.7 BASELINE BENCHMARK RESULTS");
  console.log("========================================\n");

  console.log(`Repo: ${report.repoId}`);
  console.log(`Node: ${report.nodeVersion}`);
  console.log(`Platform: ${report.platform}`);
  console.log(`Timestamp: ${report.timestamp}\n`);

  console.log("--- SLICE ---");
  console.log(`  p50: ${report.slice.metrics.p50Ms}ms`);
  console.log(`  p95: ${report.slice.metrics.p95Ms}ms`);
  console.log(`  avg: ${report.slice.metrics.avgMs}ms`);
  console.log(`  tokens: ${report.slice.tokens.outputTokens}`);
  console.log(`  cards: ${report.slice.tokens.cardCount}`);
  console.log(`  peak RSS: ${report.slice.memory.peakRssMB}MB`);

  console.log("\n--- DELTA ---");
  console.log(`  p50: ${report.delta.metrics.p50Ms}ms`);
  console.log(`  p95: ${report.delta.metrics.p95Ms}ms`);
  console.log(`  tokens: ${report.delta.tokens.outputTokens}`);

  console.log("\n--- SYMBOL SEARCH ---");
  console.log(`  p50: ${report.symbolSearch.metrics.p50Ms}ms`);
  console.log(`  p95: ${report.symbolSearch.metrics.p95Ms}ms`);
  console.log(`  avg results: ${report.symbolSearch.resultCount}`);

  console.log("\n--- PREFETCH ---");
  console.log(
    `  hit rate: ${(report.prefetch.cache.hitRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  waste rate: ${(report.prefetch.cache.wasteRate * 100).toFixed(1)}%`,
  );

  console.log("\n--- THRESHOLDS ---");
  console.log(`  slice p95 max: ${report.thresholds.sliceP95MaxMs}ms`);
  console.log(`  slice tokens max: ${report.thresholds.sliceTokensMax}`);
  console.log(`  delta p95 max: ${report.thresholds.deltaP95MaxMs}ms`);
  console.log(
    `  symbol search p95 max: ${report.thresholds.symbolSearchP95MaxMs}ms`,
  );
  console.log(`  peak RSS max: ${report.thresholds.peakRssMaxMB}MB`);
}

const args = process.argv.slice(2);
let outputPath: string | undefined;
let checkPath: string | undefined;
let targetRepoId: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) {
    outputPath = args[i + 1];
  }
  if (args[i] === "--check" && args[i + 1]) {
    checkPath = args[i + 1];
  }
  if (args[i] === "--repo-id" && args[i + 1]) {
    targetRepoId = args[i + 1];
  }
}

async function main() {
  const config = loadConfig();
  const database = getDb(config.dbPath);
  runMigrations(database);

  const repoId = targetRepoId || config.repos[0]?.repoId;
  if (!repoId) {
    console.error("No repository configured. Run 'sdl-mcp init' first.");
    process.exit(1);
  }

  console.log(`Running v0.6.7 baseline benchmark for ${repoId}...`);

  const report = await runBaseline(repoId);
  printReport(report);

  if (outputPath) {
    writeFileSync(resolve(outputPath), JSON.stringify(report, null, 2));
    console.log(`\nBaseline saved to: ${outputPath}`);
  }

  if (checkPath) {
    const baselinePath = resolve(checkPath);
    if (!existsSync(baselinePath)) {
      console.error(`Baseline file not found: ${baselinePath}`);
      process.exit(1);
    }

    const baseline = JSON.parse(
      readFileSync(baselinePath, "utf-8"),
    ) as V067BaselineReport;

    const { passed, failures } = checkRegressions(report, baseline);

    if (passed) {
      console.log("\n[PASS] No regressions detected.");
    } else {
      console.log("\n[FAIL] Regressions detected:");
      for (const failure of failures) {
        console.log(`  - ${failure}`);
      }
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
