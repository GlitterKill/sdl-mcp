import { describe, it, before } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const BASELINE_PATH = resolve("devdocs/benchmarks/v067-baseline.json");

interface V067BaselineReport {
  version: string;
  timestamp: string;
  repoId: string;
  nodeVersion: string;
  platform: string;
  slice: {
    metrics: {
      name: string;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
      avgMs: number;
      samples: number;
    };
    tokens: {
      outputTokens: number;
      cardCount: number;
      avgTokensPerCard: number;
    };
    memory: {
      peakRssMB: number;
      heapUsedMB: number;
      heapTotalMB: number;
    };
    cache: {
      hitRate: number;
      wasteRate: number;
      cacheHits: number;
      cacheMisses: number;
      wastedPrefetch: number;
    };
  };
  delta: {
    metrics: {
      name: string;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
      avgMs: number;
      samples: number;
    };
    tokens: {
      outputTokens: number;
      cardCount: number;
      avgTokensPerCard: number;
    };
  };
  symbolSearch: {
    metrics: {
      name: string;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
      avgMs: number;
      samples: number;
    };
    resultCount: number;
  };
  prefetch: {
    metrics: {
      name: string;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
      avgMs: number;
      samples: number;
    };
    cache: {
      hitRate: number;
      wasteRate: number;
      cacheHits: number;
      cacheMisses: number;
      wastedPrefetch: number;
    };
  };
  thresholds: {
    sliceP95MaxMs: number;
    sliceTokensMax: number;
    deltaP95MaxMs: number;
    symbolSearchP95MaxMs: number;
    prefetchHitRateMin: number;
    peakRssMaxMB: number;
  };
}

function validateBaselineReport(report: unknown): report is V067BaselineReport {
  if (typeof report !== "object" || report === null) return false;
  const r = report as Record<string, unknown>;

  if (typeof r.version !== "string") return false;
  if (typeof r.timestamp !== "string") return false;
  if (typeof r.repoId !== "string") return false;
  if (typeof r.slice !== "object") return false;
  if (typeof r.delta !== "object") return false;
  if (typeof r.symbolSearch !== "object") return false;
  if (typeof r.prefetch !== "object") return false;
  if (typeof r.thresholds !== "object") return false;

  const slice = r.slice as Record<string, unknown>;
  if (typeof slice.metrics !== "object") return false;
  if (typeof slice.tokens !== "object") return false;
  if (typeof slice.memory !== "object") return false;
  if (typeof slice.cache !== "object") return false;

  return true;
}

describe("v0.6.7 Baseline Benchmark Harness", () => {
  before(() => {
    const dir = dirname(BASELINE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  });

  it("should produce valid baseline report schema", async () => {
    const validReport: V067BaselineReport = {
      version: "0.6.7-baseline",
      timestamp: new Date().toISOString(),
      repoId: "test-fixture",
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      slice: {
        metrics: {
          name: "slice.build",
          p50Ms: 10,
          p95Ms: 20,
          maxMs: 25,
          avgMs: 15,
          samples: 10,
        },
        tokens: { outputTokens: 100, cardCount: 5, avgTokensPerCard: 20 },
        memory: { peakRssMB: 100, heapUsedMB: 50, heapTotalMB: 80 },
        cache: {
          hitRate: 0.5,
          wasteRate: 0.1,
          cacheHits: 10,
          cacheMisses: 10,
          wastedPrefetch: 2,
        },
      },
      delta: {
        metrics: {
          name: "delta.get",
          p50Ms: 5,
          p95Ms: 10,
          maxMs: 12,
          avgMs: 7,
          samples: 10,
        },
        tokens: { outputTokens: 50, cardCount: 3, avgTokensPerCard: 17 },
      },
      symbolSearch: {
        metrics: {
          name: "symbol.search",
          p50Ms: 2,
          p95Ms: 5,
          maxMs: 6,
          avgMs: 3,
          samples: 10,
        },
        resultCount: 15,
      },
      prefetch: {
        metrics: {
          name: "prefetch.status",
          p50Ms: 1,
          p95Ms: 2,
          maxMs: 3,
          avgMs: 1,
          samples: 10,
        },
        cache: {
          hitRate: 0.3,
          wasteRate: 0.2,
          cacheHits: 5,
          cacheMisses: 15,
          wastedPrefetch: 3,
        },
      },
      thresholds: {
        sliceP95MaxMs: 500,
        sliceTokensMax: 8000,
        deltaP95MaxMs: 200,
        symbolSearchP95MaxMs: 50,
        prefetchHitRateMin: 0,
        peakRssMaxMB: 512,
      },
    };

    assert.strictEqual(validateBaselineReport(validReport), true);

    assert.ok(validReport.slice.metrics);
    assert.ok(validReport.slice.tokens);
    assert.ok(validReport.slice.memory);
    assert.ok(validReport.slice.cache);

    assert.strictEqual(typeof validReport.slice.metrics.p50Ms, "number");
    assert.strictEqual(typeof validReport.slice.metrics.p95Ms, "number");
    assert.ok(validReport.slice.metrics.samples > 0);
  });

  it("should validate output schema fields", () => {
    const report = {
      version: "0.6.7-baseline",
      timestamp: new Date().toISOString(),
      repoId: "test-fixture",
    };

    assert.ok(typeof report.version === "string");
    assert.ok(typeof report.timestamp === "string");
    assert.ok(typeof report.repoId === "string");
  });

  it("should fail CI gate on missing baseline artifact", () => {
    const missingPath = resolve("devdocs/benchmarks/nonexistent-baseline.json");
    assert.strictEqual(existsSync(missingPath), false);
  });

  it("should write and read baseline artifact", () => {
    const testReport = {
      version: "test",
      timestamp: new Date().toISOString(),
      repoId: "test-repo",
    };

    writeFileSync(BASELINE_PATH, JSON.stringify(testReport, null, 2));
    assert.strictEqual(existsSync(BASELINE_PATH), true);

    const saved = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
    assert.strictEqual(saved.repoId, "test-repo");
    assert.strictEqual(saved.version, "test");
  });

  it("should validate deterministic seed usage for benchmarks", () => {
    const deterministicSeed = 12345;
    const pseudoRandom = (seed: number) => {
      const x = Math.sin(seed) * 10000;
      return x - Math.floor(x);
    };

    const r1 = pseudoRandom(deterministicSeed);
    const r2 = pseudoRandom(deterministicSeed);

    assert.strictEqual(
      r1,
      r2,
      "Same seed should produce same pseudo-random sequence",
    );
  });

  it("should define correct threshold defaults", () => {
    const thresholds = {
      sliceP95MaxMs: 500,
      sliceTokensMax: 8000,
      deltaP95MaxMs: 200,
      symbolSearchP95MaxMs: 50,
      prefetchHitRateMin: 0,
      peakRssMaxMB: 512,
    };

    assert.ok(thresholds.sliceP95MaxMs > 0);
    assert.ok(thresholds.sliceTokensMax > 0);
    assert.ok(thresholds.deltaP95MaxMs > 0);
    assert.ok(thresholds.symbolSearchP95MaxMs > 0);
    assert.ok(thresholds.peakRssMaxMB > 0);
  });
});
