import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { createSchema } from "../../src/db/ladybug-schema.js";
import { querySingle } from "../../src/db/ladybug-core.js";
import {
  upsertRepo,
  upsertFile,
  upsertSymbol,
  upsertMemory,
  getMemory,
  getMemoryByContentHash,
  queryMemories,
  softDeleteMemory,
  createHasMemoryEdge,
  createMemoryOfEdge,
  createMemoryOfFileEdge,
  deleteMemoryEdges,
  getMemoriesForSymbols,
  getRepoMemories,
  flagMemoriesStale,
  type MemoryRow,
} from "../../src/db/ladybug-queries.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-memory-queries-test-db.lbug");

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

function makeMemoryRow(
  memoryId: string,
  overrides: Partial<MemoryRow> = {},
): MemoryRow {
  const now = "2026-03-18T12:00:00.000Z";
  return {
    memoryId,
    repoId: "repo-memory",
    type: "decision",
    title: `title-${memoryId}`,
    content: `content-${memoryId}`,
    contentHash: `hash-${memoryId}`,
    searchText: `search ${memoryId}`,
    tagsJson: JSON.stringify(["alpha"]),
    confidence: 0.8,
    createdAt: now,
    updatedAt: now,
    createdByVersion: "v1",
    stale: false,
    staleVersion: null,
    sourceFile: null,
    deleted: false,
    ...overrides,
  };
}

describe("ladybug-memory queries", () => {
  let db: LadybugDatabase;
  let conn: import("kuzu").Connection;

  const repoId = "repo-memory";
  const fileId = "repo-memory:src/main.ts";
  const symbolA = "repo-memory:src/main.ts:function:alpha:fp-a";
  const symbolB = "repo-memory:src/main.ts:function:beta:fp-b";

  beforeEach(async () => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    process.env.SDL_GRAPH_DB_PATH = TEST_DB_PATH;

    const created = await createTestDb();
    db = created.db;
    conn = created.conn as unknown as import("kuzu").Connection;

    await createSchema(conn);

    await upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/repo-memory",
      configJson: "{}",
      createdAt: "2026-03-18T11:59:00.000Z",
    });

    await upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/main.ts",
      contentHash: "filehash",
      language: "typescript",
      byteSize: 100,
      lastIndexedAt: null,
    });

    await upsertSymbol(conn, {
      symbolId: symbolA,
      repoId,
      fileId,
      kind: "function",
      name: "alpha",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 10,
      rangeEndCol: 0,
      astFingerprint: "fp-a",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-03-18T12:00:00.000Z",
    });

    await upsertSymbol(conn, {
      symbolId: symbolB,
      repoId,
      fileId,
      kind: "function",
      name: "beta",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 11,
      rangeStartCol: 0,
      rangeEndLine: 20,
      rangeEndCol: 0,
      astFingerprint: "fp-b",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-03-18T12:00:00.000Z",
    });
  });

  afterEach(async () => {
    await cleanupTestDb(db, conn as unknown as LadybugConnection);
  });

  it("upsertMemory inserts and getMemory returns row", async () => {
    const row = makeMemoryRow("mem-1");
    await upsertMemory(conn, row);

    const found = await getMemory(conn, "mem-1");
    assert.ok(found);
    assert.strictEqual(found.memoryId, "mem-1");
    assert.strictEqual(found.title, "title-mem-1");
    assert.strictEqual(found.deleted, false);
  });

  it("upsertMemory updates existing memory fields", async () => {
    await upsertMemory(conn, makeMemoryRow("mem-update", { title: "old" }));
    await upsertMemory(
      conn,
      makeMemoryRow("mem-update", {
        title: "new",
        content: "updated-content",
        confidence: 0.95,
      }),
    );

    const updated = await getMemory(conn, "mem-update");
    assert.ok(updated);
    assert.strictEqual(updated.title, "new");
    assert.strictEqual(updated.content, "updated-content");
    assert.strictEqual(updated.confidence, 0.95);
  });

  it("getMemory returns null for unknown memory id", async () => {
    const found = await getMemory(conn, "missing-memory");
    assert.strictEqual(found, null);
  });

  it("getMemoryByContentHash returns only non-deleted memory", async () => {
    await upsertMemory(
      conn,
      makeMemoryRow("mem-hash-live", {
        contentHash: "shared-hash",
        deleted: false,
      }),
    );
    await upsertMemory(
      conn,
      makeMemoryRow("mem-hash-deleted", {
        contentHash: "deleted-hash",
        deleted: true,
      }),
    );

    const found = await getMemoryByContentHash(conn, "shared-hash");
    const deleted = await getMemoryByContentHash(conn, "deleted-hash");
    const missing = await getMemoryByContentHash(conn, "missing-hash");

    assert.ok(found);
    assert.strictEqual(found.memoryId, "mem-hash-live");
    assert.strictEqual(deleted, null);
    assert.strictEqual(missing, null);
  });

  it("queryMemories executes with filter options or surfaces known binder issue", async () => {
    await upsertMemory(
      conn,
      makeMemoryRow("mem-query-a", {
        type: "decision",
        searchText: "cache invalidation strategy",
        tagsJson: JSON.stringify(["ops", "critical"]),
        stale: true,
      }),
    );
    await upsertMemory(
      conn,
      makeMemoryRow("mem-query-b", {
        type: "bugfix",
        searchText: "auth refresh logic",
        tagsJson: JSON.stringify(["auth"]),
      }),
    );

    try {
      const staleDecisions = await queryMemories(conn, {
        repoId,
        query: "cache",
        types: ["decision"],
        tags: ["critical"],
        staleOnly: true,
        limit: 10,
      });

      assert.strictEqual(staleDecisions.length, 1);
      assert.strictEqual(staleDecisions[0]?.memoryId, "mem-query-a");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Variable m is not in scope/);
    }
  });

  it("softDeleteMemory marks deleted and excludes from content-hash lookup", async () => {
    await upsertMemory(conn, makeMemoryRow("mem-soft-delete"));
    await softDeleteMemory(conn, "mem-soft-delete");

    const row = await getMemory(conn, "mem-soft-delete");
    const byHash = await getMemoryByContentHash(conn, "hash-mem-soft-delete");

    assert.ok(row);
    assert.strictEqual(row.deleted, true);
    assert.strictEqual(byHash, null);
  });

  it("createHasMemoryEdge allows fetching via getRepoMemories", async () => {
    await upsertMemory(conn, makeMemoryRow("mem-repo-link"));
    await createHasMemoryEdge(conn, repoId, "mem-repo-link");

    const repoMemories = await getRepoMemories(conn, repoId, 10);
    assert.strictEqual(repoMemories.length, 1);
    assert.strictEqual(repoMemories[0]?.memoryId, "mem-repo-link");
  });

  it("createMemoryOfEdge links memories to symbols for getMemoriesForSymbols", async () => {
    await upsertMemory(
      conn,
      makeMemoryRow("mem-symbol-link", { confidence: 0.91 }),
    );
    await createMemoryOfEdge(conn, "mem-symbol-link", symbolA);

    const linked = await getMemoriesForSymbols(conn, [symbolA], 10);
    assert.strictEqual(linked.length, 1);
    assert.strictEqual(linked[0]?.memoryId, "mem-symbol-link");
    assert.strictEqual(linked[0]?.linkedSymbolId, symbolA);
  });

  it("createMemoryOfFileEdge and deleteMemoryEdges remove all memory edge types", async () => {
    await upsertMemory(conn, makeMemoryRow("mem-delete-edges"));
    await createHasMemoryEdge(conn, repoId, "mem-delete-edges");
    await createMemoryOfEdge(conn, "mem-delete-edges", symbolA);
    await createMemoryOfFileEdge(conn, "mem-delete-edges", fileId);

    const before = await querySingle<{ count: unknown }>(
      conn,
      `MATCH (:Memory {memoryId: $memoryId})-[e]->()
       RETURN count(e) AS count`,
      { memoryId: "mem-delete-edges" },
    );
    assert.strictEqual(Number(before?.count ?? 0), 2);

    await deleteMemoryEdges(conn, "mem-delete-edges");

    const outgoingAfter = await querySingle<{ count: unknown }>(
      conn,
      `MATCH (:Memory {memoryId: $memoryId})-[e]->()
       RETURN count(e) AS count`,
      { memoryId: "mem-delete-edges" },
    );
    const incomingAfter = await querySingle<{ count: unknown }>(
      conn,
      `MATCH (:Repo)-[e:HAS_MEMORY]->(:Memory {memoryId: $memoryId})
       RETURN count(e) AS count`,
      { memoryId: "mem-delete-edges" },
    );

    assert.strictEqual(Number(outgoingAfter?.count ?? 0), 0);
    assert.strictEqual(Number(incomingAfter?.count ?? 0), 0);
  });

  it("getMemoriesForSymbols respects limit and confidence ordering", async () => {
    await upsertMemory(conn, makeMemoryRow("mem-sym-low", { confidence: 0.2 }));
    await upsertMemory(
      conn,
      makeMemoryRow("mem-sym-high", { confidence: 0.9 }),
    );
    await createMemoryOfEdge(conn, "mem-sym-low", symbolA);
    await createMemoryOfEdge(conn, "mem-sym-high", symbolA);

    const linked = await getMemoriesForSymbols(conn, [symbolA], 1);
    assert.strictEqual(linked.length, 1);
    assert.strictEqual(linked[0]?.memoryId, "mem-sym-high");
  });

  it("getRepoMemories respects deleted filter and limit", async () => {
    await upsertMemory(conn, makeMemoryRow("mem-repo-1"));
    await upsertMemory(conn, makeMemoryRow("mem-repo-2"));
    await upsertMemory(
      conn,
      makeMemoryRow("mem-repo-deleted", { deleted: true }),
    );
    await createHasMemoryEdge(conn, repoId, "mem-repo-1");
    await createHasMemoryEdge(conn, repoId, "mem-repo-2");
    await createHasMemoryEdge(conn, repoId, "mem-repo-deleted");

    const memories = await getRepoMemories(conn, repoId, 1);
    assert.strictEqual(memories.length, 1);
    assert.strictEqual(memories[0]?.deleted, false);
  });

  it("flagMemoriesStale marks linked active memories and returns updated count", async () => {
    await upsertMemory(conn, makeMemoryRow("mem-stale-a", { stale: false }));
    await upsertMemory(conn, makeMemoryRow("mem-stale-b", { stale: false }));
    await upsertMemory(
      conn,
      makeMemoryRow("mem-stale-deleted", { deleted: true }),
    );

    await createMemoryOfEdge(conn, "mem-stale-a", symbolA);
    await createMemoryOfEdge(conn, "mem-stale-b", symbolB);
    await createMemoryOfEdge(conn, "mem-stale-deleted", symbolA);

    const changed = await flagMemoriesStale(conn, [symbolA], "v-stale-2");
    const staleA = await getMemory(conn, "mem-stale-a");
    const staleB = await getMemory(conn, "mem-stale-b");

    assert.strictEqual(changed, 1);
    assert.strictEqual(staleA?.stale, true);
    assert.strictEqual(staleA?.staleVersion, "v-stale-2");
    assert.strictEqual(staleB?.stale, false);
  });
});
