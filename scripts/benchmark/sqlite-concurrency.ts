#!/usr/bin/env tsx
/**
 * SQLite Concurrency Benchmark (V067-3)
 *
 * Benchmarks different SQLite concurrency strategies:
 * 1. Current: Single connection with WAL + busy_timeout
 * 2. Strategy A: Primary writer + read-only secondary connections
 * 3. Strategy B: Worker-thread reader (simulated with connection pool)
 *
 * Usage:
 *   npx tsx scripts/benchmark/sqlite-concurrency.ts
 *   npx tsx scripts/benchmark/sqlite-concurrency.ts --out devdocs/benchmarks/sqlite-concurrency-v067.json
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const DB_BUSY_TIMEOUT_MS = 5000;
const ITERATIONS = 50;
const WARMUP_ITERATIONS = 5;

interface BenchmarkMetric {
  name: string;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
  samples: number;
  errors: number;
  writeStarvation: number;
}

interface StrategyResult {
  strategy: string;
  description: string;
  readMetric: BenchmarkMetric;
  writeMetric: BenchmarkMetric;
  mixedMetric: BenchmarkMetric;
  throughputOpsPerSec: number;
}

interface ConcurrencyReport {
  version: string;
  timestamp: string;
  nodeVersion: string;
  platform: string;
  dbConfig: {
    busyTimeoutMs: number;
    journalMode: string;
    synchronousMode: string;
  };
  strategies: StrategyResult[];
  recommendation: {
    strategy: string;
    throughputGainPct: number;
    writeStarvation: number;
    decision: "ADOPT" | "SKIP";
    rationale: string;
  };
}

function calculatePercentile(
  sortedValues: number[],
  percentile: number,
): number {
  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function createTestDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      symbol_id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      summary TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_repo ON symbols(repo_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
  `);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO symbols (symbol_id, repo_id, name, kind, file_path, summary) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertMany = db.transaction(() => {
    for (let i = 0; i < 1000; i++) {
      insert.run(
        `sym-${i.toString().padStart(4, "0")}`,
        "benchmark-repo",
        `function${i}`,
        i % 3 === 0 ? "function" : i % 3 === 1 ? "class" : "method",
        `/src/file${i % 10}.ts`,
        `Summary for symbol ${i}`,
      );
    }
  });
  insertMany();

  return db;
}

function createReadOnlyConnection(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
  return db;
}

async function benchmarkSingleConnection(
  db: Database.Database,
): Promise<StrategyResult> {
  const readLatencies: number[] = [];
  const writeLatencies: number[] = [];
  const mixedLatencies: number[] = [];
  let errors = 0;
  let writeStarvation = 0;

  const selectQuery = db.prepare(
    "SELECT * FROM symbols WHERE repo_id = ? LIMIT 20",
  );
  const updateQuery = db.prepare(
    "UPDATE symbols SET summary = ? WHERE symbol_id = ?",
  );

  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    selectQuery.all("benchmark-repo");
    updateQuery.run(`updated ${i}`, "sym-0000");
  }

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    try {
      selectQuery.all("benchmark-repo");
      readLatencies.push(performance.now() - start);
    } catch {
      errors++;
    }

    const writeStart = performance.now();
    try {
      updateQuery.run(
        `updated iteration ${i}`,
        `sym-${(i % 1000).toString().padStart(4, "0")}`,
      );
      writeLatencies.push(performance.now() - writeStart);
    } catch {
      errors++;
      writeStarvation++;
    }

    const mixedStart = performance.now();
    try {
      const txn = db.transaction(() => {
        selectQuery.all("benchmark-repo");
        updateQuery.run(
          `mixed ${i}`,
          `sym-${((i + 500) % 1000).toString().padStart(4, "0")}`,
        );
      });
      txn();
      mixedLatencies.push(performance.now() - mixedStart);
    } catch {
      errors++;
    }
  }

  const readSorted = [...readLatencies].sort((a, b) => a - b);
  const writeSorted = [...writeLatencies].sort((a, b) => a - b);
  const mixedSorted = [...mixedLatencies].sort((a, b) => a - b);

  const totalOps =
    readLatencies.length + writeLatencies.length + mixedLatencies.length;
  const totalTimeMs =
    readLatencies.reduce((a, b) => a + b, 0) +
    writeLatencies.reduce((a, b) => a + b, 0) +
    mixedLatencies.reduce((a, b) => a + b, 0);

  return {
    strategy: "single-connection",
    description: "Current: Single connection with WAL + busy_timeout",
    readMetric: {
      name: "read",
      p50Ms: calculatePercentile(readSorted, 50),
      p95Ms: calculatePercentile(readSorted, 95),
      maxMs: readSorted[readSorted.length - 1] || 0,
      avgMs:
        readLatencies.reduce((a, b) => a + b, 0) / readLatencies.length || 0,
      samples: readLatencies.length,
      errors: 0,
      writeStarvation: 0,
    },
    writeMetric: {
      name: "write",
      p50Ms: calculatePercentile(writeSorted, 50),
      p95Ms: calculatePercentile(writeSorted, 95),
      maxMs: writeSorted[writeSorted.length - 1] || 0,
      avgMs:
        writeLatencies.reduce((a, b) => a + b, 0) / writeLatencies.length || 0,
      samples: writeLatencies.length,
      errors,
      writeStarvation,
    },
    mixedMetric: {
      name: "mixed",
      p50Ms: calculatePercentile(mixedSorted, 50),
      p95Ms: calculatePercentile(mixedSorted, 95),
      maxMs: mixedSorted[mixedSorted.length - 1] || 0,
      avgMs:
        mixedLatencies.reduce((a, b) => a + b, 0) / mixedLatencies.length || 0,
      samples: mixedLatencies.length,
      errors: 0,
      writeStarvation: 0,
    },
    throughputOpsPerSec: totalOps / (totalTimeMs / 1000),
  };
}

async function benchmarkReadOnlySecondary(
  dbPath: string,
): Promise<StrategyResult> {
  const writerDb = new Database(dbPath);
  writerDb.pragma("journal_mode = WAL");
  writerDb.pragma("synchronous = NORMAL");
  writerDb.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);

  const readerDbs: Database.Database[] = [];
  for (let i = 0; i < 4; i++) {
    readerDbs.push(createReadOnlyConnection(dbPath));
  }

  const readLatencies: number[] = [];
  const writeLatencies: number[] = [];
  const mixedLatencies: number[] = [];
  let errors = 0;
  let writeStarvation = 0;

  const updateQuery = writerDb.prepare(
    "UPDATE symbols SET summary = ? WHERE symbol_id = ?",
  );

  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    const readerDb = readerDbs[i % readerDbs.length];
    const selectQuery = readerDb.prepare(
      "SELECT * FROM symbols WHERE repo_id = ? LIMIT 20",
    );
    selectQuery.all("benchmark-repo");
    updateQuery.run(`warmup ${i}`, "sym-0000");
  }

  for (let i = 0; i < ITERATIONS; i++) {
    const readerDb = readerDbs[i % readerDbs.length];
    const selectQuery = readerDb.prepare(
      "SELECT * FROM symbols WHERE repo_id = ? LIMIT 20",
    );

    const readStart = performance.now();
    try {
      selectQuery.all("benchmark-repo");
      readLatencies.push(performance.now() - readStart);
    } catch {
      errors++;
    }

    const writeStart = performance.now();
    try {
      updateQuery.run(
        `updated iteration ${i}`,
        `sym-${(i % 1000).toString().padStart(4, "0")}`,
      );
      writeLatencies.push(performance.now() - writeStart);
    } catch {
      errors++;
      writeStarvation++;
    }

    const mixedStart = performance.now();
    try {
      selectQuery.all("benchmark-repo");
      updateQuery.run(
        `mixed ${i}`,
        `sym-${((i + 500) % 1000).toString().padStart(4, "0")}`,
      );
      mixedLatencies.push(performance.now() - mixedStart);
    } catch {
      errors++;
    }
  }

  writerDb.close();
  for (const rdb of readerDbs) {
    rdb.close();
  }

  const readSorted = [...readLatencies].sort((a, b) => a - b);
  const writeSorted = [...writeLatencies].sort((a, b) => a - b);
  const mixedSorted = [...mixedLatencies].sort((a, b) => a - b);

  const totalOps =
    readLatencies.length + writeLatencies.length + mixedLatencies.length;
  const totalTimeMs =
    readLatencies.reduce((a, b) => a + b, 0) +
    writeLatencies.reduce((a, b) => a + b, 0) +
    mixedLatencies.reduce((a, b) => a + b, 0);

  return {
    strategy: "read-only-secondary",
    description: "Primary writer + 4 read-only secondary connections",
    readMetric: {
      name: "read",
      p50Ms: calculatePercentile(readSorted, 50),
      p95Ms: calculatePercentile(readSorted, 95),
      maxMs: readSorted[readSorted.length - 1] || 0,
      avgMs:
        readLatencies.reduce((a, b) => a + b, 0) / readLatencies.length || 0,
      samples: readLatencies.length,
      errors: 0,
      writeStarvation: 0,
    },
    writeMetric: {
      name: "write",
      p50Ms: calculatePercentile(writeSorted, 50),
      p95Ms: calculatePercentile(writeSorted, 95),
      maxMs: writeSorted[writeSorted.length - 1] || 0,
      avgMs:
        writeLatencies.reduce((a, b) => a + b, 0) / writeLatencies.length || 0,
      samples: writeLatencies.length,
      errors,
      writeStarvation,
    },
    mixedMetric: {
      name: "mixed",
      p50Ms: calculatePercentile(mixedSorted, 50),
      p95Ms: calculatePercentile(mixedSorted, 95),
      maxMs: mixedSorted[mixedSorted.length - 1] || 0,
      avgMs:
        mixedLatencies.reduce((a, b) => a + b, 0) / mixedLatencies.length || 0,
      samples: mixedLatencies.length,
      errors: 0,
      writeStarvation: 0,
    },
    throughputOpsPerSec: totalOps / (totalTimeMs / 1000),
  };
}

async function benchmarkConcurrentMixed(
  dbPath: string,
): Promise<StrategyResult> {
  const readLatencies: number[] = [];
  const writeLatencies: number[] = [];
  const mixedLatencies: number[] = [];
  let errors = 0;
  let writeStarvation = 0;

  const concurrentReads = 8;
  const concurrentWrites = 4;

  const workerPromises: Promise<void>[] = [];

  for (let w = 0; w < concurrentWrites; w++) {
    const writerDb = new Database(dbPath);
    writerDb.pragma("journal_mode = WAL");
    writerDb.pragma("synchronous = NORMAL");
    writerDb.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    const updateQuery = writerDb.prepare(
      "UPDATE symbols SET summary = ? WHERE symbol_id = ?",
    );

    workerPromises.push(
      (async () => {
        for (let i = 0; i < Math.ceil(ITERATIONS / concurrentWrites); i++) {
          const writeStart = performance.now();
          try {
            updateQuery.run(
              `concurrent write ${w}-${i}`,
              `sym-${((w * 100 + i) % 1000).toString().padStart(4, "0")}`,
            );
            writeLatencies.push(performance.now() - writeStart);
          } catch {
            errors++;
            writeStarvation++;
          }
        }
        writerDb.close();
      })(),
    );
  }

  for (let r = 0; r < concurrentReads; r++) {
    const readerDb = createReadOnlyConnection(dbPath);
    const selectQuery = readerDb.prepare(
      "SELECT * FROM symbols WHERE repo_id = ? LIMIT 20",
    );

    workerPromises.push(
      (async () => {
        for (let i = 0; i < Math.ceil(ITERATIONS / concurrentReads); i++) {
          const readStart = performance.now();
          try {
            selectQuery.all("benchmark-repo");
            readLatencies.push(performance.now() - readStart);
          } catch {
            errors++;
          }
        }
        readerDb.close();
      })(),
    );
  }

  await Promise.all(workerPromises);

  const readSorted = [...readLatencies].sort((a, b) => a - b);
  const writeSorted = [...writeLatencies].sort((a, b) => a - b);

  const totalOps = readLatencies.length + writeLatencies.length;
  const totalTimeMs =
    readLatencies.reduce((a, b) => a + b, 0) +
    writeLatencies.reduce((a, b) => a + b, 0);

  return {
    strategy: "concurrent-mixed",
    description: "8 concurrent readers + 4 concurrent writers",
    readMetric: {
      name: "read",
      p50Ms: calculatePercentile(readSorted, 50),
      p95Ms: calculatePercentile(readSorted, 95),
      maxMs: readSorted[readSorted.length - 1] || 0,
      avgMs:
        readLatencies.reduce((a, b) => a + b, 0) / readLatencies.length || 0,
      samples: readLatencies.length,
      errors: 0,
      writeStarvation: 0,
    },
    writeMetric: {
      name: "write",
      p50Ms: calculatePercentile(writeSorted, 50),
      p95Ms: calculatePercentile(writeSorted, 95),
      maxMs: writeSorted[writeSorted.length - 1] || 0,
      avgMs:
        writeLatencies.reduce((a, b) => a + b, 0) / writeLatencies.length || 0,
      samples: writeLatencies.length,
      errors,
      writeStarvation,
    },
    mixedMetric: {
      name: "mixed",
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      avgMs: 0,
      samples: 0,
      errors: 0,
      writeStarvation: 0,
    },
    throughputOpsPerSec: totalOps / (totalTimeMs / 1000),
  };
}

async function runBenchmark(): Promise<ConcurrencyReport> {
  const tempDir = mkdtempSync(join(tmpdir(), "sdl-sqlite-bench-"));
  const dbPath = join(tempDir, "benchmark.db");

  try {
    const db = createTestDatabase(dbPath);

    console.log("Running SQLite concurrency benchmark...\n");
    console.log(`Database: ${dbPath}`);
    console.log(`Busy timeout: ${DB_BUSY_TIMEOUT_MS}ms`);
    console.log(`Iterations: ${ITERATIONS} (warmup: ${WARMUP_ITERATIONS})\n`);

    console.log("[1/3] Benchmarking single-connection strategy (current)...");
    const singleResult = await benchmarkSingleConnection(db);
    db.close();

    console.log("[2/3] Benchmarking read-only-secondary strategy...");
    const secondaryResult = await benchmarkReadOnlySecondary(dbPath);

    console.log("[3/3] Benchmarking concurrent-mixed strategy...");
    const concurrentResult = await benchmarkConcurrentMixed(dbPath);

    const strategies = [singleResult, secondaryResult, concurrentResult];

    const baselineThroughput = singleResult.throughputOpsPerSec;
    let bestStrategy = singleResult;
    let bestGain = 0;

    for (const strategy of strategies.slice(1)) {
      const gain =
        ((strategy.throughputOpsPerSec - baselineThroughput) /
          baselineThroughput) *
        100;
      if (
        gain > bestGain &&
        strategy.writeMetric.writeStarvation === 0 &&
        gain >= 20
      ) {
        bestGain = gain;
        bestStrategy = strategy;
      }
    }

    const decision =
      bestStrategy.strategy !== "single-connection" &&
      bestGain >= 20 &&
      bestStrategy.writeMetric.writeStarvation === 0
        ? "ADOPT"
        : "SKIP";

    const rationale =
      decision === "SKIP"
        ? bestGain < 20
          ? `Throughput gain (${bestGain.toFixed(1)}%) below 20% threshold. ` +
            `Current single-connection strategy with WAL + busy_timeout is sufficient.`
          : bestStrategy.writeMetric.writeStarvation > 0
            ? `Write starvation detected (${bestStrategy.writeMetric.writeStarvation} events). ` +
              `Alternative strategy rejected due to lock contention.`
            : "No alternative strategy meets adoption criteria."
        : `${bestStrategy.strategy} provides ${bestGain.toFixed(1)}% throughput ` +
          `improvement with zero write starvation.`;

    return {
      version: "0.6.7-concurrency",
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      dbConfig: {
        busyTimeoutMs: DB_BUSY_TIMEOUT_MS,
        journalMode: "WAL",
        synchronousMode: "NORMAL",
      },
      strategies,
      recommendation: {
        strategy: bestStrategy.strategy,
        throughputGainPct: Math.round(bestGain * 10) / 10,
        writeStarvation: bestStrategy.writeMetric.writeStarvation,
        decision,
        rationale,
      },
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function printReport(report: ConcurrencyReport): void {
  console.log("\n========================================");
  console.log("  SQLITE CONCURRENCY BENCHMARK RESULTS");
  console.log("========================================\n");

  console.log(`Node: ${report.nodeVersion}`);
  console.log(`Platform: ${report.platform}`);
  console.log(
    `DB Config: WAL / NORMAL / busy_timeout=${report.dbConfig.busyTimeoutMs}ms\n`,
  );

  for (const strategy of report.strategies) {
    console.log(`--- ${strategy.strategy.toUpperCase()} ---`);
    console.log(`  ${strategy.description}`);
    console.log(
      `  Throughput: ${strategy.throughputOpsPerSec.toFixed(1)} ops/sec`,
    );
    console.log(`  Read p95: ${strategy.readMetric.p95Ms.toFixed(2)}ms`);
    console.log(`  Write p95: ${strategy.writeMetric.p95Ms.toFixed(2)}ms`);
    console.log(`  Write starvation: ${strategy.writeMetric.writeStarvation}`);
    console.log(`  Errors: ${strategy.writeMetric.errors}\n`);
  }

  console.log("========================================");
  console.log("  RECOMMENDATION");
  console.log("========================================\n");
  console.log(`Decision: ${report.recommendation.decision}`);
  console.log(`Strategy: ${report.recommendation.strategy}`);
  console.log(`Throughput gain: ${report.recommendation.throughputGainPct}%`);
  console.log(`Write starvation: ${report.recommendation.writeStarvation}`);
  console.log(`\nRationale: ${report.recommendation.rationale}`);
}

const args = process.argv.slice(2);
let outputPath: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) {
    outputPath = args[i + 1];
  }
}

async function main() {
  const report = await runBenchmark();
  printReport(report);

  if (outputPath) {
    const outDir = resolve(outputPath, "..");
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }
    writeFileSync(resolve(outputPath), JSON.stringify(report, null, 2));
    console.log(`\nReport saved to: ${outputPath}`);
  }

  if (report.recommendation.decision === "SKIP") {
    console.log(
      "\n[INFO] No strategy changes recommended. Current implementation is optimal.",
    );
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
