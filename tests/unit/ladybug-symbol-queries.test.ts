import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, "..", "..", ".lbug-symbol-test-db.lbug");

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

async function exec(conn: LadybugConnection, q: string): Promise<void> {
  const result = await conn.query(q);
  result.close();
}

async function setupSchema(conn: LadybugConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/ladybug-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("LadybugDB Symbol Queries", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;

  const repoId = "sym-repo";
  const fileId = "sym-file";

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");

      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:/tmp/sym-repo",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00Z",
      });
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId,
        repoId,
        relPath: "src/file.ts",
        contentHash: "hash",
        language: "ts",
        byteSize: 10,
        lastIndexedAt: null,
      });
    } catch {
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    if (!ladybugAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it(
    "upsertSymbol/getSymbol round-trip with JSON fields",
    { skip: !ladybugAvailable },
    async () => {
      const symbolId = "sym-1";
      const signatureJson = JSON.stringify({ name: "fn", args: ["a", "b"] });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId,
        repoId,
        fileId,
        kind: "function",
        name: "myFn",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 10,
        rangeStartCol: 0,
        rangeEndLine: 20,
        rangeEndCol: 1,
        astFingerprint: "fp",
        signatureJson,
        summary: "hello",
        invariantsJson: JSON.stringify({ ok: true }),
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const symbol = await queries.getSymbol(
        conn as unknown as import("kuzu").Connection,
        symbolId,
      );
      assert.ok(symbol);
      assert.strictEqual(symbol.symbolId, symbolId);
      assert.strictEqual(symbol.fileId, fileId);
      assert.strictEqual(symbol.repoId, repoId);
      assert.strictEqual(symbol.signatureJson, signatureJson);
      assert.strictEqual(symbol.exported, true);
    },
  );

  it(
    "getSymbolsByFile/getSymbolsByRepo",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-a",
        repoId,
        fileId,
        kind: "function",
        name: "a",
        exported: false,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 10,
        astFingerprint: "a",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const byFile = await queries.getSymbolsByFile(
        conn as unknown as import("kuzu").Connection,
        fileId,
      );
      assert.strictEqual(byFile.length, 1);
      assert.strictEqual(byFile[0]!.symbolId, "sym-a");

      const byRepo = await queries.getSymbolsByRepo(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      assert.strictEqual(byRepo.length, 1);
      assert.strictEqual(byRepo[0]!.symbolId, "sym-a");
    },
  );

  it(
    "getSymbolsByIds handles 500+ IDs",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-batch-1",
        repoId,
        fileId,
        kind: "function",
        name: "b1",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 1,
        astFingerprint: "b1",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const ids: string[] = [];
      for (let i = 1; i <= 550; i++) {
        ids.push(`sym-batch-${i}`);
      }

      const result = await queries.getSymbolsByIds(
        conn as unknown as import("kuzu").Connection,
        ids,
      );

      assert.strictEqual(result.size, 1);
      assert.ok(result.has("sym-batch-1"));
    },
  );

  it(
    "findSymbolsInRange orders contained symbols first",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-range-outer",
        repoId,
        fileId,
        kind: "function",
        name: "outer",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 100,
        rangeEndCol: 0,
        astFingerprint: "o",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-range-inner",
        repoId,
        fileId,
        kind: "function",
        name: "inner",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 10,
        rangeStartCol: 0,
        rangeEndLine: 20,
        rangeEndCol: 0,
        astFingerprint: "i",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const found = await queries.findSymbolsInRange(
        conn as unknown as import("kuzu").Connection,
        repoId,
        fileId,
        9,
        21,
      );

      assert.ok(found.length >= 2);
      assert.strictEqual(found[0]!.symbolId, "sym-range-inner");
    },
  );

  it(
    "deleteSymbolsByFileId removes symbols but preserves file",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-del",
        repoId,
        fileId,
        kind: "function",
        name: "del",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 0,
        astFingerprint: "d",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.deleteSymbolsByFileId(
        conn as unknown as import("kuzu").Connection,
        fileId,
      );

      const symbolsAfter = await queries.getSymbolsByFile(
        conn as unknown as import("kuzu").Connection,
        fileId,
      );
      assert.strictEqual(symbolsAfter.length, 0);

      const fileAfter = await queries.getFileByRepoPath(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "src/file.ts",
      );
      assert.ok(fileAfter);
    },
  );

  it(
    "getSymbolsByRepoForSnapshot returns projection",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-snap",
        repoId,
        fileId,
        kind: "function",
        name: "snap",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 0,
        astFingerprint: "snapfp",
        signatureJson: "{}",
        summary: "s",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const rows = await queries.getSymbolsByRepoForSnapshot(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(Object.keys(rows[0]!).sort(), [
        "astFingerprint",
        "invariantsJson",
        "sideEffectsJson",
        "signatureJson",
        "summary",
        "symbolId",
      ]);
    },
  );

  it(
    "getSymbolCount counts symbols in repo",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-count",
        repoId,
        fileId,
        kind: "function",
        name: "count",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 0,
        astFingerprint: "c",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const count = await queries.getSymbolCount(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      assert.strictEqual(count, 1);
    },
  );
});
