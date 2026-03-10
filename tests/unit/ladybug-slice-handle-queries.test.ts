import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, "..", "..", ".lbug-slice-handle-test-db.lbug");

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

async function setupSchema(conn: LadybugConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/ladybug-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("KuzuDB Slice Handle & Cache Queries", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");
    } catch {
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    if (!ladybugAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it("upsertSliceHandle/getSliceHandle round-trip", { skip: !ladybugAvailable }, async () => {
    await queries.upsertSliceHandle(conn as unknown as import("kuzu").Connection, {
      handle: "h1",
      repoId: "repo",
      createdAt: "2026-03-04T00:00:00Z",
      expiresAt: "2026-03-05T00:00:00Z",
      minVersion: null,
      maxVersion: null,
      sliceHash: "hash",
      spilloverRef: null,
    });

    const row = await queries.getSliceHandle(conn as unknown as import("kuzu").Connection, "h1");
    assert.ok(row);
    assert.strictEqual(row.handle, "h1");
    assert.strictEqual(row.repoId, "repo");
  });

  it("deleteExpiredSliceHandles removes expired handles", { skip: !ladybugAvailable }, async () => {
    await queries.upsertSliceHandle(conn as unknown as import("kuzu").Connection, {
      handle: "expired",
      repoId: "repo",
      createdAt: "2026-03-04T00:00:00Z",
      expiresAt: "2026-03-04T00:00:00Z",
      minVersion: null,
      maxVersion: null,
      sliceHash: "hash",
      spilloverRef: null,
    });
    await queries.upsertSliceHandle(conn as unknown as import("kuzu").Connection, {
      handle: "live",
      repoId: "repo",
      createdAt: "2026-03-04T00:00:00Z",
      expiresAt: "2026-03-06T00:00:00Z",
      minVersion: null,
      maxVersion: null,
      sliceHash: "hash",
      spilloverRef: null,
    });

    const deleted = await queries.deleteExpiredSliceHandles(
      conn as unknown as import("kuzu").Connection,
      "2026-03-05T00:00:00Z",
    );
    assert.strictEqual(deleted, 1);

    const expiredRow = await queries.getSliceHandle(conn as unknown as import("kuzu").Connection, "expired");
    assert.strictEqual(expiredRow, null);
    const liveRow = await queries.getSliceHandle(conn as unknown as import("kuzu").Connection, "live");
    assert.ok(liveRow);
  });

  it("upsertCardHash/getCardHash", { skip: !ladybugAvailable }, async () => {
    await queries.upsertCardHash(conn as unknown as import("kuzu").Connection, {
      cardHash: "ch1",
      cardBlob: "blob",
      createdAt: "2026-03-04T00:00:00Z",
    });

    const row = await queries.getCardHash(conn as unknown as import("kuzu").Connection, "ch1");
    assert.ok(row);
    assert.strictEqual(row.cardBlob, "blob");
  });
});
