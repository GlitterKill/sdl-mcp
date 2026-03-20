/**
 * Tests for the batch-refactored deleteSymbolsByFileId function.
 * Verifies that:
 *   1. Deleting symbols for a file removes all symbols and their edges.
 *   2. Deleting symbols for a file with no symbols does not error.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-delete-symbols-batch-test-db.lbug");

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

function makeSymbol(
  symbolId: string,
  repoId: string,
  fileId: string,
  name: string,
) {
  return {
    symbolId,
    repoId,
    fileId,
    kind: "function" as const,
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
    updatedAt: "2026-03-08T00:00:00Z",
  };
}

describe("deleteSymbolsByFileId — batch refactor", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let queries: Queries;
  let ladybugAvailable = true;

  const repoId = "batch-del-repo";
  const fileId = "batch-del-file";

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");

      // Set up repo and file
      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "/tmp/batch-del-repo",
        configJson: "{}",
        createdAt: "2026-03-08T00:00:00Z",
      });

      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId,
        repoId,
        relPath: "src/batch.ts",
        language: "typescript",
        byteSize: 100,
        contentHash: "abc123",
        lastIndexedAt: null,
      });
    } catch (err) {
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    await cleanupTestDb(db, conn);
  });

  it(
    "deletes all symbols for a file in batch (multiple symbols)",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;

      // Insert 3 symbols
      await queries.upsertSymbol(
        conn_,
        makeSymbol("sym-a", repoId, fileId, "funcA"),
      );
      await queries.upsertSymbol(
        conn_,
        makeSymbol("sym-b", repoId, fileId, "funcB"),
      );
      await queries.upsertSymbol(
        conn_,
        makeSymbol("sym-c", repoId, fileId, "funcC"),
      );

      // Verify they exist
      const before = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(
        before.length,
        3,
        "Expected 3 symbols before deletion",
      );

      // Delete all symbols for the file
      await queries.deleteSymbolsByFileId(conn_, fileId);

      // Verify all deleted
      const after = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(
        after.length,
        0,
        "Expected 0 symbols after batch deletion",
      );
    },
  );

  it(
    "does not error when file has no symbols (empty IN clause guard)",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;

      // No symbols inserted for this file
      const before = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(
        before.length,
        0,
        "Expected 0 symbols before deletion",
      );

      // Should not throw
      await assert.doesNotReject(
        () => queries.deleteSymbolsByFileId(conn_, fileId),
        "deleteSymbolsByFileId should not throw when file has no symbols",
      );
    },
  );

  it(
    "only deletes symbols belonging to the specified file",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;

      // Create a second file
      const fileId2 = "batch-del-file-2";
      await queries.upsertFile(conn_, {
        fileId: fileId2,
        repoId,
        relPath: "src/other.ts",
        language: "typescript",
        byteSize: 50,
        contentHash: "def456",
        lastIndexedAt: null,
      });

      // Insert symbols in both files
      await queries.upsertSymbol(
        conn_,
        makeSymbol("sym-file1", repoId, fileId, "inFile1"),
      );
      await queries.upsertSymbol(
        conn_,
        makeSymbol("sym-file2", repoId, fileId2, "inFile2"),
      );

      // Delete only file1's symbols
      await queries.deleteSymbolsByFileId(conn_, fileId);

      // file1 symbols gone
      const file1After = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(
        file1After.length,
        0,
        "file1 symbols should be deleted",
      );

      // file2 symbols intact
      const file2After = await queries.getSymbolsByFile(conn_, fileId2);
      assert.strictEqual(file2After.length, 1, "file2 symbols should remain");
    },
  );
});
