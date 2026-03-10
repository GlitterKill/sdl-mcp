import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, "..", "..", ".lbug-search-test-db.lbug");

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

describe("LadybugDB Search Queries", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;

  const repoId = "search-repo";

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");

      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:/tmp/search-repo",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-core",
        repoId,
        relPath: "src/core.ts",
        contentHash: "h1",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-adapter",
        repoId,
        relPath: "src/adapter/adapter.ts",
        contentHash: "h2",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-foo-class",
        repoId,
        fileId: "file-core",
        kind: "class",
        name: "Foo",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 2,
        rangeEndCol: 0,
        astFingerprint: "a",
        signatureJson: null,
        summary: "core foo class",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-foo-fn",
        repoId,
        fileId: "file-core",
        kind: "function",
        name: "Foo",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 10,
        rangeStartCol: 0,
        rangeEndLine: 11,
        rangeEndCol: 0,
        astFingerprint: "b",
        signatureJson: null,
        summary: "core foo function",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-foo-adapter",
        repoId,
        fileId: "file-adapter",
        kind: "function",
        name: "Foo",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 0,
        astFingerprint: "c",
        signatureJson: null,
        summary: "adapter foo",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-barfoo",
        repoId,
        fileId: "file-core",
        kind: "function",
        name: "BarFoo",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 20,
        rangeStartCol: 0,
        rangeEndLine: 20,
        rangeEndCol: 0,
        astFingerprint: "d",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-summary-only",
        repoId,
        fileId: "file-core",
        kind: "function",
        name: "Baz",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 30,
        rangeStartCol: 0,
        rangeEndLine: 30,
        rangeEndCol: 0,
        astFingerprint: "e",
        signatureJson: null,
        summary: "mentions Foo in summary",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
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
    "exact match ranks first and kind priority applies",
    { skip: !ladybugAvailable },
    async () => {
      const results = await queries.searchSymbols(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "Foo",
        10,
      );

      assert.ok(results.length >= 2);
      assert.strictEqual(results[0]!.name, "Foo");
      assert.strictEqual(results[0]!.kind, "class");
      assert.strictEqual(results[1]!.name, "Foo");
    },
  );

  it(
    "case-insensitive exact match ranks ahead of partial matches",
    { skip: !ladybugAvailable },
    async () => {
      const results = await queries.searchSymbolsLite(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "foo",
        10,
      );

      assert.ok(results.length >= 2);
      assert.strictEqual(results[0]!.name, "Foo");
    },
  );

  it("deprioritizes adapter files", { skip: !ladybugAvailable }, async () => {
    const results = await queries.searchSymbolsLite(
      conn as unknown as import("kuzu").Connection,
      repoId,
      "Foo",
      10,
    );

    const firstAdapterIdx = results.findIndex(
      (r) => r.fileId === "file-adapter",
    );
    const firstCoreIdx = results.findIndex((r) => r.fileId === "file-core");
    assert.ok(firstCoreIdx !== -1);
    assert.ok(firstAdapterIdx !== -1);
    assert.ok(firstCoreIdx < firstAdapterIdx);
  });

  it("respects limit", { skip: !ladybugAvailable }, async () => {
    const results = await queries.searchSymbolsLite(
      conn as unknown as import("kuzu").Connection,
      repoId,
      "Foo",
      2,
    );
    assert.strictEqual(results.length, 2);
  });
});
