import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { createSchema } from "../../dist/db/ladybug-schema.js";
import {
  upsertRepo,
  upsertFile,
  upsertSymbol,
  upsertMemory,
  createHasMemoryEdge,
  createMemoryOfEdge,
  type MemoryRow,
} from "../../dist/db/ladybug-queries.js";
import {
  loadCentralitySignals,
  surfaceRelevantMemories,
} from "../../dist/memory/surface.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-memory-surface-test-db.lbug");

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
  return {
    memoryId,
    repoId: "repo-surface",
    type: "decision",
    title: `title-${memoryId}`,
    content: `content-${memoryId}`,
    contentHash: `hash-${memoryId}`,
    searchText: `search-${memoryId}`,
    tagsJson: JSON.stringify(["surface"]),
    confidence: 0.8,
    createdAt: "2026-03-18T12:00:00.000Z",
    updatedAt: "2026-03-18T12:00:00.000Z",
    createdByVersion: "v1",
    stale: false,
    staleVersion: null,
    sourceFile: null,
    deleted: false,
    ...overrides,
  };
}

describe("surfaceRelevantMemories", () => {
  let db: LadybugDatabase;
  let conn: import("kuzu").Connection;

  const repoId = "repo-surface";
  const fileId = "repo-surface:src/memory.ts";
  const symbol1 = "repo-surface:src/memory.ts:function:one:fp-1";
  const symbol2 = "repo-surface:src/memory.ts:function:two:fp-2";
  const symbol3 = "repo-surface:src/memory.ts:function:three:fp-3";

  beforeEach(async () => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    process.env.SDL_GRAPH_DB_PATH = TEST_DB_PATH;

    const created = await createTestDb();
    db = created.db;
    conn = created.conn as unknown as import("kuzu").Connection;
    await createSchema(conn);

    await upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/repo-surface",
      configJson: "{}",
      createdAt: "2026-03-18T11:59:00.000Z",
    });
    await upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/memory.ts",
      contentHash: "filehash",
      language: "typescript",
      byteSize: 256,
      lastIndexedAt: null,
    });

    for (const [symbolId, name, start] of [
      [symbol1, "one", 1],
      [symbol2, "two", 11],
      [symbol3, "three", 21],
    ] as const) {
      await upsertSymbol(conn, {
        symbolId,
        repoId,
        fileId,
        kind: "function",
        name,
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: start,
        rangeStartCol: 0,
        rangeEndLine: start + 5,
        rangeEndCol: 0,
        astFingerprint: `fp-${name}`,
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-18T12:00:00.000Z",
      });
    }
  });

  afterEach(async () => {
    await cleanupTestDb(db, conn as unknown as LadybugConnection);
  });

  it("returns empty array when repo has no memories", async () => {
    const surfaced = await surfaceRelevantMemories(conn, { repoId });
    assert.deepStrictEqual(surfaced, []);
  });

  it("surfaces repo memories without symbol context", async () => {
    await upsertMemory(
      conn,
      makeMemoryRow("mem-repo", {
        tagsJson: JSON.stringify(["tag-a", "tag-b"]),
      }),
    );
    await createHasMemoryEdge(conn, repoId, "mem-repo");

    const surfaced = await surfaceRelevantMemories(conn, { repoId });
    assert.strictEqual(surfaced.length, 1);
    assert.strictEqual(surfaced[0]?.memoryId, "mem-repo");
    assert.deepStrictEqual(surfaced[0]?.linkedSymbols, []);
    assert.deepStrictEqual(surfaced[0]?.tags, ["tag-a", "tag-b"]);
  });

  it("ranks higher symbol-overlap memories above lower overlap", async () => {
    await upsertMemory(
      conn,
      makeMemoryRow("mem-overlap-full", { confidence: 0.8 }),
    );
    await upsertMemory(
      conn,
      makeMemoryRow("mem-overlap-half", { confidence: 0.8 }),
    );

    await createMemoryOfEdge(conn, "mem-overlap-full", symbol1);
    await createMemoryOfEdge(conn, "mem-overlap-full", symbol2);
    await createMemoryOfEdge(conn, "mem-overlap-half", symbol1);

    const surfaced = await surfaceRelevantMemories(conn, {
      repoId,
      symbolIds: [symbol1, symbol2],
      limit: 10,
    });

    const fullIdx = surfaced.findIndex(
      (m) => m.memoryId === "mem-overlap-full",
    );
    const halfIdx = surfaced.findIndex(
      (m) => m.memoryId === "mem-overlap-half",
    );

    assert.ok(fullIdx >= 0);
    assert.ok(halfIdx >= 0);
    assert.ok(fullIdx < halfIdx);
  });

  it("respects limit parameter", async () => {
    for (const id of ["mem-limit-1", "mem-limit-2", "mem-limit-3"]) {
      await upsertMemory(conn, makeMemoryRow(id));
      await createHasMemoryEdge(conn, repoId, id);
    }

    const surfaced = await surfaceRelevantMemories(conn, { repoId, limit: 2 });
    assert.strictEqual(surfaced.length, 2);
  });

  it("applies taskType filter", async () => {
    await upsertMemory(
      conn,
      makeMemoryRow("mem-type-decision", { type: "decision" }),
    );
    await upsertMemory(
      conn,
      makeMemoryRow("mem-type-bugfix", { type: "bugfix" }),
    );
    await createHasMemoryEdge(conn, repoId, "mem-type-decision");
    await createHasMemoryEdge(conn, repoId, "mem-type-bugfix");

    const surfaced = await surfaceRelevantMemories(conn, {
      repoId,
      taskType: "bugfix",
      limit: 10,
    });

    assert.strictEqual(surfaced.length, 1);
    assert.strictEqual(surfaced[0]?.memoryId, "mem-type-bugfix");
    assert.strictEqual(surfaced[0]?.type, "bugfix");
  });

  it("deduplicates memory that appears in symbol and repo sources", async () => {
    await upsertMemory(conn, makeMemoryRow("mem-dedupe"));
    await createHasMemoryEdge(conn, repoId, "mem-dedupe");
    await createMemoryOfEdge(conn, "mem-dedupe", symbol1);

    const surfaced = await surfaceRelevantMemories(conn, {
      repoId,
      symbolIds: [symbol1],
      limit: 10,
    });

    assert.strictEqual(surfaced.length, 1);
    assert.strictEqual(surfaced[0]?.memoryId, "mem-dedupe");
  });

  it("linkedSymbols includes only queried linked symbol ids", async () => {
    await upsertMemory(conn, makeMemoryRow("mem-links"));
    await createMemoryOfEdge(conn, "mem-links", symbol1);
    await createMemoryOfEdge(conn, "mem-links", symbol2);
    await createMemoryOfEdge(conn, "mem-links", symbol3);

    const surfaced = await surfaceRelevantMemories(conn, {
      repoId,
      symbolIds: [symbol1, symbol2],
      limit: 10,
    });

    assert.strictEqual(surfaced.length, 1);
    assert.deepStrictEqual(
      surfaced[0]?.linkedSymbols.sort(),
      [symbol1, symbol2].sort(),
    );
  });

  it("recency can outweigh confidence when confidence gap is small", async () => {
    await upsertMemory(
      conn,
      makeMemoryRow("mem-newer", {
        confidence: 0.7,
        createdAt: "2026-03-18T12:00:00.000Z",
      }),
    );
    await upsertMemory(
      conn,
      makeMemoryRow("mem-older", {
        confidence: 0.8,
        createdAt: "2025-03-18T12:00:00.000Z",
      }),
    );
    await createHasMemoryEdge(conn, repoId, "mem-newer");
    await createHasMemoryEdge(conn, repoId, "mem-older");

    const surfaced = await surfaceRelevantMemories(conn, { repoId, limit: 10 });
    const newerIdx = surfaced.findIndex((m) => m.memoryId === "mem-newer");
    const olderIdx = surfaced.findIndex((m) => m.memoryId === "mem-older");

    assert.ok(newerIdx >= 0);
    assert.ok(olderIdx >= 0);
    assert.ok(newerIdx < olderIdx);
  });

  it("mildly boosts memories linked to higher-centrality symbols", async () => {
    await upsertMemory(conn, makeMemoryRow("mem-central-high"));
    await upsertMemory(conn, makeMemoryRow("mem-central-low"));
    await createMemoryOfEdge(conn, "mem-central-high", symbol1);
    await createMemoryOfEdge(conn, "mem-central-low", symbol2);

    await import("../../dist/db/ladybug-queries.js").then(async (queries) => {
      await queries.upsertMetrics(conn, {
        symbolId: symbol1,
        fanIn: 1,
        fanOut: 1,
        churn30d: 0,
        testRefsJson: null,
        canonicalTestJson: null,
        pageRank: 1.0,
        kCore: 10,
        updatedAt: "2026-03-18T12:00:00.000Z",
      });
      await queries.upsertMetrics(conn, {
        symbolId: symbol2,
        fanIn: 1,
        fanOut: 1,
        churn30d: 0,
        testRefsJson: null,
        canonicalTestJson: null,
        pageRank: 0.1,
        kCore: 1,
        updatedAt: "2026-03-18T12:00:00.000Z",
      });
    });

    const centralitySignals = await loadCentralitySignals(conn, [
      symbol1,
      symbol2,
    ]);
    const surfaced = await surfaceRelevantMemories(conn, {
      repoId,
      symbolIds: [symbol1, symbol2],
      centralitySignals,
      limit: 10,
    });

    assert.strictEqual(surfaced[0]?.memoryId, "mem-central-high");
    assert.strictEqual(surfaced[1]?.memoryId, "mem-central-low");
  });
});
