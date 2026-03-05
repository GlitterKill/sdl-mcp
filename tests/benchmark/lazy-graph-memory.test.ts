import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, "..", "..", ".kuzu-lazy-graph-memory-test-db");

interface KuzuConnection {
  query: (q: string) => Promise<{
    hasNext: () => boolean;
    getNext: () => Promise<Record<string, unknown>>;
    close: () => void;
  }>;
  close: () => Promise<void>;
}

interface KuzuDatabase {
  close: () => Promise<void>;
}

async function createTestDb(): Promise<{
  db: KuzuDatabase;
  conn: KuzuConnection;
}> {
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(TEST_DB_PATH, { recursive: true });

  const kuzu = await import("kuzu");
  const db = new kuzu.Database(TEST_DB_PATH);
  const conn = new kuzu.Connection(db);

  return { db, conn: conn as unknown as KuzuConnection };
}

async function cleanupTestDb(db: KuzuDatabase, conn: KuzuConnection): Promise<void> {
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

async function setupSchema(conn: KuzuConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/kuzu-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

function getPeakRSSMB(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.rss / 1024 / 1024);
}

function forceGC(): void {
  if (global.gc) {
    global.gc();
    global.gc();
    global.gc();
  }
}

describe("Lazy Graph Memory Benchmark (Kuzu)", () => {
  let db: KuzuDatabase;
  let conn: KuzuConnection;
  let graphOps: typeof import("../../dist/graph/buildGraph.js");
  let queries: typeof import("../../dist/db/kuzu-queries.js");
  let kuzuAvailable = true;

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      graphOps = await import("../../dist/graph/buildGraph.js");
      queries = await import("../../dist/db/kuzu-queries.js");
      graphOps.resetLoadStats();
      forceGC();
    } catch {
      kuzuAvailable = false;
    }
  });

  afterEach(async () => {
    if (!kuzuAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it("measures memory usage for neighborhood loads", { skip: !kuzuAvailable }, async () => {
    const kConn = conn as unknown as import("kuzu").Connection;

    await queries.upsertRepo(kConn, {
      repoId: "bench-repo",
      rootPath: "C:/bench-repo",
      configJson: "{}",
      createdAt: "2026-03-04T00:00:00.000Z",
    });

    const edges: Array<import("../../dist/db/kuzu-queries.js").EdgeRow> = [];
    for (let i = 0; i < 5000; i++) {
      edges.push({
        repoId: "bench-repo",
        fromSymbolId: "entry",
        toSymbolId: `n${i}`,
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: "2026-03-04T00:00:00.000Z",
      });
    }
    await queries.insertEdges(kConn, edges);

    forceGC();
    const rssBefore = getPeakRSSMB();

    await graphOps.loadNeighborhood(kConn, "bench-repo", ["entry"], {
      maxHops: 1,
      direction: "out",
      maxSymbols: 500,
    });

    const stats = graphOps.getLastLoadStats();
    assert.ok(stats);
    assert.strictEqual(stats.mode, "lazy");

    forceGC();
    const rssAfter = getPeakRSSMB();

    console.log("\n=== Neighborhood Load Memory Benchmark ===");
    console.log(`Nodes loaded: ${stats.nodeCount}`);
    console.log(`Edges loaded: ${stats.edgeCount}`);
    console.log(`Duration: ${stats.durationMs}ms`);
    console.log(`RSS before: ${rssBefore}MB`);
    console.log(`RSS after: ${rssAfter}MB`);
    console.log(`RSS delta: ${rssAfter - rssBefore}MB`);
  });
});

