import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, describe, before, after } from "node:test";
import Database from "better-sqlite3";

const DB_BUSY_TIMEOUT_MS = 5000;

describe("SQLite Concurrency", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "sdl-sqlite-concurrency-"));
  const dbPath = join(tempDir, "concurrency.db");

  before(() => {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    db.pragma("foreign_keys = ON");

    db.exec(`
      CREATE TABLE IF NOT EXISTS test_symbols (
        symbol_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        name TEXT NOT NULL
      );
    `);

    const insert = db.prepare(
      "INSERT INTO test_symbols (symbol_id, repo_id, name) VALUES (?, ?, ?)",
    );
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 100; i++) {
        insert.run(`sym-${i}`, "test-repo", `function${i}`);
      }
    });
    insertMany();
    db.close();
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("concurrent index refresh + slice queries should not deadlock", async () => {
    const readerDbs: Database.Database[] = [];
    for (let i = 0; i < 4; i++) {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
      readerDbs.push(db);
    }

    const writerDb = new Database(dbPath);
    writerDb.pragma("journal_mode = WAL");
    writerDb.pragma("synchronous = NORMAL");
    writerDb.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);

    const selectQuery = readerDbs[0].prepare(
      "SELECT * FROM test_symbols WHERE repo_id = ? LIMIT 20",
    );
    const updateQuery = writerDb.prepare(
      "UPDATE test_symbols SET name = ? WHERE symbol_id = ?",
    );

    const errors: Error[] = [];
    const operations: Promise<void>[] = [];

    for (let i = 0; i < 20; i++) {
      operations.push(
        (async () => {
          try {
            const results = selectQuery.all("test-repo");
            assert.ok(results.length > 0);
          } catch (e) {
            errors.push(e as Error);
          }
        })(),
      );

      operations.push(
        (async () => {
          try {
            updateQuery.run(`updated-${i}`, `sym-${i % 100}`);
          } catch (e) {
            errors.push(e as Error);
          }
        })(),
      );
    }

    await Promise.all(operations);

    for (const db of readerDbs) {
      db.close();
    }
    writerDb.close();

    assert.strictEqual(
      errors.length,
      0,
      `Errors during concurrent operations: ${errors.map((e) => e.message).join(", ")}`,
    );
  });

  test("lock timeout should produce clear error message", () => {
    const db1 = new Database(dbPath);
    db1.pragma("journal_mode = WAL");
    db1.pragma("synchronous = NORMAL");
    db1.pragma("busy_timeout = 1");
    db1.exec("BEGIN EXCLUSIVE");

    const db2 = new Database(dbPath);
    db2.pragma("busy_timeout = 1");

    let errorThrown = false;
    let errorMessage = "";
    try {
      db2.exec(
        "UPDATE test_symbols SET name = 'blocked' WHERE symbol_id = 'sym-0'",
      );
    } catch (e) {
      errorThrown = true;
      errorMessage = (e as Error).message;
    }

    db1.exec("ROLLBACK");
    db1.close();
    db2.close();

    assert.ok(errorThrown, "Expected lock timeout error");
    assert.ok(
      errorMessage.includes("busy") ||
        errorMessage.includes("locked") ||
        errorMessage.includes("SQLITE_BUSY"),
      `Error message should indicate lock/busy state: ${errorMessage}`,
    );
  });

  test("WAL mode allows concurrent readers during write", async () => {
    const writerDb = new Database(dbPath);
    writerDb.pragma("journal_mode = WAL");
    writerDb.pragma("synchronous = NORMAL");
    writerDb.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);

    const readerDb = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    readerDb.pragma(`busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);

    const selectQuery = readerDb.prepare(
      "SELECT COUNT(*) as count FROM test_symbols",
    );
    const updateQuery = writerDb.prepare(
      "UPDATE test_symbols SET name = name || '-updated'",
    );

    const results: number[] = [];
    let writeCompleted = false;

    const writePromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      updateQuery.run();
      writeCompleted = true;
    })();

    const readPromise = (async () => {
      for (let i = 0; i < 10; i++) {
        const row = selectQuery.get() as { count: number };
        results.push(row.count);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();

    await Promise.all([writePromise, readPromise]);

    writerDb.close();
    readerDb.close();

    assert.ok(writeCompleted, "Write should complete");
    assert.strictEqual(results.length, 10, "All reads should complete");
    assert.ok(
      results.every((c) => c === 100),
      "Readers should see consistent data during write",
    );
  });

  test("benchmark script executes successfully and produces report", () => {
    const repoRoot = resolve(".");

    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/benchmark/sqlite-concurrency.ts"],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 120000,
      },
    );

    assert.strictEqual(
      run.status,
      0,
      `Benchmark script failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );

    assert.ok(
      run.stdout.includes("SQLITE CONCURRENCY BENCHMARK RESULTS"),
      "Output should contain benchmark header",
    );
    assert.ok(
      run.stdout.includes("single-connection") ||
        run.stdout.includes("SINGLE-CONNECTION"),
      "Output should test single-connection strategy",
    );
    assert.ok(
      run.stdout.includes("recommendation") ||
        run.stdout.includes("RECOMMENDATION") ||
        run.stdout.includes("Decision:"),
      "Output should contain recommendation",
    );
    assert.ok(
      run.stdout.includes("ADOPT") || run.stdout.includes("SKIP"),
      "Output should contain ADOPT or SKIP decision",
    );
  });

  test("benchmark script outputs valid JSON with --out flag", () => {
    const repoRoot = resolve(".");
    const outPath = join(tempDir, "benchmark-output.json");

    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/benchmark/sqlite-concurrency.ts",
        "--out",
        outPath,
      ],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 120000,
      },
    );

    assert.strictEqual(
      run.status,
      0,
      `Benchmark script failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );

    const report = JSON.parse(readFileSync(outPath, "utf-8")) as {
      version: string;
      strategies: Array<{
        strategy: string;
        throughputOpsPerSec: number;
        readMetric: { p95Ms: number };
        writeMetric: { writeStarvation: number };
      }>;
      recommendation: {
        strategy: string;
        throughputGainPct: number;
        writeStarvation: number;
        decision: "ADOPT" | "SKIP";
        rationale: string;
      };
    };

    assert.ok(report.version, "Report should have version");
    assert.ok(
      Array.isArray(report.strategies),
      "Report should have strategies array",
    );
    assert.ok(
      report.strategies.length >= 1,
      "Report should have at least one strategy",
    );
    assert.ok(
      report.recommendation.decision === "ADOPT" ||
        report.recommendation.decision === "SKIP",
      "Recommendation should be ADOPT or SKIP",
    );

    for (const strategy of report.strategies) {
      assert.ok(
        typeof strategy.throughputOpsPerSec === "number",
        `Strategy ${strategy.strategy} should have throughput metric`,
      );
      assert.ok(
        typeof strategy.readMetric.p95Ms === "number",
        `Strategy ${strategy.strategy} should have read p95 metric`,
      );
      assert.ok(
        typeof strategy.writeMetric.writeStarvation === "number",
        `Strategy ${strategy.strategy} should have write starvation count`,
      );
    }
  });
});
