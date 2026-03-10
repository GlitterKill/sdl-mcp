import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_DIR = join(__dirname, "..", "..", ".ladybug-contract-test-db");
const TEST_DB_PATH = join(TEST_DB_DIR, "contract.kuzu");

// Test vendor package contract directly - no SDL-MCP helpers
describe("Ladybug package contract", () => {
  let db: unknown = null;
  let conn: unknown = null;

  afterEach(async () => {
    // close in correct order: conn first, then db
    try {
      if (
        conn &&
        typeof (conn as { close: () => Promise<void> }).close === "function"
      ) {
        await (conn as { close: () => Promise<void> }).close();
      }
    } catch {
      /* best-effort */
    }
    try {
      if (
        db &&
        typeof (db as { close: () => Promise<void> }).close === "function"
      ) {
        await (db as { close: () => Promise<void> }).close();
      }
    } catch {
      /* best-effort */
    }
    conn = null;
    db = null;
    try {
      if (existsSync(TEST_DB_DIR)) {
        rmSync(TEST_DB_DIR, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
  });

  it("imports Database and Connection from aliased kuzu package", async () => {
    const kuzu = await import("kuzu");
    assert.ok(kuzu.Database, "Database class should be exported");
    assert.ok(kuzu.Connection, "Connection class should be exported");
  });

  it("creates Database with current 7-arg call shape", async () => {
    const kuzu = await import("kuzu");
    if (existsSync(TEST_DB_DIR)) {
      rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DB_DIR, { recursive: true });

    db = new kuzu.Database(TEST_DB_PATH);
    assert.ok(db, "Database instance should be truthy");
  });

  it("opens Connection and runs query returning single QueryResult", async () => {
    const kuzu = await import("kuzu");
    if (existsSync(TEST_DB_DIR)) {
      rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DB_DIR, { recursive: true });

    db = new kuzu.Database(TEST_DB_PATH);
    conn = new kuzu.Connection(db as import("kuzu").Database);

    const result = await (conn as import("kuzu").Connection).query(
      "RETURN 1 AS ok",
    );

    // Ladybug returns single QueryResult, not an array
    assert.ok(
      !Array.isArray(result),
      "query() should return single QueryResult, not array",
    );
    assert.ok(
      typeof result.hasNext === "function",
      "result should have hasNext()",
    );
    assert.ok(
      typeof result.getNext === "function",
      "result should have getNext()",
    );
    assert.ok(
      typeof result.getAll === "function",
      "result should have getAll()",
    );
    assert.ok(typeof result.close === "function", "result should have close()");

    const rows = await result.getAll();
    assert.ok(Array.isArray(rows), "getAll() should return array");
    assert.strictEqual(rows.length, 1, "should return one row");
    assert.strictEqual(Number(rows[0].ok), 1, "row should have ok=1");
    result.close();
  });

  it("runs prepared statement via prepare() + execute()", async () => {
    const kuzu = await import("kuzu");
    if (existsSync(TEST_DB_DIR)) {
      rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DB_DIR, { recursive: true });

    db = new kuzu.Database(TEST_DB_PATH);
    conn = new kuzu.Connection(db as import("kuzu").Database);
    const typedConn = conn as import("kuzu").Connection;

    const prepared = await typedConn.prepare("RETURN $val AS echo");
    assert.ok(prepared, "prepare() should return PreparedStatement");
    assert.ok(
      typeof prepared.isSuccess === "function",
      "should have isSuccess()",
    );

    const result = await typedConn.execute(prepared, { val: 42 });
    assert.ok(
      !Array.isArray(result),
      "execute() should return single QueryResult",
    );

    const rows = await result.getAll();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].echo), 42);
    result.close();
  });

  it("hasNext() and getNext() iteration works", async () => {
    const kuzu = await import("kuzu");
    if (existsSync(TEST_DB_DIR)) {
      rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DB_DIR, { recursive: true });

    db = new kuzu.Database(TEST_DB_PATH);
    conn = new kuzu.Connection(db as import("kuzu").Database);
    const typedConn = conn as import("kuzu").Connection;

    const result = (await typedConn.query(
      "UNWIND [1, 2, 3] AS x RETURN x",
    )) as import("kuzu").QueryResult;
    assert.strictEqual(result.hasNext(), true);

    const first = await result.getNext();
    assert.strictEqual(Number(first.x), 1);

    const second = await result.getNext();
    assert.strictEqual(Number(second.x), 2);

    const third = await result.getNext();
    assert.strictEqual(Number(third.x), 3);

    assert.strictEqual(result.hasNext(), false);
    result.close();
  });
});
