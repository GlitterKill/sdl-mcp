import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SliceRefreshRequestSchema } from "../../dist/mcp/tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-slice-refresh-test-db.lbug");

interface LadybugDatabase {
  close: () => Promise<void>;
}

interface LadybugConnection {
  close: () => Promise<void>;
}

let ladybugAvailable = true;
let db: LadybugDatabase;
let conn: import("kuzu").Connection;
let queries: typeof import("../../dist/db/ladybug-queries.js");

async function createTestDb(): Promise<void> {
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

  const kuzu = await import("kuzu");
  db = new kuzu.Database(TEST_DB_PATH) as unknown as LadybugDatabase;
  conn = new kuzu.Connection(db as unknown as InstanceType<typeof kuzu.Database>);

  const { createSchema } = await import("../../dist/db/ladybug-schema.js");
  await createSchema(conn);
  queries = await import("../../dist/db/ladybug-queries.js");
}

async function cleanupTestDb(): Promise<void> {
  try {
    await (conn as unknown as LadybugConnection).close();
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

describe("SliceRefreshRequestSchema validation", () => {
  it("parses valid request with sliceHandle and knownVersion", () => {
    const parsed = SliceRefreshRequestSchema.safeParse({
      sliceHandle: "abc123handle",
      knownVersion: "v1234567890",
    });
    assert.strictEqual(parsed.success, true);
    if (parsed.success) {
      assert.strictEqual(parsed.data.sliceHandle, "abc123handle");
      assert.strictEqual(parsed.data.knownVersion, "v1234567890");
    }
  });

  it("rejects missing sliceHandle", () => {
    const parsed = SliceRefreshRequestSchema.safeParse({
      knownVersion: "v1234567890",
    });
    assert.strictEqual(parsed.success, false);
  });

  it("accepts missing knownVersion (optional)", () => {
    const parsed = SliceRefreshRequestSchema.safeParse({
      sliceHandle: "abc123handle",
    });
    assert.strictEqual(parsed.success, true);
  });

  it("rejects empty object", () => {
    const parsed = SliceRefreshRequestSchema.safeParse({});
    assert.strictEqual(parsed.success, false);
  });

  it("rejects non-string sliceHandle", () => {
    const parsed = SliceRefreshRequestSchema.safeParse({
      sliceHandle: 123,
      knownVersion: "v1234567890",
    });
    assert.strictEqual(parsed.success, false);
  });

  it("rejects empty-string sliceHandle (schema hardening)", () => {
    // Regression guard: before the schema was hardened to .min(1), an empty
    // handle would parse as valid and only fail later at the DB lookup with a
    // NotFoundError, which is misleading and also lets an unbounded-length
    // handle pass through to the prepared-statement cache.
    const parsed = SliceRefreshRequestSchema.safeParse({
      sliceHandle: "",
      knownVersion: "v1234567890",
    });
    assert.strictEqual(parsed.success, false);
  });

  it("rejects oversized sliceHandle (schema hardening)", () => {
    const parsed = SliceRefreshRequestSchema.safeParse({
      sliceHandle: "x".repeat(1024),
      knownVersion: "v1234567890",
    });
    assert.strictEqual(parsed.success, false);
  });
});

describe("slice refresh with test DB", () => {
  before(async () => {
    try {
      await createTestDb();
    } catch {
      ladybugAvailable = false;
    }
  });

  after(async () => {
    if (ladybugAvailable) {
      await cleanupTestDb();
    }
  });

  it("getSliceHandle returns null for non-existent handle", async (t) => {
    if (!ladybugAvailable) return t.skip("LadybugDB not available");
    const row = await queries.getSliceHandle(conn, "non-existent-handle");
    assert.strictEqual(row, null);
  });

  it("upsertSliceHandle then getSliceHandle round-trip", async (t) => {
    if (!ladybugAvailable) return t.skip("LadybugDB not available");
    const futureDate = new Date(Date.now() + 3600000).toISOString();
    await queries.upsertSliceHandle(conn, {
      handle: "refresh-test-handle",
      repoId: "test-repo",
      createdAt: new Date().toISOString(),
      expiresAt: futureDate,
      minVersion: null,
      maxVersion: "v1000",
      sliceHash: "hash123",
      spilloverRef: null,
    });

    const row = await queries.getSliceHandle(conn, "refresh-test-handle");
    assert.ok(row, "should find the inserted handle");
    assert.strictEqual(row!.handle, "refresh-test-handle");
    assert.strictEqual(row!.repoId, "test-repo");
    assert.strictEqual(row!.maxVersion, "v1000");
  });

  it("expired handles are detected by date comparison", async (t) => {
    if (!ladybugAvailable) return t.skip("LadybugDB not available");
    const pastDate = new Date(Date.now() - 3600000).toISOString();
    await queries.upsertSliceHandle(conn, {
      handle: "expired-handle",
      repoId: "test-repo",
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      expiresAt: pastDate,
      minVersion: null,
      maxVersion: "v1000",
      sliceHash: "hash456",
      spilloverRef: null,
    });

    const row = await queries.getSliceHandle(conn, "expired-handle");
    assert.ok(row, "should find the handle even if expired");
    // Verify the expiration check logic that handleSliceRefresh performs
    const isExpired = new Date(row!.expiresAt) < new Date();
    assert.strictEqual(isExpired, true, "handle should be expired");
  });

  it("handle can be updated with new lease (upsert)", async (t) => {
    if (!ladybugAvailable) return t.skip("LadybugDB not available");
    const futureDate1 = new Date(Date.now() + 3600000).toISOString();
    await queries.upsertSliceHandle(conn, {
      handle: "upsert-handle",
      repoId: "test-repo",
      createdAt: new Date().toISOString(),
      expiresAt: futureDate1,
      minVersion: null,
      maxVersion: "v1000",
      sliceHash: "hash-original",
      spilloverRef: null,
    });

    // Update with new version (simulating lease renewal in handleSliceRefresh)
    const futureDate2 = new Date(Date.now() + 7200000).toISOString();
    await queries.upsertSliceHandle(conn, {
      handle: "upsert-handle",
      repoId: "test-repo",
      createdAt: new Date().toISOString(),
      expiresAt: futureDate2,
      minVersion: "v1000",
      maxVersion: "v2000",
      sliceHash: "hash-updated",
      spilloverRef: null,
    });

    const row = await queries.getSliceHandle(conn, "upsert-handle");
    assert.ok(row, "should find the updated handle");
    assert.strictEqual(row!.maxVersion, "v2000");
  });

  it("deleteExpiredSliceHandles removes only expired handles", async (t) => {
    if (!ladybugAvailable) return t.skip("LadybugDB not available");
    // Insert a valid (non-expired) handle
    const futureDate = new Date(Date.now() + 3600000).toISOString();
    await queries.upsertSliceHandle(conn, {
      handle: "valid-handle-for-cleanup",
      repoId: "test-repo",
      createdAt: new Date().toISOString(),
      expiresAt: futureDate,
      minVersion: null,
      maxVersion: "v1000",
      sliceHash: "hash-valid",
      spilloverRef: null,
    });

    // Insert an expired handle (use a date far in the past to ensure string comparison works)
    const pastDate = "2020-01-01T00:00:00.000Z";
    await queries.upsertSliceHandle(conn, {
      handle: "expired-handle-for-cleanup",
      repoId: "test-repo",
      createdAt: "2019-12-01T00:00:00.000Z",
      expiresAt: pastDate,
      minVersion: null,
      maxVersion: "v500",
      sliceHash: "hash-expired",
      spilloverRef: null,
    });

    // Use a date well after the expired handle's expiresAt
    const deleted = await queries.deleteExpiredSliceHandles(conn, "2025-01-01T00:00:00.000Z");
    assert.ok(deleted >= 1, "should delete at least the expired handle");

    // Valid handle should still exist
    const validRow = await queries.getSliceHandle(conn, "valid-handle-for-cleanup");
    assert.ok(validRow, "valid handle should survive cleanup");

    // Expired handle should be gone
    const expiredRow = await queries.getSliceHandle(conn, "expired-handle-for-cleanup");
    assert.strictEqual(expiredRow, null, "expired handle should be removed");
  });
});
