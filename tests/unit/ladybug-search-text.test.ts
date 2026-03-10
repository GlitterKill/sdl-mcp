import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(
  __dirname,
  "..",
  "..",
  ".lbug-search-text-test-db.lbug",
);

interface LadybugConnection {
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

async function cleanupTestDb(db: LadybugDatabase, conn: LadybugConnection): Promise<void> {
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

describe("KuzuDB search text queries", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let schema: typeof import("../../src/db/ladybug-schema.js");
  let queries: typeof import("../../src/db/ladybug-queries.js");

  beforeEach(async () => {
    ({ db, conn } = await createTestDb());
    schema = await import("../../src/db/ladybug-schema.js");
    queries = await import("../../src/db/ladybug-queries.js");
    await schema.createSchema(conn as unknown as import("kuzu").Connection);

    await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
      repoId: "repo",
      rootPath: "C:/repo",
      configJson: "{}",
      createdAt: "2026-03-06T00:00:00Z",
    });

    await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
      fileId: "file-1",
      repoId: "repo",
      relPath: "src/http.ts",
      contentHash: "file-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: null,
    });

    await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
      symbolId: "sym-handler",
      repoId: "repo",
      fileId: "file-1",
      kind: "function",
      name: "handleLogin",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 4,
      rangeEndCol: 0,
      astFingerprint: "fp-handler",
      signatureJson: null,
      summary: "Handles login requests",
      invariantsJson: null,
      sideEffectsJson: null,
      roleTagsJson: JSON.stringify(["handler", "entrypoint"]),
      searchText: "handle login requests handler entrypoint auth",
      updatedAt: "2026-03-06T00:00:00Z",
    });
  });

  afterEach(async () => {
    await cleanupTestDb(db, conn);
  });

  it("matches search queries against stored search text", async () => {
    const results = await queries.searchSymbolsLite(
      conn as unknown as import("kuzu").Connection,
      "repo",
      "entrypoint",
      10,
    );

    assert.deepStrictEqual(results, [
      {
        symbolId: "sym-handler",
        name: "handleLogin",
        fileId: "file-1",
        kind: "function",
      },
    ]);
  });
});
