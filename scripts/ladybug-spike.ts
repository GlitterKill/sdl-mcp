#!/usr/bin/env tsx
/**
 * Ladybug Windows Feasibility Spike (T0.1)
 *
 * Validates the Ladybug-backed kuzu npm package on Windows/Node 22 for SDL-MCP graph storage.
 *
 * Tests:
 * - On-disk database creation
 * - Node tables with STRING primary keys
 * - Rel tables with properties (weight, type, confidence)
 * - 10K symbol nodes + 100K dependency edges
 * - 3-hop Cypher BFS query performance
 *
 * Done criteria:
 * - Script runs on Windows without DLL/binding errors
 * - 3-hop BFS on 10K nodes completes in < 500ms
 *
 * Usage:
 *   tsx scripts/kuzu-spike.ts
 */

import { existsSync, rmSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SpikeResult {
  test: string;
  passed: boolean;
  durationMs: number;
  message: string;
  error?: string;
}

const results: SpikeResult[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function closeQueryResult(result: unknown): Promise<void> {
  if (!result || typeof result !== "object") return;

  const close = (result as { close?: unknown }).close;
  if (typeof close !== "function") return;

  try {
    await (result as { close: () => unknown }).close();
  } catch {
    // best-effort cleanup; spike should not fail due to close issues
  }
}

function recordResult(
  test: string,
  passed: boolean,
  durationMs: number,
  message: string,
  error?: string,
): void {
  results.push({ test, passed, durationMs, message, error });
}

async function runSpike(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Ladybug Windows Feasibility Spike");
  console.log("=".repeat(60));
  console.log(`Platform: ${process.platform}`);
  console.log(`Node: ${process.version}`);
  console.log(`Arch: ${process.arch}`);
  console.log("=".repeat(60));
  console.log();

  const dbPath = join(__dirname, "..", ".lbug-spike-db");
  let db: unknown = null;
  let conn: unknown = null;

  try {
    const kuzu = await import("kuzu");
    console.log("[OK] kuzu package loaded successfully");
    console.log();

    const startTime = performance.now();

    try {
      if (existsSync(dbPath)) {
        rmSync(dbPath, { recursive: true, force: true });
      }
      mkdirSync(dbPath, { recursive: true });
      console.log(`[OK] Created test directory: ${dbPath}`);
    } catch (err) {
      recordResult(
        "directory_setup",
        false,
        0,
        "Failed to create test directory",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    const testStart = performance.now();
    try {
      db = new kuzu.Database(dbPath);
      conn = new kuzu.Connection(db as import("kuzu").Database);
      recordResult(
        "db_init",
        true,
        performance.now() - testStart,
        "On-disk database and connection created",
      );
    } catch (err) {
      recordResult(
        "db_init",
        false,
        performance.now() - testStart,
        "Failed to initialize database",
        err instanceof Error ? err.message : String(err),
      );
      if (
        err instanceof Error &&
        (err.message.includes("DLL") ||
          err.message.includes("binding") ||
          err.message.includes("Cannot find module"))
      ) {
        console.log("\n[FAIL] Native binding error detected!");
        console.log(
          "Recommendation: Verify @ladybugdb/core-backed kuzu package availability",
        );
        console.log("Error details:", err.message);
      }
      throw err;
    }

    const createSymbolTable = `
      CREATE NODE TABLE Symbol (
        id STRING PRIMARY KEY,
        name STRING,
        filePath STRING,
        kind STRING,
        startLine INT64,
        endLine INT64,
        signature STRING,
        summary STRING
      )
    `;
    const tableStart = performance.now();
    try {
      const result = await (
        conn as { query: (q: string) => Promise<unknown> }
      ).query(createSymbolTable);
      await closeQueryResult(result);
      recordResult(
        "node_table_string_pk",
        true,
        performance.now() - tableStart,
        "Symbol node table with STRING primary key created",
      );
    } catch (err) {
      recordResult(
        "node_table_string_pk",
        false,
        performance.now() - tableStart,
        "Failed to create Symbol node table",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    const createDependsTable = `
      CREATE REL TABLE DEPENDS (
        FROM Symbol TO Symbol,
        weight DOUBLE DEFAULT 1.0,
        type STRING DEFAULT 'call',
        confidence DOUBLE DEFAULT 1.0
      )
    `;
    const relStart = performance.now();
    try {
      const result = await (
        conn as { query: (q: string) => Promise<unknown> }
      ).query(createDependsTable);
      await closeQueryResult(result);
      recordResult(
        "rel_table_with_props",
        true,
        performance.now() - relStart,
        "Depends rel table with properties (weight, type, confidence) created",
      );
    } catch (err) {
      recordResult(
        "rel_table_with_props",
        false,
        performance.now() - relStart,
        "Failed to create Depends rel table",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    const NODE_COUNT = 10_000;
    const EDGE_COUNT = 100_000;

    console.log(`Inserting ${NODE_COUNT} symbol nodes (batch mode)...`);
    const insertNodesStart = performance.now();
    try {
      const batchSize = 1000;
      for (let batch = 0; batch < NODE_COUNT / batchSize; batch++) {
        const start = batch * batchSize + 1;
        const end = start + batchSize - 1;
        const insertQuery = `
          UNWIND range(${start}, ${end}) AS i
          CREATE (s:Symbol {
            id: 'symbol_' + cast(i, 'STRING'),
            name: 'func_' + cast(i, 'STRING'),
            filePath: '/src/module_' + cast(i % 100, 'STRING') + '.ts',
            kind: CASE i % 5
              WHEN 0 THEN 'function'
              WHEN 1 THEN 'class'
              WHEN 2 THEN 'method'
              WHEN 3 THEN 'interface'
              ELSE 'variable'
            END,
            startLine: i,
            endLine: i + 10,
            signature: 'function func_' + cast(i, 'STRING') + '(): void',
            summary: 'Summary for symbol ' + cast(i, 'STRING')
          })
        `;
        const result = await (
          conn as { query: (q: string) => Promise<unknown> }
        ).query(insertQuery);
        await closeQueryResult(result);
      }
      recordResult(
        "insert_10k_nodes",
        true,
        performance.now() - insertNodesStart,
        `Inserted ${NODE_COUNT} symbol nodes in ${NODE_COUNT / batchSize} batches`,
      );
    } catch (err) {
      recordResult(
        "insert_10k_nodes",
        false,
        performance.now() - insertNodesStart,
        "Failed to insert symbol nodes",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    console.log(`Inserting ${EDGE_COUNT} dependency edges (batch mode)...`);
    const insertEdgesStart = performance.now();
    try {
      const batchSize = 5000;
      for (let batch = 0; batch < EDGE_COUNT / batchSize; batch++) {
        const start = batch * batchSize + 1;
        const end = start + batchSize - 1;
        const insertEdgesQuery = `
          UNWIND range(${start}, ${end}) AS i
          MATCH (from:Symbol {id: 'symbol_' + cast((i % ${NODE_COUNT}) + 1, 'STRING')})
          MATCH (to:Symbol {id: 'symbol_' + cast(((i * 7) % ${NODE_COUNT}) + 1, 'STRING')})
          CREATE (from)-[e:DEPENDS {
            weight: to_float(i % 10) / 10.0 + 0.1,
            type: CASE i % 3
              WHEN 0 THEN 'call'
              WHEN 1 THEN 'import'
              ELSE 'config'
            END,
            confidence: to_float(i % 5) / 5.0 + 0.2
          }]->(to)
        `;
        const result = await (
          conn as { query: (q: string) => Promise<unknown> }
        ).query(insertEdgesQuery);
        await closeQueryResult(result);
      }
      recordResult(
        "insert_100k_edges",
        true,
        performance.now() - insertEdgesStart,
        `Inserted ${EDGE_COUNT} dependency edges in ${EDGE_COUNT / batchSize} batches`,
      );
    } catch (err) {
      recordResult(
        "insert_100k_edges",
        false,
        performance.now() - insertEdgesStart,
        "Failed to insert dependency edges",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    console.log("Running 3-hop BFS query...");
    const bfsQuery = `
      MATCH (start:Symbol {id: 'symbol_1'})-[:DEPENDS*1..3]->(target:Symbol)
      RETURN DISTINCT target.id, target.name, target.filePath
      ORDER BY target.id
      LIMIT 100
    `;

    const BFS_TARGET_MS = 500;
    const bfsStart = performance.now();
    try {
      const result = await (
        conn as { query: (q: string) => Promise<unknown> }
      ).query(bfsQuery);
      const rows: unknown[] = [];
      const qr = result as {
        hasNext: () => boolean;
        getNext: () => Promise<unknown>;
        close?: () => unknown;
      };
      while (qr.hasNext()) {
        rows.push(await qr.getNext());
      }
      await closeQueryResult(result);
      const bfsDuration = performance.now() - bfsStart;

      const passed = bfsDuration < BFS_TARGET_MS;
      recordResult(
        "3hop_bfs_performance",
        passed,
        bfsDuration,
        `3-hop BFS returned ${rows.length} results in ${bfsDuration.toFixed(2)}ms (target: <${BFS_TARGET_MS}ms)`,
        passed ? undefined : `Exceeded ${BFS_TARGET_MS}ms target`,
      );
    } catch (err) {
      recordResult(
        "3hop_bfs_performance",
        false,
        performance.now() - bfsStart,
        "3-hop BFS query failed",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    const countStart = performance.now();
    try {
      const nodeCountResult = await (
        conn as { query: (q: string) => Promise<unknown> }
      ).query("MATCH (s:Symbol) RETURN count(s) AS cnt");
      const nodeCountRow = await (
        nodeCountResult as { getNext: () => Promise<Record<string, unknown>> }
      ).getNext();
      const actualNodeCount = Number(nodeCountRow["cnt"]);
      await closeQueryResult(nodeCountResult);

      const edgeCountResult = await (
        conn as { query: (q: string) => Promise<unknown> }
      ).query("MATCH ()-[e:DEPENDS]->() RETURN count(e) AS cnt");
      const edgeCountRow = await (
        edgeCountResult as { getNext: () => Promise<Record<string, unknown>> }
      ).getNext();
      const actualEdgeCount = Number(edgeCountRow["cnt"]);
      await closeQueryResult(edgeCountResult);

      recordResult(
        "data_integrity",
        true,
        performance.now() - countStart,
        `Verified: ${actualNodeCount} nodes, ${actualEdgeCount} edges`,
      );

      assert(
        actualNodeCount === NODE_COUNT,
        `Expected ${NODE_COUNT} nodes, got ${actualNodeCount}`,
      );
      assert(
        actualEdgeCount === EDGE_COUNT,
        `Expected ${EDGE_COUNT} edges, got ${actualEdgeCount}`,
      );
    } catch (err) {
      recordResult(
        "data_integrity",
        false,
        performance.now() - countStart,
        "Data integrity check failed",
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    const totalDuration = performance.now() - startTime;

    console.log("\n" + "=".repeat(60));
    console.log("SPIKE RESULTS");
    console.log("=".repeat(60));

    let allPassed = true;
    for (const result of results) {
      const status = result.passed ? "PASS" : "FAIL";
      const color = result.passed ? "\x1b[32m" : "\x1b[31m";
      console.log(
        `${color}[${status}]\x1b[0m ${result.test} (${result.durationMs.toFixed(2)}ms)`,
      );
      console.log(`       ${result.message}`);
      if (result.error) {
        console.log(`       Error: ${result.error}`);
      }
      if (!result.passed) {
        allPassed = false;
      }
    }

    console.log("=".repeat(60));
    console.log(`Total duration: ${totalDuration.toFixed(2)}ms`);
    console.log(
      `Overall: ${allPassed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}`,
    );
    console.log("=".repeat(60));

    if (!allPassed) {
      process.exit(1);
    }
  } catch (err) {
    console.log("\n" + "=".repeat(60));
    console.log("SPIKE RESULTS (PARTIAL - ABORTED)");
    console.log("=".repeat(60));

    for (const result of results) {
      const status = result.passed ? "PASS" : "FAIL";
      const color = result.passed ? "\x1b[32m" : "\x1b[31m";
      console.log(
        `${color}[${status}]\x1b[0m ${result.test} (${result.durationMs.toFixed(2)}ms)`,
      );
      console.log(`       ${result.message}`);
      if (result.error) {
        console.log(`       Error: ${result.error}`);
      }
    }

    console.log("=".repeat(60));
    console.log("\x1b[31mOVERALL: FAIL\x1b[0m");
    console.log("=".repeat(60));

    if (
      err instanceof Error &&
      (err.message.includes("DLL") || err.message.includes("binding"))
    ) {
      console.log("\n[ANALYSIS] Native binding failure on Windows");
      console.log(
        "Recommendation: Verify @ladybugdb/core-backed kuzu package availability",
      );
      console.log(
        "Alternative: Use WASM build for cross-platform compatibility",
      );
    }

    process.exit(1);
  } finally {
    try {
      if (conn) {
        await (conn as { close: () => Promise<void> }).close();
      }
      if (db) {
        await (db as { close: () => Promise<void> }).close();
      }
    } catch {}

    if (process.env["KUZU_SPIKE_CLEANUP"] === "1") {
      try {
        if (existsSync(dbPath)) {
          rmSync(dbPath, { recursive: true, force: true });
          console.log("\n[OK] Cleaned up test database");
        }
      } catch (cleanupErr) {
        console.log(
          "\n[WARN] Could not cleanup test database:",
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        );
      }
    } else {
      console.log(
        `\n[NOTE] Leaving test database on disk at ${dbPath} (set KUZU_SPIKE_CLEANUP=1 to delete)`,
      );
    }
  }
}

runSpike().catch((err) => {
  console.error("Spike failed with unhandled error:", err);
  process.exit(1);
});
