import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(
  __dirname,
  "..",
  "..",
  ".kuzu-beam-search-test-db.kuzu",
);

interface KuzuConnection {
  query: (
    q: string,
    params?: Record<string, unknown>,
  ) => Promise<{
    hasNext: () => boolean;
    getNext: () => Promise<Record<string, unknown>>;
    close: () => void;
    getAllSync?: () => Record<string, unknown>[];
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
  const kuzu = await import("kuzu");
  const db = new kuzu.Database(TEST_DB_PATH);
  const conn = new kuzu.Connection(db);
  return {
    db: db as unknown as KuzuDatabase,
    conn: conn as unknown as KuzuConnection,
  };
}

async function cleanupTestDb(
  db: KuzuDatabase,
  conn: KuzuConnection,
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

async function setupSchema(conn: KuzuConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/kuzu-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("beamSearchKuzu (integration)", () => {
  let db: KuzuDatabase;
  let conn: KuzuConnection;
  let beamSearch: typeof import("../../dist/graph/slice/beam-search-engine.js");
  let queries: typeof import("../../dist/db/kuzu-queries.js");
  let kuzuAvailable = true;

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      beamSearch = await import("../../dist/graph/slice/beam-search-engine.js");
      queries = await import("../../dist/db/kuzu-queries.js");
    } catch {
      kuzuAvailable = false;
    }
  });

  afterEach(async () => {
    if (!kuzuAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it(
    "basic traversal: follows call edges through a 3-symbol chain",
    { skip: !kuzuAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;
      const now = "2026-03-07T00:00:00.000Z";
      const repoId = "repo-basic";

      await queries.upsertRepo(kConn, {
        repoId,
        rootPath: "C:/repo-basic",
        configJson: "{}",
        createdAt: now,
      });

      await queries.upsertFile(kConn, {
        fileId: "file-basic-1",
        repoId,
        relPath: "src/app.ts",
        contentHash: "hash",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: now,
      });

      for (const symbolId of ["symA", "symB", "symC"]) {
        await queries.upsertSymbol(kConn, {
          symbolId,
          repoId,
          fileId: "file-basic-1",
          kind: "function",
          name: symbolId,
          exported: true,
          visibility: "public",
          language: "ts",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 2,
          rangeEndCol: 1,
          astFingerprint: `${symbolId}-fp`,
          signatureJson: null,
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          updatedAt: now,
        });
      }

      await queries.insertEdges(kConn, [
        {
          repoId,
          fromSymbolId: "symA",
          toSymbolId: "symB",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
        {
          repoId,
          fromSymbolId: "symB",
          toSymbolId: "symC",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
      ]);

      const startNodes = [{ symbolId: "symA", source: "entrySymbol" as const }];
      const budget = { maxCards: 10, maxEstimatedTokens: 100_000 };
      const request = { entrySymbols: ["symA"] };
      const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };

      const result = await beamSearch.beamSearchKuzu(
        kConn,
        repoId,
        startNodes,
        budget,
        request,
        edgeWeights,
        0.0,
      );

      assert.ok(result.sliceCards.has("symA"), "symA should be in sliceCards");
      assert.ok(result.sliceCards.has("symB"), "symB should be in sliceCards");
      assert.ok(result.sliceCards.has("symC"), "symC should be in sliceCards");
    },
  );

  it(
    "budget enforcement: wasTruncated when maxCards exceeded",
    { skip: !kuzuAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;
      const now = "2026-03-07T00:00:00.000Z";
      const repoId = "repo-budget";

      await queries.upsertRepo(kConn, {
        repoId,
        rootPath: "C:/repo-budget",
        configJson: "{}",
        createdAt: now,
      });

      await queries.upsertFile(kConn, {
        fileId: "file-budget-1",
        repoId,
        relPath: "src/chain.ts",
        contentHash: "hash",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: now,
      });

      const symbols = ["b1", "b2", "b3", "b4", "b5"];
      for (const symbolId of symbols) {
        await queries.upsertSymbol(kConn, {
          symbolId,
          repoId,
          fileId: "file-budget-1",
          kind: "function",
          name: symbolId,
          exported: true,
          visibility: "public",
          language: "ts",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 2,
          rangeEndCol: 1,
          astFingerprint: `${symbolId}-fp`,
          signatureJson: null,
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          updatedAt: now,
        });
      }

      // Chain: b1 -> b2 -> b3 -> b4 -> b5
      const edges = [];
      for (let i = 0; i < symbols.length - 1; i++) {
        edges.push({
          repoId,
          fromSymbolId: symbols[i],
          toSymbolId: symbols[i + 1],
          edgeType: "call" as const,
          weight: 1,
          confidence: 1,
          resolution: "exact" as const,
          provenance: "static",
          createdAt: now,
        });
      }
      await queries.insertEdges(kConn, edges);

      const startNodes = [{ symbolId: "b1", source: "entrySymbol" as const }];
      const budget = { maxCards: 2, maxEstimatedTokens: 100_000 };
      const request = { entrySymbols: ["b1"] };
      const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };

      const result = await beamSearch.beamSearchKuzu(
        kConn,
        repoId,
        startNodes,
        budget,
        request,
        edgeWeights,
        0.0,
      );

      assert.ok(
        result.sliceCards.size <= 2,
        `sliceCards.size (${result.sliceCards.size}) should be <= 2`,
      );
      assert.strictEqual(
        result.wasTruncated,
        true,
        "wasTruncated should be true when budget exceeded",
      );
    },
  );

  it(
    "confidence filtering: low-confidence edges are dropped",
    { skip: !kuzuAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;
      const now = "2026-03-07T00:00:00.000Z";
      const repoId = "repo-confidence";

      await queries.upsertRepo(kConn, {
        repoId,
        rootPath: "C:/repo-confidence",
        configJson: "{}",
        createdAt: now,
      });

      await queries.upsertFile(kConn, {
        fileId: "file-conf-1",
        repoId,
        relPath: "src/conf.ts",
        contentHash: "hash",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: now,
      });

      for (const symbolId of ["c1", "c2", "c3"]) {
        await queries.upsertSymbol(kConn, {
          symbolId,
          repoId,
          fileId: "file-conf-1",
          kind: "function",
          name: symbolId,
          exported: true,
          visibility: "public",
          language: "ts",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 2,
          rangeEndCol: 1,
          astFingerprint: `${symbolId}-fp`,
          signatureJson: null,
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          updatedAt: now,
        });
      }

      // c1 -> c2 (high confidence), c1 -> c3 (low confidence)
      await queries.insertEdges(kConn, [
        {
          repoId,
          fromSymbolId: "c1",
          toSymbolId: "c2",
          edgeType: "call",
          weight: 1,
          confidence: 0.9,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
        {
          repoId,
          fromSymbolId: "c1",
          toSymbolId: "c3",
          edgeType: "call",
          weight: 1,
          confidence: 0.1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
      ]);

      const startNodes = [{ symbolId: "c1", source: "entrySymbol" as const }];
      const budget = { maxCards: 10, maxEstimatedTokens: 100_000 };
      const request = { entrySymbols: ["c1"] };
      const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };

      const result = await beamSearch.beamSearchKuzu(
        kConn,
        repoId,
        startNodes,
        budget,
        request,
        edgeWeights,
        0.5, // minConfidence = 0.5, so c3 (confidence=0.1) should be dropped
      );

      assert.ok(
        result.sliceCards.has("c1"),
        "c1 (start node) should be in sliceCards",
      );
      assert.ok(
        result.sliceCards.has("c2"),
        "c2 (high confidence) should be in sliceCards",
      );
      // c3 should not be included OR droppedCandidates should be > 0
      const c3Excluded = !result.sliceCards.has("c3");
      const droppedSome = result.droppedCandidates > 0;
      assert.ok(
        c3Excluded || droppedSome,
        "c3 (low confidence) should be excluded or droppedCandidates > 0",
      );
    },
  );

  it(
    "empty start nodes: returns empty sliceCards",
    { skip: !kuzuAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;
      const now = "2026-03-07T00:00:00.000Z";
      const repoId = "repo-empty";

      await queries.upsertRepo(kConn, {
        repoId,
        rootPath: "C:/repo-empty",
        configJson: "{}",
        createdAt: now,
      });

      const startNodes: Array<{
        symbolId: string;
        source:
          | "entrySymbol"
          | "entryFirstHop"
          | "taskText"
          | "editedFile"
          | "failingTest";
      }> = [];
      const budget = { maxCards: 10, maxEstimatedTokens: 100_000 };
      const request = {};
      const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };

      const result = await beamSearch.beamSearchKuzu(
        kConn,
        repoId,
        startNodes,
        budget,
        request,
        edgeWeights,
        0.5,
      );

      assert.strictEqual(
        result.sliceCards.size,
        0,
        "sliceCards should be empty when no start nodes provided",
      );
    },
  );

  it(
    "repository isolation: symbols from other repos are not included",
    { skip: !kuzuAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;
      const now = "2026-03-07T00:00:00.000Z";
      const repoA = "repo-iso-A";
      const repoB = "repo-iso-B";

      // Setup repoA
      await queries.upsertRepo(kConn, {
        repoId: repoA,
        rootPath: "C:/repo-iso-A",
        configJson: "{}",
        createdAt: now,
      });
      await queries.upsertFile(kConn, {
        fileId: "file-iso-A-1",
        repoId: repoA,
        relPath: "src/a.ts",
        contentHash: "hash",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: now,
      });

      // Setup repoB
      await queries.upsertRepo(kConn, {
        repoId: repoB,
        rootPath: "C:/repo-iso-B",
        configJson: "{}",
        createdAt: now,
      });
      await queries.upsertFile(kConn, {
        fileId: "file-iso-B-1",
        repoId: repoB,
        relPath: "src/b.ts",
        contentHash: "hash",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: now,
      });

      // Insert symbols in repoA: isoA1, isoA2
      for (const [symbolId, fileId] of [
        ["isoA1", "file-iso-A-1"],
        ["isoA2", "file-iso-A-1"],
      ] as const) {
        await queries.upsertSymbol(kConn, {
          symbolId,
          repoId: repoA,
          fileId,
          kind: "function",
          name: symbolId,
          exported: true,
          visibility: "public",
          language: "ts",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 2,
          rangeEndCol: 1,
          astFingerprint: `${symbolId}-fp`,
          signatureJson: null,
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          updatedAt: now,
        });
      }

      // Insert symbols in repoB: isoB1, isoB2
      for (const [symbolId, fileId] of [
        ["isoB1", "file-iso-B-1"],
        ["isoB2", "file-iso-B-1"],
      ] as const) {
        await queries.upsertSymbol(kConn, {
          symbolId,
          repoId: repoB,
          fileId,
          kind: "function",
          name: symbolId,
          exported: true,
          visibility: "public",
          language: "ts",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 2,
          rangeEndCol: 1,
          astFingerprint: `${symbolId}-fp`,
          signatureJson: null,
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          updatedAt: now,
        });
      }

      // Edges within repoA
      await queries.insertEdges(kConn, [
        {
          repoId: repoA,
          fromSymbolId: "isoA1",
          toSymbolId: "isoA2",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
      ]);

      // Edges within repoB
      await queries.insertEdges(kConn, [
        {
          repoId: repoB,
          fromSymbolId: "isoB1",
          toSymbolId: "isoB2",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
      ]);

      // Search only in repoA
      const startNodes = [
        { symbolId: "isoA1", source: "entrySymbol" as const },
      ];
      const budget = { maxCards: 10, maxEstimatedTokens: 100_000 };
      const request = { entrySymbols: ["isoA1"] };
      const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };

      const result = await beamSearch.beamSearchKuzu(
        kConn,
        repoA,
        startNodes,
        budget,
        request,
        edgeWeights,
        0.0,
      );

      // repoA symbols should be present
      assert.ok(
        result.sliceCards.has("isoA1"),
        "isoA1 should be in sliceCards",
      );

      // repoB symbols must NOT appear
      assert.ok(
        !result.sliceCards.has("isoB1"),
        "isoB1 (repoB) must not appear in repoA slice",
      );
      assert.ok(
        !result.sliceCards.has("isoB2"),
        "isoB2 (repoB) must not appear in repoA slice",
      );
    },
  );
});
