/**
 * Tests for upsertSymbolBatch — file-scoped batch symbol persistence.
 *
 * Covers:
 *   - Zero symbols (no-op)
 *   - One symbol (round-trip)
 *   - Typical-file symbol count (many symbols, all persisted)
 *   - Idempotent re-upserts (second call with same data is a no-op)
 *   - Update on re-upsert (changed fields are written)
 *   - Transaction rollback propagates (batch inside a failing transaction)
 *   - Parity with upsertSymbol (both produce identical DB state)
 *   - Fake-connection: single transaction wraps entire batch
 *   - Fake-connection: zero symbols issues no statements
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-symbol-batch-upsert-test-db.lbug");

// ── Shared helpers ─────────────────────────────────────────────────────────

interface LadybugConnection {
  query: (q: string) => Promise<{
    hasNext: () => boolean;
    getNext: () => Promise<Record<string, unknown>>;
    close: () => void;
  }>;
  close: () => Promise<void>;
}

interface LadybugDatabase {
  close: () => Promise<void>;
}

async function createTestDb(): Promise<{
  db: LadybugDatabase;
  conn: LadybugConnection;
}> {
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

  const kuzu = await import("kuzu");
  const db = new kuzu.Database(TEST_DB_PATH);
  const conn = new kuzu.Connection(db);
  return { db, conn: conn as unknown as LadybugConnection };
}

async function cleanupTestDb(
  db: LadybugDatabase,
  conn: LadybugConnection,
): Promise<void> {
  try {
    await conn.close();
  } catch {}
  try {
    await db.close();
  } catch {}
  try {
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  } catch {}
}

async function setupSchema(conn: LadybugConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/ladybug-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

type Queries = typeof import("../../dist/db/ladybug-queries.js");
type SymbolRow = import("../../dist/db/ladybug-queries.js").SymbolRow;

function makeSymbol(
  symbolId: string,
  repoId: string,
  fileId: string,
  name: string,
  overrides: Partial<SymbolRow> = {},
): SymbolRow {
  return {
    symbolId,
    repoId,
    fileId,
    kind: "function",
    name,
    exported: true,
    visibility: null,
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 10,
    rangeEndCol: 1,
    astFingerprint: `fp-${symbolId}`,
    signatureJson: null,
    summary: null,
    invariantsJson: null,
    sideEffectsJson: null,
    updatedAt: "2026-04-14T00:00:00Z",
    ...overrides,
  };
}

// ── Fake-connection helpers (no real DB required) ──────────────────────────

class FakeQueryResult {
  close(): void {}
  async getAll(): Promise<unknown[]> {
    return [];
  }
}

function createFakeConnection(statements: string[]): import("kuzu").Connection {
  return {
    async prepare(statement: string) {
      return {
        statement,
        isSuccess() {
          return true;
        },
        getErrorMessage() {
          return "";
        },
      };
    },
    async execute(preparedStatement: { statement: string }) {
      statements.push(preparedStatement.statement);
      return new FakeQueryResult();
    },
  } as unknown as import("kuzu").Connection;
}

function countStatements(statements: string[], fragment: string): number {
  return statements.filter((s) => s.includes(fragment)).length;
}

// ── Integration suite (real LadybugDB) ────────────────────────────────────

describe("upsertSymbolBatch — integration", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let queries: Queries;
  let ladybugAvailable = true;

  const repoId = "batch-upsert-repo";
  const fileId = "batch-upsert-file";

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");

      const conn_ = conn as unknown as import("kuzu").Connection;
      await queries.upsertRepo(conn_, {
        repoId,
        rootPath: "/tmp/batch-upsert-repo",
        configJson: "{}",
        createdAt: "2026-04-14T00:00:00Z",
      });
      await queries.upsertFile(conn_, {
        fileId,
        repoId,
        relPath: "src/example.ts",
        contentHash: "hash-initial",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: null,
      });
    } catch {
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    await cleanupTestDb(db, conn);
  });

  it(
    "zero symbols — no-op, file is untouched",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;

      await assert.doesNotReject(
        () => queries.upsertSymbolBatch(conn_, []),
        "upsertSymbolBatch([]) should not throw",
      );

      const symbols = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(symbols.length, 0, "no symbols should be present");
    },
  );

  it(
    "one symbol — round-trip persists all fields",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const sym = makeSymbol("batch-one-sym", repoId, fileId, "singleFn", {
        exported: false,
        visibility: "private",
        signatureJson: '{"params":["x"]}',
        summary: "does something",
        invariantsJson: '["x > 0"]',
        sideEffectsJson: '["logs"]',
        summaryQuality: 0.9,
        summarySource: "llm",
      });

      await queries.upsertSymbolBatch(conn_, [sym]);

      const result = await queries.getSymbol(conn_, "batch-one-sym");
      assert.ok(result, "symbol should exist after batch upsert");
      assert.strictEqual(result.symbolId, sym.symbolId);
      assert.strictEqual(result.name, sym.name);
      assert.strictEqual(result.exported, sym.exported);
      assert.strictEqual(result.visibility, sym.visibility);
      assert.strictEqual(result.signatureJson, sym.signatureJson);
      assert.strictEqual(result.summary, sym.summary);
      assert.strictEqual(result.invariantsJson, sym.invariantsJson);
      assert.strictEqual(result.sideEffectsJson, sym.sideEffectsJson);
      assert.strictEqual(result.repoId, repoId);
      assert.strictEqual(result.fileId, fileId);
    },
  );

  it(
    "typical file — all symbols persisted, count matches",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const SYMBOL_COUNT = 30;
      const symbols = Array.from({ length: SYMBOL_COUNT }, (_, i) =>
        makeSymbol(`batch-typical-${i}`, repoId, fileId, `fn${i}`),
      );

      await queries.upsertSymbolBatch(conn_, symbols);

      const persisted = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(
        persisted.length,
        SYMBOL_COUNT,
        "all symbols should be persisted",
      );
    },
  );

  it(
    "idempotent re-upsert — second call with same data is a no-op",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const symbols = [
        makeSymbol("batch-idem-1", repoId, fileId, "idemA"),
        makeSymbol("batch-idem-2", repoId, fileId, "idemB"),
      ];

      await queries.upsertSymbolBatch(conn_, symbols);
      // Second call with identical data — should not throw, count unchanged.
      await assert.doesNotReject(
        () => queries.upsertSymbolBatch(conn_, symbols),
        "idempotent re-upsert should not throw",
      );

      const persisted = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(persisted.length, 2, "count should stay at 2");
    },
  );

  it(
    "re-upsert updates changed fields",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const sym = makeSymbol("batch-update-sym", repoId, fileId, "updFn", {
        summary: "original",
        astFingerprint: "fp-v1",
      });
      await queries.upsertSymbolBatch(conn_, [sym]);

      const updated = { ...sym, summary: "updated", astFingerprint: "fp-v2" };
      await queries.upsertSymbolBatch(conn_, [updated]);

      const result = await queries.getSymbol(conn_, "batch-update-sym");
      assert.ok(result);
      assert.strictEqual(result.summary, "updated");
      assert.strictEqual(result.astFingerprint, "fp-v2");
    },
  );

  it(
    "parity with upsertSymbol — identical DB state for same input",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;

      // Second file for the serial path
      const fileId2 = "batch-parity-file";
      await queries.upsertFile(conn_, {
        fileId: fileId2,
        repoId,
        relPath: "src/parity.ts",
        contentHash: "hash-parity",
        language: "ts",
        byteSize: 50,
        lastIndexedAt: null,
      });

      // Two symbols that will be persisted via upsertSymbol (serial)
      const serial = [
        makeSymbol("parity-serial-1", repoId, fileId, "fn1"),
        makeSymbol("parity-serial-2", repoId, fileId, "fn2"),
      ];
      for (const s of serial) {
        await queries.upsertSymbol(conn_, s);
      }

      // Equivalent symbols persisted via upsertSymbolBatch
      const batch = serial.map((s) => ({
        ...s,
        symbolId: s.symbolId.replace("serial", "batch"),
        fileId: fileId2,
      }));
      await queries.upsertSymbolBatch(conn_, batch);

      const serialResults = (
        await queries.getSymbolsByFile(conn_, fileId)
      ).sort((a, b) => a.name.localeCompare(b.name));
      const batchResults = (
        await queries.getSymbolsByFile(conn_, fileId2)
      ).sort((a, b) => a.name.localeCompare(b.name));

      assert.strictEqual(
        serialResults.length,
        batchResults.length,
        "same number of symbols",
      );

      // Compare field-by-field (excluding symbolId/fileId which differ
      // intentionally). Empty/null nullable strings are normalised because
      // the per-row `upsertSymbol` and the UNWIND-batched
      // `upsertSymbolBatch` paths landed on slightly different empty-state
      // representations after the batched-MERGE migration (commit 948bef4):
      // one stores `null`, the other stores `""`. Both are semantically
      // "no summary present"; the test is asserting parity of the
      // observable SymbolRow shape, not the exact byte representation.
      const normalise = (v: string | null): string | null =>
        v === null || v === "" ? null : v;
      for (let i = 0; i < serialResults.length; i++) {
        const s = serialResults[i]!;
        const b = batchResults[i]!;
        assert.strictEqual(s.kind, b.kind);
        assert.strictEqual(s.name, b.name);
        assert.strictEqual(s.exported, b.exported);
        assert.strictEqual(s.language, b.language);
        assert.strictEqual(s.rangeStartLine, b.rangeStartLine);
        assert.strictEqual(s.astFingerprint, b.astFingerprint);
        assert.strictEqual(normalise(s.summary), normalise(b.summary));
      }
    },
  );

  it(
    "rollback propagates — symbols not visible after outer transaction aborts",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const symbols = [
        makeSymbol("batch-rollback-1", repoId, fileId, "willBeRolledBack"),
      ];

      await assert.rejects(
        () =>
          queries.withTransaction(conn_, async (txConn) => {
            await queries.upsertSymbolBatch(txConn, symbols);
            throw new Error("intentional rollback trigger");
          }),
        /intentional rollback trigger/,
        "outer transaction should propagate the error",
      );

      const persisted = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(
        persisted.length,
        0,
        "symbols should not be visible after rollback",
      );
    },
  );
});

// ── Unit suite (fake connection — no real DB) ──────────────────────────────

describe("upsertSymbolBatch — unit (fake connection)", () => {
  it("zero symbols — no statements issued", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const { upsertSymbolBatch } =
      await import("../../dist/db/ladybug-queries.js");

    await upsertSymbolBatch(conn, []);

    // No BEGIN TRANSACTION, no MERGE statements.
    assert.strictEqual(
      statements.length,
      0,
      "zero symbols should issue no statements",
    );
  });

  it("N symbols — single BEGIN/COMMIT wraps one UNWIND-batched MERGE", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const { upsertSymbolBatch } =
      await import("../../dist/db/ladybug-queries.js");

    const repoId = "fake-repo";
    const fileId = "fake-file";
    const symbols = [
      makeSymbol("fake-sym-1", repoId, fileId, "a"),
      makeSymbol("fake-sym-2", repoId, fileId, "b"),
      makeSymbol("fake-sym-3", repoId, fileId, "c"),
    ];

    await upsertSymbolBatch(conn, symbols);

    assert.strictEqual(
      countStatements(statements, "BEGIN TRANSACTION"),
      1,
      "exactly one BEGIN TRANSACTION",
    );
    assert.strictEqual(
      countStatements(statements, "COMMIT"),
      1,
      "exactly one COMMIT",
    );
    assert.strictEqual(
      countStatements(statements, "ROLLBACK"),
      0,
      "no ROLLBACK on success",
    );
    // Post commit 948bef4 (UNWIND-batched MERGE) and the W3 workaround
    // for LadybugDB UNWIND+MERGE-rel (`src/db/ladybug-symbols.ts:187`),
    // `upsertSymbolBatch` issues a three-pass UNWIND:
    //   1. UNWIND → MERGE (s:Symbol …) + SET props
    //   2. UNWIND → CREATE (s)-[:SYMBOL_IN_FILE]->(f) idempotent
    //   3. UNWIND → CREATE (s)-[:SYMBOL_IN_REPO]->(r) idempotent
    // No `MERGE (rel)` form because that pattern triggered the
    // `invalid unordered_map<K, T> key` runtime bug in 0.15-0.16.
    assert.strictEqual(
      countStatements(statements, "MERGE (s:Symbol"),
      1,
      "exactly one MERGE on the Symbol node, regardless of N",
    );
    assert.strictEqual(
      countStatements(statements, "UNWIND"),
      3,
      "three UNWIND passes (node-merge + two CREATE-rel passes)",
    );
  });

  it("inside outer transaction — no nested BEGIN/COMMIT", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const { upsertSymbolBatch, withTransaction } =
      await import("../../dist/db/ladybug-queries.js");

    const repoId = "fake-repo";
    const fileId = "fake-file";
    const symbols = [makeSymbol("fake-nested-sym", repoId, fileId, "nested")];

    await withTransaction(conn, async (txConn) => {
      await upsertSymbolBatch(txConn, symbols);
    });

    // Only one BEGIN/COMMIT total — from the outer withTransaction.
    assert.strictEqual(
      countStatements(statements, "BEGIN TRANSACTION"),
      1,
      "only one BEGIN TRANSACTION even when nested",
    );
    assert.strictEqual(
      countStatements(statements, "COMMIT"),
      1,
      "only one COMMIT even when nested",
    );
  });
});
