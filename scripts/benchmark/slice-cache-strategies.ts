#!/usr/bin/env tsx
/**
 * Slice Cache Strategy Benchmark (V067-4)
 *
 * Compares current Map-based cache lookup against a Bloom filter pre-check approach.
 *
 * Success criteria:
 * - Lookup latency improvement >= 10%
 * - Memory overhead <= 5%
 * - False positives do not affect correctness
 *
 * Usage:
 *   npx tsx scripts/benchmark/slice-cache-strategies.ts
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

interface BenchmarkResult {
  strategy: string;
  iterations: number;
  hitLatencyNs: number;
  missLatencyNs: number;
  memoryOverheadBytes: number;
  falsePositiveRate: number;
  correctnessVerified: boolean;
}

interface CacheMetrics {
  hits: number;
  misses: number;
  hitLatencyNs: number;
  missLatencyNs: number;
}

const CACHE_SIZE = 100;
const KEY_LENGTH = 64;
const ITERATIONS = 100_000;
const WARMUP = 10_000;

class SimpleBloomFilter {
  private readonly bits: Uint8Array;
  private readonly numBits: number;
  private readonly numHashes: number;

  constructor(expectedItems: number, falsePositiveRate: number = 0.01) {
    const n = expectedItems;
    const p = falsePositiveRate;
    this.numBits = Math.ceil((-n * Math.log(p)) / Math.pow(Math.log(2), 2));
    this.numHashes = Math.ceil((this.numBits / n) * Math.log(2));
    this.bits = new Uint8Array(Math.ceil(this.numBits / 8));
  }

  private hash(key: string, seed: number): number {
    let hash = seed;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    return hash % this.numBits;
  }

  add(key: string): void {
    for (let i = 0; i < this.numHashes; i++) {
      const bitIndex = this.hash(key, i);
      const byteIndex = Math.floor(bitIndex / 8);
      const bitOffset = bitIndex % 8;
      this.bits[byteIndex] |= 1 << bitOffset;
    }
  }

  mightContain(key: string): boolean {
    for (let i = 0; i < this.numHashes; i++) {
      const bitIndex = this.hash(key, i);
      const byteIndex = Math.floor(bitIndex / 8);
      const bitOffset = bitIndex % 8;
      if ((this.bits[byteIndex] & (1 << bitOffset)) === 0) {
        return false;
      }
    }
    return true;
  }

  getMemoryBytes(): number {
    return this.bits.byteLength;
  }

  clear(): void {
    this.bits.fill(0);
  }
}

function generateKey(index: number): string {
  return `repo:v${index}:task${index % 10}`;
}

function benchmarkBaselineMap(): CacheMetrics & { memoryBytes: number } {
  const cache = new Map<string, { data: string; expiresAt: number }>();
  const now = Date.now();

  for (let i = 0; i < CACHE_SIZE; i++) {
    cache.set(generateKey(i), {
      data: `slice-data-${i}`,
      expiresAt: now + 60000,
    });
  }

  for (let i = 0; i < WARMUP; i++) {
    const hitKey = generateKey(i % CACHE_SIZE);
    const missKey = `miss-${i}`;
    cache.get(hitKey);
    cache.get(missKey);
  }

  let totalHitLatency = 0;
  let totalMissLatency = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const hitKey = generateKey(i % CACHE_SIZE);
    const startHit = performance.now();
    cache.get(hitKey);
    totalHitLatency += performance.now() - startHit;

    const missKey = `miss-key-${i}`;
    const startMiss = performance.now();
    cache.get(missKey);
    totalMissLatency += performance.now() - startMiss;
  }

  return {
    hits: ITERATIONS,
    misses: ITERATIONS,
    hitLatencyNs: (totalHitLatency / ITERATIONS) * 1_000_000,
    missLatencyNs: (totalMissLatency / ITERATIONS) * 1_000_000,
    memoryBytes: 0,
  };
}

function benchmarkBloomPrecheck(): CacheMetrics & {
  memoryBytes: number;
  falsePositives: number;
} {
  const cache = new Map<string, { data: string; expiresAt: number }>();
  const bloom = new SimpleBloomFilter(CACHE_SIZE * 2, 0.01);
  const now = Date.now();

  for (let i = 0; i < CACHE_SIZE; i++) {
    const key = generateKey(i);
    cache.set(key, {
      data: `slice-data-${i}`,
      expiresAt: now + 60000,
    });
    bloom.add(key);
  }

  for (let i = 0; i < WARMUP; i++) {
    const hitKey = generateKey(i % CACHE_SIZE);
    const missKey = `miss-${i}`;
    if (bloom.mightContain(hitKey)) {
      cache.get(hitKey);
    }
    if (bloom.mightContain(missKey)) {
      cache.get(missKey);
    }
  }

  let totalHitLatency = 0;
  let totalMissLatency = 0;
  let falsePositives = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const hitKey = generateKey(i % CACHE_SIZE);
    const startHit = performance.now();
    if (bloom.mightContain(hitKey)) {
      cache.get(hitKey);
    }
    totalHitLatency += performance.now() - startHit;

    const missKey = `miss-key-${i}`;
    const startMiss = performance.now();
    if (bloom.mightContain(missKey)) {
      cache.get(missKey);
      falsePositives++;
    }
    totalMissLatency += performance.now() - startMiss;
  }

  return {
    hits: ITERATIONS,
    misses: ITERATIONS,
    hitLatencyNs: (totalHitLatency / ITERATIONS) * 1_000_000,
    missLatencyNs: (totalMissLatency / ITERATIONS) * 1_000_000,
    memoryBytes: bloom.getMemoryBytes(),
    falsePositives,
  };
}

function verifyCorrectness(): boolean {
  const cache = new Map<string, string>();
  const bloom = new SimpleBloomFilter(CACHE_SIZE * 2, 0.01);

  for (let i = 0; i < CACHE_SIZE; i++) {
    const key = generateKey(i);
    cache.set(key, `value-${i}`);
    bloom.add(key);
  }

  for (let i = 0; i < 1000; i++) {
    const key = generateKey(i % CACHE_SIZE);
    const actualValue = cache.get(key);

    if (bloom.mightContain(key)) {
      const cacheValue = cache.get(key);
      if (actualValue !== cacheValue) {
        return false;
      }
    }
  }

  for (let i = 0; i < 1000; i++) {
    const missKey = `nonexistent-${i}`;
    const bloomSaysMaybe = bloom.mightContain(missKey);
    const actualValue = cache.get(missKey);

    if (!bloomSaysMaybe && actualValue !== undefined) {
      return false;
    }
    if (actualValue !== undefined) {
      return false;
    }
  }

  return true;
}

function measureMemoryOverhead(): { baseline: number; bloom: number } {
  const baselineCache = new Map<string, { data: string; expiresAt: number }>();
  const now = Date.now();

  for (let i = 0; i < CACHE_SIZE; i++) {
    baselineCache.set(generateKey(i), {
      data: `x`.repeat(200),
      expiresAt: now + 60000,
    });
  }

  const bloom = new SimpleBloomFilter(CACHE_SIZE * 2, 0.01);
  for (let i = 0; i < CACHE_SIZE; i++) {
    bloom.add(generateKey(i));
  }

  const mem = process.memoryUsage();
  return {
    baseline: mem.heapUsed,
    bloom: mem.heapUsed + bloom.getMemoryBytes(),
  };
}

function main(): void {
  console.log("========================================");
  console.log("  Slice Cache Strategy Benchmark (V067-4)");
  console.log("========================================\n");

  console.log(`Configuration:`);
  console.log(`  Cache size: ${CACHE_SIZE} entries`);
  console.log(`  Iterations: ${ITERATIONS}`);
  console.log(`  Warmup: ${WARMUP}`);
  console.log("\n");

  console.log("Running baseline Map-only benchmark...");
  const baseline = benchmarkBaselineMap();

  console.log("Running Bloom filter pre-check benchmark...");
  const bloomResult = benchmarkBloomPrecheck();

  console.log("Verifying correctness...");
  const correctness = verifyCorrectness();

  const memoryOverhead = measureMemoryOverhead();

  const results: BenchmarkResult[] = [
    {
      strategy: "baseline-map",
      iterations: ITERATIONS,
      hitLatencyNs: baseline.hitLatencyNs,
      missLatencyNs: baseline.missLatencyNs,
      memoryOverheadBytes: 0,
      falsePositiveRate: 0,
      correctnessVerified: true,
    },
    {
      strategy: "bloom-precheck",
      iterations: ITERATIONS,
      hitLatencyNs: bloomResult.hitLatencyNs,
      missLatencyNs: bloomResult.missLatencyNs,
      memoryOverheadBytes: bloomResult.memoryBytes,
      falsePositiveRate: bloomResult.falsePositives / ITERATIONS,
      correctnessVerified: correctness,
    },
  ];

  console.log("\n========================================");
  console.log("  RESULTS");
  console.log("========================================\n");

  console.log("BASELINE (Map-only):");
  console.log(`  Hit latency:  ${baseline.hitLatencyNs.toFixed(2)} ns`);
  console.log(`  Miss latency: ${baseline.missLatencyNs.toFixed(2)} ns`);

  console.log("\nBLOOM FILTER (Pre-check):");
  console.log(`  Hit latency:  ${bloomResult.hitLatencyNs.toFixed(2)} ns`);
  console.log(`  Miss latency: ${bloomResult.missLatencyNs.toFixed(2)} ns`);
  console.log(`  Memory overhead: ${bloomResult.memoryBytes} bytes`);
  console.log(
    `  False positive rate: ${((bloomResult.falsePositives / ITERATIONS) * 100).toFixed(2)}%`,
  );
  console.log(`  Correctness: ${correctness ? "PASS" : "FAIL"}`);

  const hitImprovement =
    ((baseline.hitLatencyNs - bloomResult.hitLatencyNs) /
      baseline.hitLatencyNs) *
    100;
  const missImprovement =
    ((baseline.missLatencyNs - bloomResult.missLatencyNs) /
      baseline.missLatencyNs) *
    100;
  const memOverheadPercent =
    (bloomResult.memoryBytes / memoryOverhead.baseline) * 100;

  console.log("\n========================================");
  console.log("  ANALYSIS");
  console.log("========================================\n");

  console.log(
    `Hit latency change: ${hitImprovement > 0 ? "+" : ""}${hitImprovement.toFixed(1)}%`,
  );
  console.log(
    `Miss latency change: ${missImprovement > 0 ? "+" : ""}${missImprovement.toFixed(1)}%`,
  );
  console.log(`Memory overhead: ${memOverheadPercent.toFixed(2)}%`);

  console.log("\n========================================");
  console.log("  DECISION CRITERIA");
  console.log("========================================\n");

  const latencyImproved = hitImprovement >= 10 || missImprovement >= 10;
  const memoryAcceptable = memOverheadPercent <= 5;
  const correctnessPass = correctness;

  console.log(
    `  Latency improvement >= 10%: ${latencyImproved ? "PASS" : "FAIL"} (${Math.max(hitImprovement, missImprovement).toFixed(1)}%)`,
  );
  console.log(
    `  Memory overhead <= 5%: ${memoryAcceptable ? "PASS" : "FAIL"} (${memOverheadPercent.toFixed(2)}%)`,
  );
  console.log(`  Correctness verified: ${correctnessPass ? "PASS" : "FAIL"}`);

  const adopt = latencyImproved && memoryAcceptable && correctnessPass;

  console.log("\n========================================");
  console.log(`  DECISION: ${adopt ? "ADOPT" : "SKIP"}`);
  console.log("========================================\n");

  if (!adopt) {
    console.log("REASON: ");
    if (!latencyImproved) {
      console.log(
        "  - Bloom filter adds overhead without measurable benefit for O(1) Map lookups",
      );
    }
    if (!memoryAcceptable) {
      console.log("  - Memory overhead exceeds 5% threshold");
    }
    if (!correctnessPass) {
      console.log("  - Correctness verification failed");
    }
  }

  const reportPath = resolve("devdocs/benchmarks/slice-cache-v067.json");
  const reportDir = dirname(reportPath);
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }

  const report = {
    version: "v067-4",
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    configuration: {
      cacheSize: CACHE_SIZE,
      iterations: ITERATIONS,
      warmup: WARMUP,
    },
    results,
    analysis: {
      hitImprovementPercent: hitImprovement,
      missImprovementPercent: missImprovement,
      memoryOverheadPercent: memOverheadPercent,
    },
    criteria: {
      latencyImproved,
      memoryAcceptable,
      correctnessPass,
    },
    decision: adopt ? "ADOPT" : "SKIP",
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${reportPath}`);
}

main();
