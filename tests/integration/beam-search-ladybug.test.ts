import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DIR = mkdtempSync(join(tmpdir(), "lbug-beam-search-"));
const TEST_DB_PATH = join(TEST_DIR, "test.lbug");

interface LadybugConnection {
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
  const kuzu = await import("kuzu");
  const db = new kuzu.Database(TEST_DB_PATH);
  const conn = new kuzu.Connection(db);
  return {
    db: db as unknown as LadybugDatabase,
    conn: conn as unknown as LadybugConnection,
  };
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

describe("beamSearchLadybug (integration)", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let beamSearch: typeof import("../../dist/graph/slice/beam-search-engine.js");
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      beamSearch = await import("../../dist/graph/slice/beam-search-engine.js");
      queries = await import("../../dist/db/ladybug-queries.js");
    } catch {
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    if (!ladybugAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it(
    "basic traversal: follows call edges through a 3-symbol chain",
    { skip: !ladybugAvailable },
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

      const result = await beamSearch.beamSearchLadybug(
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
    "batches outgoing edges for warm start nodes and caches empty edge lists",
    { skip: !ladybugAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;
      const now = "2026-03-07T00:00:00.000Z";
      const repoId = "repo-warm-edge-prefetch";
      const fileId = "file-warm-edge-prefetch";
      const startIds = ["warm-a", "warm-b", "warm-empty"];

      await queries.upsertRepo(kConn, {
        repoId,
        rootPath: "C:/repo-warm-edge-prefetch",
        configJson: "{}",
        createdAt: now,
      });
      await queries.upsertFile(kConn, {
        fileId,
        repoId,
        relPath: "src/warm.ts",
        contentHash: "hash",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: now,
      });

      for (const symbolId of [...startIds, "warm-child-a", "warm-child-b"]) {
        await queries.upsertSymbol(kConn, {
          symbolId,
          repoId,
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

      await queries.insertEdges(kConn, [
        {
          repoId,
          fromSymbolId: "warm-a",
          toSymbolId: "warm-child-a",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
        {
          repoId,
          fromSymbolId: "warm-b",
          toSymbolId: "warm-child-b",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
      ]);

      const edgeFetches: string[][] = [];
      const edgeStatements = new Set<unknown>();
      const prepare = kConn.prepare.bind(kConn);
      kConn.prepare = (async (
        statement: Parameters<typeof kConn.prepare>[0],
      ) => {
        const prepared = await prepare(statement);
        if (statement.includes("MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)")) {
          edgeStatements.add(prepared);
        }
        return prepared;
      }) as typeof kConn.prepare;
      const execute = kConn.execute.bind(kConn);
      kConn.execute = (async (
        statement: Parameters<typeof kConn.execute>[0],
        params?: Parameters<typeof kConn.execute>[1],
      ) => {
        if (edgeStatements.has(statement)) {
          const symbolIds = params?.symbolIds;
          if (Array.isArray(symbolIds)) {
            edgeFetches.push(symbolIds.map((symbolId) => String(symbolId)));
          }
        }
        return execute(statement, params);
      }) as typeof kConn.execute;

      const result = await beamSearch.beamSearchLadybug(
        kConn,
        repoId,
        startIds.map((symbolId) => ({ symbolId, source: "entrySymbol" as const })),
        { maxCards: 10, maxEstimatedTokens: 100_000 },
        { entrySymbols: startIds },
        { call: 1, import: 0.6, config: 0.8 },
        0,
      );

      assert.deepStrictEqual(edgeFetches[0], startIds);
      for (const symbolId of startIds) {
        assert.strictEqual(
          edgeFetches.filter((ids) => ids.includes(symbolId)).length,
          1,
          `${symbolId} outgoing edges should be fetched once, including the empty result`,
        );
      }
      assert.deepStrictEqual([...result.sliceCards].sort(), [
        "warm-a",
        "warm-b",
        "warm-child-a",
        "warm-child-b",
        "warm-empty",
      ]);
    },
  );

  it(
    "budget enforcement: wasTruncated when maxCards exceeded",
    { skip: !ladybugAvailable },
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

      await queries.insertEdges(kConn, [
        {
          repoId,
          fromSymbolId: "b1",
          toSymbolId: "b2",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
        {
          repoId,
          fromSymbolId: "b2",
          toSymbolId: "b3",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
        {
          repoId,
          fromSymbolId: "b3",
          toSymbolId: "b4",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
        {
          repoId,
          fromSymbolId: "b4",
          toSymbolId: "b5",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
      ]);

      const startNodes = [{ symbolId: "b1", source: "entrySymbol" as const }];
      const budget = { maxCards: 2, maxEstimatedTokens: 100_000 };
      const request = { entrySymbols: ["b1"] };
      const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };

      const result = await beamSearch.beamSearchLadybug(
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

      await queries.insertEdges(kConn, [
        {
          repoId,
          fromSymbolId: "b5",
          toSymbolId: "b2",
          edgeType: "import",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
        {
          repoId,
          fromSymbolId: "b5",
          toSymbolId: "b3",
          edgeType: "import",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
      ]);
      const importResult = await beamSearch.beamSearchLadybug(
        kConn,
        repoId,
        [{ symbolId: "b5", source: "entrySymbol" as const }],
        { maxCards: 2, maxEstimatedTokens: 100_000 },
        { entrySymbols: ["b5"] },
        edgeWeights,
        0.0,
      );
      const importCards = [...importResult.sliceCards];
      assert.strictEqual(importCards.length, 2);
      assert.ok(importCards.includes("b5"));
      assert.strictEqual(
        importCards.filter((symbolId) => symbolId === "b2" || symbolId === "b3")
          .length,
        1,
      );
    },
  );

  it(
    "confidence filtering: low-confidence edges are dropped",
    { skip: !ladybugAvailable },
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

      const result = await beamSearch.beamSearchLadybug(
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
    { skip: !ladybugAvailable },
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

      const startNodes: import("../../dist/graph/slice/start-node-resolver.js").ResolvedStartNode[] =
        [];
      const budget = { maxCards: 10, maxEstimatedTokens: 100_000 };
      const request = {};
      const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };

      const result = await beamSearch.beamSearchLadybug(
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
    { skip: !ladybugAvailable },
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

      const result = await beamSearch.beamSearchLadybug(
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

  it(
    "does not traverse stale durable edges from a captured zero-edge symbol",
    { skip: !ladybugAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;
      const now = "2026-07-27T00:00:00.000Z";
      const repoId = "repo-overlay-beam";
      const fileId = "overlay-file";
      const overlaySymbol = (symbolId: string) => ({
        symbolId,
        repoId,
        fileId,
        kind: "function",
        name: symbolId,
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 3,
        rangeEndCol: 1,
        astFingerprint: `${symbolId}-fp`,
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        roleTagsJson: null,
        searchText: symbolId,
        updatedAt: now,
      });
      const overlayFile = {
        fileId,
        repoId,
        relPath: "src/overlay-beam.ts",
        contentHash: "overlay-hash",
        language: "typescript",
        byteSize: 100,
        lastIndexedAt: null,
        directory: "src",
      };
      const coordinator = await import(
        "../../dist/live-index/coordinator.js"
      );
      const overlayReader = await import(
        "../../dist/live-index/overlay-reader.js"
      );
      coordinator.resetDefaultLiveIndexCoordinator();
      overlayReader.clearSnapshotCache();
      const overlayContent =
        "export function overlayRoot() { overlayChild(); }\nfunction overlayChild() {}";
      const overlayStore = coordinator.getDefaultOverlayStore();
      overlayStore.upsertDraft({
        repoId,
        eventType: "change",
        filePath: overlayFile.relPath,
        content: overlayContent,
        language: "typescript",
        version: 1,
        dirty: true,
        timestamp: now,
      });
      overlayStore.setParseResult(
        repoId,
        overlayFile.relPath,
        1,
        {
          version: 1,
          file: overlayFile,
          symbols: [
            overlaySymbol("overlayRoot"),
            overlaySymbol("overlayChild"),
          ],
          edges: [
            {
              repoId,
              fromSymbolId: "overlayRoot",
              toSymbolId: "overlayChild",
              edgeType: "call",
              weight: 1,
              confidence: 1,
              resolution: "exact",
              resolverId: "pass1-generic",
              resolutionPhase: "pass1",
              provenance: "call:overlayChild",
              createdAt: now,
            },
          ],
          references: [],
        },
        now,
      );
      const overlaySnapshot = overlayReader.getOverlaySnapshot(repoId);

      await queries.upsertRepo(kConn, {
        repoId,
        rootPath: "C:/repo-overlay-beam",
        configJson: "{}",
        createdAt: now,
      });
      await queries.upsertFile(kConn, {
        ...overlayFile,
        contentHash: "durable-hash",
        lastIndexedAt: now,
      });
      await queries.upsertFile(kConn, {
        ...overlayFile,
        fileId: "stale-durable-file",
        relPath: "src/stale-durable.ts",
        contentHash: "stale-durable-hash",
        lastIndexedAt: now,
      });
      for (const symbolId of [
        "overlayRoot",
        "overlayChild",
        "staleGrandchild",
      ]) {
        await queries.upsertSymbol(kConn, {
          ...overlaySymbol(symbolId),
          fileId:
            symbolId === "staleGrandchild"
              ? "stale-durable-file"
              : symbolId === "overlayChild"
                ? "missing-durable-overlay-file"
                : fileId,
          name:
            symbolId === "overlayRoot"
              ? "DurableRootMismatch"
              : "DurableChildMismatch",
        });
      }
      await queries.insertEdges(kConn, [
        {
          repoId,
          fromSymbolId: "overlayChild",
          toSymbolId: "staleGrandchild",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "stale-durable",
          createdAt: now,
        },
      ]);
      assert.deepEqual(
        overlaySnapshot.outgoingEdgesBySymbolId.get("overlayChild"),
        [],
      );
      const durableChildEdges =
        await queries.getEdgesFromSymbolsForSlice(kConn, ["overlayChild"]);
      assert.equal(
        durableChildEdges.get("overlayChild")?.[0]?.toSymbolId,
        "staleGrandchild",
      );
      const result = await beamSearch.beamSearchLadybug(
        kConn,
        repoId,
        [{ symbolId: "overlayChild", source: "entrySymbol" }],
        { maxCards: 10, maxEstimatedTokens: 100_000 },
        {
          entrySymbols: ["overlayChild"],
          direction: "out",
          maxDepth: null,
        },
        { call: 1, import: 0.6, config: 0.8 },
        0,
        undefined,
        undefined,
        overlaySnapshot,
      );

      assert.ok(result.sliceCards.has("overlayChild"));
      assert.equal(result.sliceCards.has("staleGrandchild"), false);
      coordinator.resetDefaultLiveIndexCoordinator();
      overlayReader.clearSnapshotCache();
    },
  );
});
