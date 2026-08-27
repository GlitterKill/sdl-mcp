import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync, mkdirSync } from "node:fs";

import {
  initLadybugDb,
  closeLadybugDb,
  getLadybugConn,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { queryStoredProcAll } from "../../dist/db/ladybug-core.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  getEmbeddingProvider,
  refreshSymbolEmbeddings,
  type EmbeddingProvider,
} from "../../dist/indexer/embeddings.js";
import { refreshFileSummaryEmbeddings } from "../../dist/indexer/file-summary-embeddings.js";
import { readSafeRebuildJinaVectorProbe } from "../../dist/db/ladybug-safe-rebuild.js";
import {
  AGENTFEEDBACK_EMBEDDING_PROPERTIES,
  AGENTFEEDBACK_VECTOR_INDEX_NAMES,
  checkIndexHealth,
  createFtsIndex,
  createVectorIndex,
  dropVectorIndex,
  ensureIndexes,
  FILESUMMARY_EMBEDDING_PROPERTIES,
  FILESUMMARY_VECTOR_INDEX_NAMES,
  queryVectorIndexProbe,
  showIndexesStrict,
} from "../../dist/retrieval/index-lifecycle.js";
import {
  createRetrievalQueryContext,
  hybridSearch,
  narrowFilesForQuery,
} from "../../dist/retrieval/orchestrator.js";
import { applyQueryPrefix } from "../../dist/indexer/model-registry.js";
import { SemanticRetrievalConfigSchema } from "../../dist/config/types.js";
import { beginGraphIntegrityVersion } from "../../dist/db/ladybug-derived-state.js";
import { checkRetrievalHealth } from "../../dist/retrieval/health.js";
import { getSymbolRetrievalCoverage } from "../../dist/db/ladybug-retrieval-health.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
  type ObservabilityTap,
  type PostIndexSessionTapEvent,
} from "../../dist/observability/event-tap.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Semantic Embedding Pipeline", () => {
  const testDir = join(__dirname, "test-semantic-embedding");
  const graphDbPath = join(testDir, "graph");
  const repoId = "embed-test-repo";
  const jinaModel = "jina-embeddings-v2-base-code";

  const symbols: ladybugDb.SymbolRow[] = [
    {
      symbolId: "sym-auth",
      repoId,
      fileId: "file1",
      kind: "function",
      name: "authenticateUser",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 10,
      rangeEndCol: 1,
      astFingerprint: "fp-auth",
      signatureJson: JSON.stringify(
        "(username: string, password: string) => Promise<User>",
      ),
      summary: "Authenticate a user with username and password credentials",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: new Date().toISOString(),
    },
    {
      symbolId: "sym-fetch",
      repoId,
      fileId: "file1",
      kind: "function",
      name: "fetchUserData",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 15,
      rangeStartCol: 0,
      rangeEndLine: 25,
      rangeEndCol: 1,
      astFingerprint: "fp-fetch",
      signatureJson: JSON.stringify("(userId: string) => Promise<UserData>"),
      summary: "Fetch user profile data from the database",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: new Date().toISOString(),
    },
    {
      symbolId: "sym-render",
      repoId,
      fileId: "file2",
      kind: "function",
      name: "renderDashboard",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 20,
      rangeEndCol: 1,
      astFingerprint: "fp-render",
      signatureJson: JSON.stringify("(data: DashboardData) => JSX.Element"),
      summary: "Render the main dashboard UI component",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: new Date().toISOString(),
    },
  ];

  beforeEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: "/fake/embed-repo",
      configJson: JSON.stringify({
        repoId,
        rootPath: "/fake/embed-repo",
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });

    await ladybugDb.upsertFile(conn, {
      fileId: "file1",
      repoId,
      relPath: "src/auth.ts",
      contentHash: "hash1",
      language: "ts",
      byteSize: 500,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "file2",
      repoId,
      relPath: "src/dashboard.ts",
      contentHash: "hash2",
      language: "ts",
      byteSize: 800,
      lastIndexedAt: now,
    });

    for (const sym of symbols) {
      await ladybugDb.upsertSymbol(conn, sym);
    }
  });

  afterEach(async () => {
    resetObservabilityTap();
    await closeLadybugDb();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createRecordingProvider(): {
    provider: EmbeddingProvider;
    calls: string[][];
  } {
    const calls: string[][] = [];
    return {
      calls,
      provider: {
        async embed(texts: string[]): Promise<number[][]> {
          calls.push([...texts]);
          return texts.map((text, index) =>
            makeDeterministicVector(text, calls.length, index),
          );
        },
        getDimension(): number {
          return 768;
        },
        isMockFallback(): boolean {
          return false;
        },
      },
    };
  }

  function makeDeterministicVector(
    text: string,
    callNumber: number,
    index: number,
  ): number[] {
    const vector = new Array<number>(768).fill(0);
    vector[0] = ((text.length % 97) + 1) / 100;
    vector[1] = callNumber / 100;
    vector[2] = (index + 1) / 100;
    return vector;
  }

  async function upsertStandardFileSummaries(
    conn: Awaited<ReturnType<typeof getLadybugConn>>,
    updatedAt = "2026-05-05T00:00:00Z",
  ): Promise<void> {
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary: "File: src/auth.ts\nLanguage: ts\nExports: authenticateUser",
        searchText: "file: src/auth.ts exports: authenticateUser",
        updatedAt,
      },
      {
        fileId: "file2",
        repoId,
        summary:
          "File: src/dashboard.ts\nLanguage: ts\nExports: renderDashboard",
        searchText: "file: src/dashboard.ts exports: renderDashboard",
        updatedAt,
      },
    ]);
  }

  interface FileSummaryEmbeddingState {
    fileId: string;
    summary: string | null;
    searchText: string | null;
    summaryUpdatedAt: string | null;
    vector: string | null;
    cardHash: string | null;
    embeddingUpdatedAt: string | null;
    vectorArray: unknown;
  }

  async function readFileSummaryEmbeddingRows(
    conn: Awaited<ReturnType<typeof getLadybugConn>>,
    fileIds: string[],
  ): Promise<Map<string, FileSummaryEmbeddingState>> {
    const rows = await ladybugDb.queryAll<FileSummaryEmbeddingState>(
      conn,
      `MATCH (fs:FileSummary)
       WHERE fs.fileId IN $fileIds
       RETURN fs.fileId AS fileId,
              fs.summary AS summary,
              fs.searchText AS searchText,
              fs.updatedAt AS summaryUpdatedAt,
              fs.embeddingJinaCode AS vector,
              fs.embeddingJinaCodeCardHash AS cardHash,
              fs.embeddingJinaCodeUpdatedAt AS embeddingUpdatedAt,
              fs.embeddingJinaCodeVec AS vectorArray`,
      { fileIds },
    );
    return new Map(rows.map((row) => [row.fileId, row]));
  }

  function assertStoredVectorArray(value: unknown, fileId: string): void {
    assert.ok(Array.isArray(value), `${fileId} should store a vector array`);
    assert.strictEqual(value.length, 768);
    assert.ok(
      value.some((entry) => typeof entry === "number" && entry !== 0),
      `${fileId} vector array should contain provider values`,
    );
  }

  async function countSymbolVectorRows(
    conn: Awaited<ReturnType<typeof getLadybugConn>>,
  ): Promise<number> {
    const row = await ladybugDb.querySingle<{ count: number | bigint }>(
      conn,
      "MATCH (e:SymbolVectorEmbedding) RETURN count(e) AS count",
    );
    return ladybugDb.toNumber(row?.count ?? 0);
  }

  async function queryJinaNeighbor(
    conn: Awaited<ReturnType<typeof getLadybugConn>>,
    vector: number[],
  ): Promise<{ symbolId: string; distance: number }> {
    const rows = await queryStoredProcAll<{
      symbolId: string;
      distance: number;
    }>(
      conn,
      `CALL QUERY_VECTOR_INDEX('SymbolVectorEmbedding', 'symbol_vec_jina_code_v2', ${JSON.stringify(vector)}, 1, efs := 200) RETURN node.symbolId AS symbolId, distance`,
    );
    assert.strictEqual(rows.length, 1);
    return rows[0];
  }

  async function seedDeletionVectors(
    deletedSymbols: ladybugDb.SymbolRow[],
    preservedSymbol: ladybugDb.SymbolRow,
  ): Promise<number[]> {
    const nomicModel = "nomic-embed-text-v1.5";
    const allSymbols = [...deletedSymbols, preservedSymbol];
    const jinaVectors = new Map(
      allSymbols.map((symbol, index) => [
        symbol.symbolId,
        makeDeterministicVector(symbol.symbolId, 10, index),
      ]),
    );

    await withWriteConn(async (conn) => {
      for (const symbol of allSymbols) {
        const jinaVector = jinaVectors.get(symbol.symbolId)!;
        await ladybugDb.setSymbolVectorEmbedding(
          conn,
          repoId,
          symbol.symbolId,
          jinaModel,
          `${symbol.symbolId}-jina`,
          `${symbol.symbolId}-jina-hash`,
          jinaVector,
        );
        await ladybugDb.setSymbolVectorEmbedding(
          conn,
          repoId,
          symbol.symbolId,
          nomicModel,
          `${symbol.symbolId}-nomic`,
          `${symbol.symbolId}-nomic-hash`,
          makeDeterministicVector(
            symbol.symbolId,
            20,
            allSymbols.indexOf(symbol),
          ),
        );
      }
      await createVectorIndex(
        conn,
        "SymbolVectorEmbedding",
        "embeddingJinaCodeVec",
        "symbol_vec_jina_code_v2",
        768,
      );
    });

    return jinaVectors.get(preservedSymbol.symbolId)!;
  }

  async function assertDeletedVectorsAndHealthyIndex(
    deletedSymbolIds: string[],
    preservedSymbolId: string,
    preservedJinaVector: number[],
  ): Promise<void> {
    const conn = await getLadybugConn();
    const rows = await ladybugDb.queryAll<{
      symbolId: string;
      model: string;
    }>(
      conn,
      `MATCH (e:SymbolVectorEmbedding)
       RETURN e.symbolId AS symbolId, e.model AS model
       ORDER BY e.symbolId, e.model`,
    );
    assert.ok(
      rows.every((row) => !deletedSymbolIds.includes(row.symbolId)),
      "all model rows for deleted Symbols should be removed",
    );
    assert.deepStrictEqual(
      rows.filter((row) => row.symbolId === preservedSymbolId),
      [
        { symbolId: preservedSymbolId, model: jinaModel },
        { symbolId: preservedSymbolId, model: "nomic-embed-text-v1.5" },
      ],
    );
    assert.ok(
      (await showIndexesStrict(conn)).some(
        ({ tableName, name }) =>
          tableName === "SymbolVectorEmbedding" &&
          name === "symbol_vec_jina_code_v2",
      ),
    );
    const neighbor = await queryJinaNeighbor(conn, preservedJinaVector);
    assert.strictEqual(neighbor.symbolId, preservedSymbolId);
    assert.ok(Math.abs(neighbor.distance) <= 1e-6);
  }

  it("deleteSymbolsByFileId removes every model row and retains live HNSW", async () => {
    const preservedVector = await seedDeletionVectors(
      [symbols[0], symbols[1]],
      symbols[2],
    );

    await withWriteConn((conn) =>
      ladybugDb.deleteSymbolsByFileId(conn, "file1"),
    );

    await assertDeletedVectorsAndHealthyIndex(
      [symbols[0].symbolId, symbols[1].symbolId],
      symbols[2].symbolId,
      preservedVector,
    );
  });

  it("deleteSymbolsByFileIds removes every model row and retains live HNSW", async () => {
    const preservedVector = await seedDeletionVectors(
      [symbols[0], symbols[1]],
      symbols[2],
    );

    await withWriteConn((conn) =>
      ladybugDb.deleteSymbolsByFileIds(conn, ["file1"]),
    );

    await assertDeletedVectorsAndHealthyIndex(
      [symbols[0].symbolId, symbols[1].symbolId],
      symbols[2].symbolId,
      preservedVector,
    );
  });

  it("deleteFilesByIds removes every model row and retains live HNSW", async () => {
    const preservedVector = await seedDeletionVectors(
      [symbols[0], symbols[1]],
      symbols[2],
    );

    await withWriteConn((conn) => ladybugDb.deleteFilesByIds(conn, ["file1"]));

    await assertDeletedVectorsAndHealthyIndex(
      [symbols[0].symbolId, symbols[1].symbolId],
      symbols[2].symbolId,
      preservedVector,
    );
  });

  for (const [name, deleteTarget] of [
    [
      "deleteSymbolsByFileId",
      (conn: Awaited<ReturnType<typeof getLadybugConn>>) =>
        ladybugDb.deleteSymbolsByFileId(conn, "file1"),
    ],
    [
      "deleteSymbolsByFileIds",
      (conn: Awaited<ReturnType<typeof getLadybugConn>>) =>
        ladybugDb.deleteSymbolsByFileIds(conn, ["file1"]),
    ],
    [
      "deleteFilesByIds",
      (conn: Awaited<ReturnType<typeof getLadybugConn>>) =>
        ladybugDb.deleteFilesByIds(conn, ["file1"]),
    ],
  ] as const) {
    it(`${name} preserves symbols and vectors owned by another repository`, async () => {
      const conn = await getLadybugConn();
      const sharedSymbolId = symbols[0].symbolId;
      const otherRepoId = "embed-other-repo";
      const otherFileId = "embed-other-file";
      const now = new Date().toISOString();

      await ladybugDb.upsertRepo(conn, {
        repoId: otherRepoId,
        rootPath: "/fake/embed-other-repo",
        configJson: "{}",
        createdAt: now,
      });
      await ladybugDb.upsertFile(conn, {
        fileId: otherFileId,
        repoId: otherRepoId,
        relPath: "src/shared.ts",
        contentHash: "shared-hash",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: now,
      });
      await ladybugDb.exec(
        conn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         MATCH (f:File {fileId: $fileId})
         MATCH (r:Repo {repoId: $repoId})
         MERGE (s)-[:SYMBOL_IN_FILE]->(f)
         MERGE (s)-[:SYMBOL_IN_REPO]->(r)`,
        { symbolId: sharedSymbolId, fileId: otherFileId, repoId: otherRepoId },
      );
      await ladybugDb.setSymbolVectorEmbedding(
        conn,
        repoId,
        sharedSymbolId,
        jinaModel,
        "shared-vector",
        "shared-vector-hash",
        makeDeterministicVector("shared-vector", 30, 0),
      );

      await withWriteConn(deleteTarget);

      const ownership = await ladybugDb.querySingle<{
        repoId: string;
        embeddingRepoId: string;
      }>(
        conn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         MATCH (e:SymbolVectorEmbedding {symbolId: $symbolId})
         RETURN s.repoId AS repoId, e.repoId AS embeddingRepoId`,
        { symbolId: sharedSymbolId },
      );
      assert.deepStrictEqual(ownership, {
        repoId: otherRepoId,
        embeddingRepoId: otherRepoId,
      });
      const memberships = await ladybugDb.queryAll<{ repoId: string }>(
        conn,
        `MATCH (:Symbol {symbolId: $symbolId})-[:SYMBOL_IN_REPO]->(r:Repo)
         RETURN r.repoId AS repoId
         ORDER BY repoId`,
        { symbolId: sharedSymbolId },
      );
      assert.deepStrictEqual(memberships, [{ repoId: otherRepoId }]);
      const files = await ladybugDb.queryAll<{ fileId: string }>(
        conn,
        `MATCH (:Symbol {symbolId: $symbolId})-[:SYMBOL_IN_FILE]->(f:File)
         RETURN f.fileId AS fileId
         ORDER BY fileId`,
        { symbolId: sharedSymbolId },
      );
      assert.deepStrictEqual(files, [{ fileId: otherFileId }]);
    });
  }

  it("deleteSymbolsByIds removes every model row and retains live HNSW", async () => {
    const preservedVector = await seedDeletionVectors([symbols[0]], symbols[1]);

    await withWriteConn((conn) =>
      ladybugDb.deleteSymbolsByIds(conn, [symbols[0].symbolId]),
    );

    await assertDeletedVectorsAndHealthyIndex(
      [symbols[0].symbolId],
      symbols[1].symbolId,
      preservedVector,
    );
  });

  it("mock provider generates embeddings with expected dimension", async () => {
    const provider = getEmbeddingProvider("mock");
    const embeddings = await provider.embed([
      "authenticate user login",
      "render dashboard view",
    ]);
    assert.strictEqual(embeddings.length, 2);
    assert.strictEqual(embeddings[0].length, 64);
    assert.strictEqual(embeddings[1].length, 64);
  });

  it("stores model-specific symbol vectors as independent complete rows", async () => {
    const conn = await getLadybugConn();
    const symbolId = symbols[0].symbolId;
    const nomicModel = "nomic-embed-text-v1.5";
    const jinaVector = makeDeterministicVector("jina", 1, 0);
    const nomicVector = makeDeterministicVector("nomic", 2, 0);

    await withWriteConn(async (writeConn) => {
      await ladybugDb.setSymbolVectorEmbeddingBatch(
        writeConn,
        repoId,
        jinaModel,
        [
          {
            symbolId,
            vector: "jina-text-vector",
            cardHash: "jina-card-hash",
            vectorArray: jinaVector,
          },
        ],
      );
      await ladybugDb.setSymbolVectorEmbedding(
        writeConn,
        repoId,
        symbolId,
        nomicModel,
        "nomic-text-vector",
        "nomic-card-hash",
        nomicVector,
      );
    });

    const rows = await ladybugDb.queryAll<{
      embeddingId: string;
      repoId: string;
      symbolId: string;
      model: string;
      vector: string;
      cardHash: string;
      updatedAt: string;
      jinaVector: unknown;
      nomicVector: unknown;
    }>(
      conn,
      `MATCH (e:SymbolVectorEmbedding {symbolId: $symbolId})
       RETURN e.embeddingId AS embeddingId,
              e.repoId AS repoId,
              e.symbolId AS symbolId,
              e.model AS model,
              e.embeddingVector AS vector,
              e.cardHash AS cardHash,
              e.updatedAt AS updatedAt,
              e.embeddingJinaCodeVec AS jinaVector,
              e.embeddingNomicVec AS nomicVector
       ORDER BY e.model`,
      { symbolId },
    );
    assert.deepStrictEqual(
      rows.map(
        ({ embeddingId, repoId: rowRepoId, symbolId: rowSymbolId, model }) => ({
          embeddingId,
          repoId: rowRepoId,
          symbolId: rowSymbolId,
          model,
        }),
      ),
      [
        {
          embeddingId: `${jinaModel}:${symbolId}`,
          repoId,
          symbolId,
          model: jinaModel,
        },
        {
          embeddingId: `${nomicModel}:${symbolId}`,
          repoId,
          symbolId,
          model: nomicModel,
        },
      ],
    );
    assert.deepStrictEqual(
      rows.map(({ vector, cardHash }) => ({ vector, cardHash })),
      [
        { vector: "jina-text-vector", cardHash: "jina-card-hash" },
        { vector: "nomic-text-vector", cardHash: "nomic-card-hash" },
      ],
    );
    assert.ok(rows.every(({ updatedAt }) => updatedAt.length > 0));
    assertStoredVectorArray(rows[0].jinaVector, "Jina row");
    assert.strictEqual(rows[0].nomicVector, null);
    assert.strictEqual(rows[1].jinaVector, null);
    assertStoredVectorArray(rows[1].nomicVector, "Nomic row");

    await ladybugDb.exec(
      conn,
      `MATCH (e:SymbolVectorEmbedding {embeddingId: $embeddingId})
       SET e.embeddingJinaCodeVec = null`,
      { embeddingId: `${jinaModel}:${symbolId}` },
    );

    const complete = await ladybugDb.getSymbolVectorEmbeddings(
      conn,
      [symbolId],
      jinaModel,
    );
    assert.strictEqual(
      complete.has(symbolId),
      false,
      "text and hash without the selected numeric vector must be recomputed",
    );
    assert.strictEqual(
      await ladybugDb.getSymbolVectorEmbedding(conn, symbolId, jinaModel),
      null,
    );
  });

  it("single-row writes replace an embedding while its HNSW remains live", async () => {
    const conn = await getLadybugConn();
    const symbolId = symbols[0].symbolId;
    const firstVector = [1, ...new Array<number>(767).fill(0)];
    const replacementVector = [0, 1, ...new Array<number>(766).fill(0)];

    await withWriteConn(async (writeConn) => {
      await ladybugDb.setSymbolVectorEmbedding(
        writeConn,
        repoId,
        symbolId,
        jinaModel,
        "first-vector",
        "first-card-hash",
        firstVector,
      );
      assert.equal(
        await createVectorIndex(
          writeConn,
          "SymbolVectorEmbedding",
          "embeddingJinaCodeVec",
          "symbol_vec_jina_code_v2",
          768,
        ),
        true,
      );
      await ladybugDb.setSymbolVectorEmbedding(
        writeConn,
        repoId,
        symbolId,
        jinaModel,
        "replacement-vector",
        "replacement-card-hash",
        replacementVector,
      );
    });

    const embedding = await ladybugDb.getSymbolVectorEmbedding(
      conn,
      symbolId,
      jinaModel,
    );
    assert.equal(embedding?.vector, "replacement-vector");
    assert.equal(embedding?.cardHash, "replacement-card-hash");
    assert.ok(embedding?.updatedAt);
    const neighbors = await queryStoredProcAll<{
      symbolId: string;
      distance: number;
    }>(
      conn,
      `CALL QUERY_VECTOR_INDEX('SymbolVectorEmbedding', 'symbol_vec_jina_code_v2', ${JSON.stringify(replacementVector)}, 1, efs := 200) RETURN node.symbolId AS symbolId, distance`,
    );
    assert.equal(neighbors[0]?.symbolId, symbolId);
    assert.ok(
      Math.abs(neighbors[0]?.distance ?? Number.POSITIVE_INFINITY) <= 1e-6,
    );
  });

  it("refreshSymbolEmbeddings skips persistence for mock-fallback embeddings", async () => {
    const result = await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "jina-embeddings-v2-base-code",
      symbols,
    });

    assert.strictEqual(result.embedded, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.degraded, true);

    // Mock fallback vectors are intentionally not persisted to Symbol node
    // properties because they do not map to a supported embedding model.
    const conn = await getLadybugConn();
    for (const sym of symbols) {
      const embedding = await ladybugDb.getSymbolEmbedding(conn, sym.symbolId);
      assert.strictEqual(
        embedding,
        null,
        `Mock fallback embedding should not persist for ${sym.symbolId}`,
      );
    }
  });

  it("does not bootstrap Symbol HNSW without a complete model row", async () => {
    const phases: string[] = [];
    const result = await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: jinaModel,
      symbols,
      recordTiming: (phaseName) => phases.push(phaseName),
    });

    assert.equal(result.degraded, true);
    assert.equal(phases.includes("hnsw.create"), false);
    assert.equal(
      (await showIndexesStrict(await getLadybugConn())).some(
        ({ tableName, name }) =>
          tableName === "SymbolVectorEmbedding" &&
          name === "symbol_vec_jina_code_v2",
      ),
      false,
    );
  });

  it("refreshSymbolEmbeddings continues to skip mock-fallback vectors across runs", async () => {
    // First run: mock fallback vectors are not persisted.
    const first = await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "jina-embeddings-v2-base-code",
      symbols,
    });
    assert.strictEqual(first.embedded, 0);
    assert.strictEqual(first.skipped, 0);
    assert.strictEqual(first.degraded, true);

    // Second run with the same inputs should behave identically.
    const second = await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "jina-embeddings-v2-base-code",
      symbols,
    });
    assert.strictEqual(second.embedded, 0);
    assert.strictEqual(second.skipped, 0);
    assert.strictEqual(second.degraded, true);
  });

  it("does not report mock-degraded symbol batches as completed progress", async () => {
    let mockFallback = false;
    const progress: Array<{ current: number; total: number }> = [];
    const embeddingProvider: EmbeddingProvider = {
      async embed(texts): Promise<number[][]> {
        mockFallback = true;
        return texts.map(() => new Array<number>(64).fill(0));
      },
      getDimension(): number {
        return 768;
      },
      isMockFallback(): boolean {
        return mockFallback;
      },
    };

    const result = await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: "jina-embeddings-v2-base-code",
      symbols,
      embeddingProvider,
      onProgress: ({ current, total }) => progress.push({ current, total }),
    });

    assert.deepStrictEqual(result, {
      embedded: 0,
      skipped: 0,
      degraded: true,
    });
    assert.ok(progress.length > 0);
    assert.ok(progress.every(({ current, total }) => current < total));
  });

  it("fails the refresh when a replacement insert is rejected", async () => {
    const conn = await getLadybugConn();
    await withWriteConn((writeConn) =>
      ladybugDb.setSymbolVectorEmbedding(
        writeConn,
        repoId,
        symbols[0].symbolId,
        jinaModel,
        "stale-vector",
        "stale-card-hash",
        makeDeterministicVector("stale", 1, 0),
      ),
    );
    const embeddingProvider: EmbeddingProvider = {
      async embed(texts): Promise<number[][]> {
        return texts.map((text) =>
          new Array<number>(text.includes("authenticateUser") ? 767 : 768).fill(
            0.1,
          ),
        );
      },
      getDimension: () => 768,
      isMockFallback: () => false,
    };

    await assert.rejects(
      refreshSymbolEmbeddings({
        repoId,
        provider: "local",
        model: jinaModel,
        symbols,
        embeddingProvider,
        batchSize: 1,
        concurrency: 3,
      }),
      /persistence failed/i,
    );
    assert.equal(
      await ladybugDb.getSymbolVectorEmbedding(
        conn,
        symbols[0].symbolId,
        jinaModel,
      ),
      null,
    );
  });

  it("bootstraps HNSW and rebuilds it during incremental refresh", async () => {
    const { provider: recordingProvider } = createRecordingProvider();
    let embeddingCallsStarted = 0;
    let releaseConcurrentCalls!: () => void;
    const concurrentCallsStarted = new Promise<void>((resolve) => {
      releaseConcurrentCalls = resolve;
    });
    const provider: EmbeddingProvider = {
      ...recordingProvider,
      async embed(texts): Promise<number[][]> {
        if (++embeddingCallsStarted === 2) releaseConcurrentCalls();
        await concurrentCallsStarted;
        return recordingProvider.embed(texts);
      },
    };
    const timings = new Map<string, number>();
    const timingCalls: string[] = [];
    const progressSubstages: Array<string | undefined> = [];
    const memorySnapshots: Array<{
      phase: string;
      snapshot: Record<string, number>;
    }> = [];

    const refreshParams = {
      repoId,
      provider: "local",
      model: jinaModel,
      embeddingProvider: provider,
      batchSize: 1,
      concurrency: 2,
      onProgress: ({ substage }) => progressSubstages.push(substage),
      recordTiming: (phaseName, durationMs) => {
        timingCalls.push(phaseName);
        timings.set(phaseName, (timings.get(phaseName) ?? 0) + durationMs);
      },
      recordMemorySnapshot: (
        phase: string,
        snapshot: Record<string, number>,
      ) => memorySnapshots.push({ phase, snapshot }),
    } as Parameters<typeof refreshSymbolEmbeddings>[0] & {
      recordMemorySnapshot: (
        phase: string,
        snapshot: Record<string, number>,
      ) => void;
    };
    const result = await refreshSymbolEmbeddings(refreshParams);

    assert.deepStrictEqual(result, {
      embedded: symbols.length,
      skipped: 0,
    });
    assert.ok(
      progressSubstages.includes("symbolVectorIndex"),
      "the rebuild must expose HNSW construction after embedding progress",
    );

    const conn = await getLadybugConn();
    for (const symbol of symbols) {
      const embedding = await ladybugDb.getSymbolVectorEmbedding(
        conn,
        symbol.symbolId,
        jinaModel,
      );
      assert.ok(embedding, `${symbol.symbolId} should persist an embedding`);
      assert.ok(embedding.vector.length > 0);
      assert.ok(embedding.cardHash.length > 0);
    }
    const rowCountBefore = await countSymbolVectorRows(conn);

    for (const phaseName of [
      "inference",
      "hnsw.create",
      "checkpoint.pre",
      "checkpoint.post",
    ]) {
      assert.equal(
        typeof timings.get(phaseName),
        "number",
        `expected ${phaseName} timing`,
      );
    }
    assert.equal(
      timingCalls.filter((phaseName) => phaseName === "inference").length,
      Math.ceil(symbols.length / 2),
      "overlapping inference batches should emit one wall-time interval per concurrency window",
    );
    assert.deepEqual(
      memorySnapshots.map(({ phase }) => phase),
      ["beforeInference", "afterInference", "beforeHnsw", "afterHnsw"],
    );
    for (const { snapshot } of memorySnapshots) {
      for (const field of [
        "rssBytes",
        "heapUsedBytes",
        "externalBytes",
        "arrayBuffersBytes",
        "systemFreeBytes",
        "systemTotalBytes",
      ]) {
        assert.equal(typeof snapshot[field], "number", `expected ${field}`);
        assert.ok(snapshot[field] >= 0, `expected non-negative ${field}`);
      }
    }

    const changedSymbol = {
      ...symbols[0],
      signatureJson: JSON.stringify(
        "(username: string, password: string, otp: string) => Promise<User>",
      ),
    };
    const incrementalPhases: string[] = [];
    const second = await refreshSymbolEmbeddings({
      ...refreshParams,
      symbols: [changedSymbol],
      batchSize: 1,
      concurrency: 1,
      recordTiming: (phaseName) => incrementalPhases.push(phaseName),
      recordMemorySnapshot: undefined,
    });
    assert.deepStrictEqual(second, { embedded: 1, skipped: 0 });
    assert.deepStrictEqual(
      incrementalPhases.filter((phaseName) =>
        [
          "checkpoint.pre",
          "hnsw.drop",
          "inference",
          "hnsw.create",
          "checkpoint.post",
        ].includes(phaseName),
      ),
      [
        "checkpoint.pre",
        "hnsw.drop",
        "inference",
        "hnsw.create",
        "checkpoint.post",
      ],
      "incremental Symbol writes must run with the shared-table HNSW absent",
    );
    assert.strictEqual(await countSymbolVectorRows(conn), rowCountBefore);

    const changedRow = await ladybugDb.querySingle<{ vector: unknown }>(
      conn,
      `MATCH (e:SymbolVectorEmbedding {embeddingId: $embeddingId})
       RETURN e.embeddingJinaCodeVec AS vector`,
      { embeddingId: `${jinaModel}:${changedSymbol.symbolId}` },
    );
    assert.ok(Array.isArray(changedRow?.vector));
    const changedVector = changedRow.vector as number[];
    let neighbor = await queryJinaNeighbor(conn, changedVector);
    assert.strictEqual(neighbor.symbolId, changedSymbol.symbolId);
    assert.ok(Math.abs(neighbor.distance) <= 1e-6);

    await closeLadybugDb({ strict: true });
    await initLadybugDb(graphDbPath);
    const reopenedConn = await getLadybugConn();
    assert.strictEqual(await countSymbolVectorRows(reopenedConn), rowCountBefore);
    neighbor = await queryJinaNeighbor(reopenedConn, changedVector);
    assert.strictEqual(neighbor.symbolId, changedSymbol.symbolId);
    assert.ok(Math.abs(neighbor.distance) <= 1e-6);
  });

  it("bootstraps the embedding-table HNSW beside a same-named legacy Symbol index", async () => {
    const indexName = "symbol_vec_jina_code_v2";
    const { provider } = createRecordingProvider();
    await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      embeddingProvider: provider,
    });

    let indexes = await showIndexesStrict(await getLadybugConn());
    if (
      !indexes.some(
        ({ tableName, name }) => tableName === "Symbol" && name === indexName,
      )
    ) {
      await withWriteConn((conn) =>
        createVectorIndex(
          conn,
          "Symbol",
          "embeddingJinaCodeVec",
          indexName,
          768,
        ),
      );
    }
    await withWriteConn((conn) =>
      dropVectorIndex(conn, "SymbolVectorEmbedding", indexName),
    );

    indexes = await showIndexesStrict(await getLadybugConn());
    assert.ok(
      indexes.some(
        ({ tableName, name }) => tableName === "Symbol" && name === indexName,
      ),
    );
    assert.ok(
      !indexes.some(
        ({ tableName, name }) =>
          tableName === "SymbolVectorEmbedding" && name === indexName,
      ),
    );

    let providerCalls = 0;
    const noInferenceProvider: EmbeddingProvider = {
      async embed(): Promise<number[][]> {
        providerCalls++;
        throw new Error("cached rows must not invoke the provider");
      },
      getDimension: () => 768,
      isMockFallback: () => false,
    };
    const phases: string[] = [];
    const result = await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      embeddingProvider: noInferenceProvider,
      recordTiming: (phaseName) => phases.push(phaseName),
    });

    assert.strictEqual(providerCalls, 0);
    assert.strictEqual(
      phases.filter((phaseName) => phaseName === "hnsw.create").length,
      1,
      "a zero-uncached refresh must create the missing embedding-table HNSW once",
    );
    assert.deepStrictEqual(result, { embedded: 0, skipped: symbols.length });
    indexes = await showIndexesStrict(await getLadybugConn());
    assert.deepStrictEqual(
      indexes
        .filter(({ name }) => name === indexName)
        .map(({ tableName, property }) => ({ tableName, property }))
        .sort((a, b) => (a.tableName ?? "").localeCompare(b.tableName ?? "")),
      [
        { tableName: "Symbol", property: "embeddingJinaCodeVec" },
        {
          tableName: "SymbolVectorEmbedding",
          property: "embeddingJinaCodeVec",
        },
      ],
    );
  });

  it("bootstraps migrated rows when the provider is already degraded", async () => {
    const conn = await getLadybugConn();
    await withWriteConn((writeConn) =>
      ladybugDb.setSymbolVectorEmbeddingBatch(
        writeConn,
        repoId,
        jinaModel,
        symbols.map((symbol, index) => ({
          symbolId: symbol.symbolId,
          vector: `migrated-vector-${index}`,
          cardHash: `migrated-card-hash-${index}`,
          vectorArray: makeDeterministicVector("migrated", 1, index),
        })),
      ),
    );
    const readRows = () =>
      ladybugDb.queryAll<{
        embeddingId: string;
        vector: string;
        cardHash: string;
        updatedAt: string;
        vectorArray: number[];
      }>(
        conn,
        `MATCH (e:SymbolVectorEmbedding)
         RETURN e.embeddingId AS embeddingId,
                e.embeddingVector AS vector,
                e.cardHash AS cardHash,
                e.updatedAt AS updatedAt,
                e.embeddingJinaCodeVec AS vectorArray
         ORDER BY e.embeddingId`,
      );
    const rowsBefore = await readRows();

    let providerCalls = 0;
    const degradedProvider: EmbeddingProvider = {
      async embed(): Promise<number[][]> {
        providerCalls++;
        throw new Error("degraded provider must not run inference");
      },
      getDimension: () => 64,
      isMockFallback: () => true,
    };
    const phases: string[] = [];
    const result = await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      embeddingProvider: degradedProvider,
      recordTiming: (phaseName) => phases.push(phaseName),
    });

    assert.deepStrictEqual(result, {
      embedded: 0,
      skipped: 0,
      degraded: true,
    });
    assert.strictEqual(providerCalls, 0);
    assert.strictEqual(
      phases.filter((phaseName) => phaseName === "hnsw.create").length,
      1,
    );
    assert.ok(
      (await showIndexesStrict(conn)).some(
        ({ tableName, name, property }) =>
          tableName === "SymbolVectorEmbedding" &&
          name === "symbol_vec_jina_code_v2" &&
          property === "embeddingJinaCodeVec",
      ),
    );
    assert.deepStrictEqual(await readRows(), rowsBefore);
  });

  it("uses the configured Symbol HNSW name during bootstrap", async () => {
    const events: PostIndexSessionTapEvent[] = [];
    installObservabilityTap(new Proxy({} as ObservabilityTap, {
      get: (_target, property) => property === "postIndexSession"
        ? (event: PostIndexSessionTapEvent) => events.push(event)
        : () => {},
    }));
    const { provider } = createRecordingProvider();
    await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      symbols,
      embeddingProvider: provider,
      vectorIndexName: "custom_jina_index",
      vectorEfc: 42,
    });

    const indexes = await showIndexesStrict(await getLadybugConn());
    assert.ok(
      indexes.some(
        ({ tableName, name, property }) =>
          tableName === "SymbolVectorEmbedding" &&
          name === "custom_jina_index" &&
          property === "embeddingJinaCodeVec",
      ),
    );
    assert.ok(
      !indexes.some(({ name }) => name === "symbol_vec_jina_code_v2"),
    );
    assert.deepEqual(events.map(({ repoId }) => repoId), [repoId]);
  });

  it("rejects a configured embedding-table HNSW name owned by another model", async () => {
    await withWriteConn((conn) =>
      createVectorIndex(
        conn,
        "SymbolVectorEmbedding",
        "embeddingNomicVec",
        "shared_symbol_index",
        768,
      ),
    );

    const { provider } = createRecordingProvider();
    await assert.rejects(
      refreshSymbolEmbeddings({
        repoId,
        provider: "local",
        model: jinaModel,
        symbols,
        embeddingProvider: provider,
        vectorIndexName: "shared_symbol_index",
      }),
      /belongs to SymbolVectorEmbedding\.embeddingNomicVec/i,
    );

    const indexes = await showIndexesStrict(await getLadybugConn());
    assert.ok(
      indexes.some(
        ({ tableName, name, property }) =>
          tableName === "SymbolVectorEmbedding" &&
          name === "shared_symbol_index" &&
          property === "embeddingNomicVec",
      ),
    );
  });

  it("startup rejects a configured Symbol HNSW name attached to the wrong property", async () => {
    const indexName = "symbol_vec_jina_code_v2";
    const vector = [1, ...new Array<number>(767).fill(0)];
    await withWriteConn(async (conn) => {
      await ladybugDb.setSymbolVectorEmbedding(
        conn,
        repoId,
        symbols[0].symbolId,
        jinaModel,
        "jina-vector",
        "jina-hash",
        vector,
      );
      assert.equal(
        await createVectorIndex(
          conn,
          "SymbolVectorEmbedding",
          "embeddingNomicVec",
          indexName,
          768,
        ),
        true,
      );
    });

    const conn = await getLadybugConn();
    const health = await checkIndexHealth(conn);
    assert.equal(
      health.vectors.find(({ model }) => model === jinaModel)?.exists,
      false,
    );

    const config = SemanticRetrievalConfigSchema.parse({
      fts: { enabled: false },
      vector: {
        enabled: true,
        indexes: { [jinaModel]: { indexName } },
      },
    });
    const result = await ensureIndexes(conn, config);
    assert.ok(result.failed.includes(indexName));
    assert.ok(!result.skipped.includes(indexName));
  });

  it("rejects an HNSW probe that cannot recover a near-zero neighbor", async () => {
    const { provider } = createRecordingProvider();
    const legacyProbe = makeDeterministicVector("legacy-hnsw-probe", 1, 0);
    await withWriteConn(async (conn) => {
      await ladybugDb.exec(
        conn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         SET s.embeddingJinaCodeVec = $legacyProbe`,
        { symbolId: symbols[0].symbolId, legacyProbe },
      );
      await createVectorIndex(
        conn,
        "Symbol",
        "embeddingJinaCodeVec",
        "symbol_vec_jina_code_v2",
        768,
      );
    });
    await refreshSymbolEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      symbols,
      embeddingProvider: provider,
    });

    const conn = await getLadybugConn();
    const stored = await readSafeRebuildJinaVectorProbe(conn);
    assert.ok(Array.isArray(stored));
    assert.ok(
      (await queryVectorIndexProbe(
        conn,
        "symbol_vec_jina_code_v2",
        stored,
      )) > 0,
    );

    const unrelated = new Array<number>(768).fill(0);
    unrelated[767] = 1;
    await assert.rejects(
      queryVectorIndexProbe(
        conn,
        "symbol_vec_jina_code_v2",
        unrelated,
      ),
      /near-zero/i,
    );
  });

  it("isolates symbol vector health and ANN coverage by repository and model", async () => {
    const conn = await getLadybugConn();
    const otherRepoId = "embed-test-other-repo";
    const otherSymbolId = "sym-other";
    const nomicModel = "nomic-embed-text-v1.5";
    const jinaVector = makeDeterministicVector("repo-one-jina", 1, 0);
    const nomicVector = makeDeterministicVector("repo-one-nomic", 2, 0);
    const otherJinaVector = makeDeterministicVector("repo-two-jina", 3, 0);
    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId: otherRepoId,
      rootPath: "/fake/embed-other-repo",
      configJson: "{}",
      createdAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "other-file",
      repoId: otherRepoId,
      relPath: "src/other.ts",
      contentHash: "other-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertSymbol(conn, {
      ...symbols[0],
      symbolId: otherSymbolId,
      repoId: otherRepoId,
      fileId: "other-file",
      name: "otherSymbol",
      searchText: "other symbol",
      updatedAt: now,
    });
    await ladybugDb.exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId}), (r:Repo {repoId: $otherRepoId})
       CREATE (s)-[:SYMBOL_IN_REPO]->(r)`,
      { symbolId: symbols[0].symbolId, otherRepoId },
    );
    await ladybugDb.exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId}), (f:File {fileId: $otherFileId})
       CREATE (s)-[:SYMBOL_IN_FILE]->(f)`,
      { symbolId: symbols[0].symbolId, otherFileId: "other-file" },
    );
    await ladybugDb.exec(
      conn,
      `MATCH (s:Symbol)
       WHERE s.repoId = $repoId
       SET s.searchText = s.name`,
      { repoId },
    );
    await withWriteConn(async (writeConn) => {
      await ladybugDb.setSymbolVectorEmbedding(
        writeConn,
        repoId,
        symbols[0].symbolId,
        jinaModel,
        "repo-one-jina",
        "repo-one-jina-hash",
        jinaVector,
      );
      await ladybugDb.setSymbolVectorEmbedding(
        writeConn,
        repoId,
        symbols[1].symbolId,
        nomicModel,
        "repo-one-nomic",
        "repo-one-nomic-hash",
        nomicVector,
      );
      await ladybugDb.setSymbolVectorEmbedding(
        writeConn,
        otherRepoId,
        otherSymbolId,
        jinaModel,
        "repo-two-jina",
        "repo-two-jina-hash",
        otherJinaVector,
      );
      assert.strictEqual(
        await createFtsIndex(writeConn, "Symbol", "symbol_search_text_v1"),
        true,
      );
      assert.strictEqual(
        await createVectorIndex(
          writeConn,
          "SymbolVectorEmbedding",
          "embeddingJinaCodeVec",
          "symbol_vec_jina_code_v2",
          768,
        ),
        true,
      );
      assert.strictEqual(
        await createVectorIndex(
          writeConn,
          "SymbolVectorEmbedding",
          "embeddingNomicVec",
          "symbol_vec_nomic_embed_v15",
          768,
        ),
        true,
      );
      assert.strictEqual(
        await createVectorIndex(
          writeConn,
          "FileSummary",
          FILESUMMARY_EMBEDDING_PROPERTIES.nomic.property,
          FILESUMMARY_VECTOR_INDEX_NAMES.nomic,
          768,
        ),
        true,
      );
      assert.strictEqual(
        await createVectorIndex(
          writeConn,
          "AgentFeedback",
          AGENTFEEDBACK_EMBEDDING_PROPERTIES.jinaCode.property,
          AGENTFEEDBACK_VECTOR_INDEX_NAMES.jinaCode,
          768,
        ),
        true,
      );
    });

    assert.deepStrictEqual(
      await getSymbolRetrievalCoverage(conn, repoId, "embeddingJinaCodeVec"),
      { eligible: 3, covered: 1 },
    );
    assert.deepStrictEqual(
      await getSymbolRetrievalCoverage(conn, repoId, "embeddingNomicVec"),
      { eligible: 3, covered: 1 },
    );
    assert.deepStrictEqual(
      await getSymbolRetrievalCoverage(
        conn,
        otherRepoId,
        "embeddingJinaCodeVec",
      ),
      { eligible: 2, covered: 2 },
    );
    assert.deepStrictEqual(
      await getSymbolRetrievalCoverage(conn, otherRepoId, "embeddingNomicVec"),
      { eligible: 2, covered: 0 },
    );

    const health = await checkRetrievalHealth(conn, repoId, {
      embeddingProfile: "specialized",
      symbolEmbeddingModels: [jinaModel, nomicModel],
      fileSummaryEmbeddingModels: [],
    });
    assert.strictEqual(health.vectorJinaCode, true);
    assert.strictEqual(health.vectorNomic, true);
    assert.strictEqual(health.modelCoveragePermille?.symbol[jinaModel], 333);
    assert.strictEqual(health.modelCoveragePermille?.symbol[nomicModel], 333);
    assert.ok(
      (await queryVectorIndexProbe(
        conn,
        "symbol_vec_jina_code_v2",
        jinaVector,
      )) > 0,
    );
    assert.ok(
      (await queryVectorIndexProbe(
        conn,
        "symbol_vec_nomic_embed_v15",
        nomicVector,
      )) > 0,
    );

    const indexes = await showIndexesStrict(conn);
    assert.ok(
      indexes.some(
        ({ tableName, name, type }) =>
          tableName === "Symbol" &&
          name === "symbol_search_text_v1" &&
          type === "fts",
      ),
    );
    assert.ok(
      !indexes.some(
        ({ tableName, type }) => tableName === "Symbol" && type === "vector",
      ),
    );
    assert.ok(
      indexes.some(
        ({ tableName, name, property, type }) =>
          tableName === "FileSummary" &&
          name === FILESUMMARY_VECTOR_INDEX_NAMES.nomic &&
          property === FILESUMMARY_EMBEDDING_PROPERTIES.nomic.property &&
          type === "vector",
      ),
    );
    assert.ok(
      indexes.some(
        ({ tableName, name, property, type }) =>
          tableName === "AgentFeedback" &&
          name === AGENTFEEDBACK_VECTOR_INDEX_NAMES.jinaCode &&
          property === AGENTFEEDBACK_EMBEDDING_PROPERTIES.jinaCode.property &&
          type === "vector",
      ),
    );
  });

  it("keeps Symbol ANN retrieval and shared-symbol file narrowing inside the requested repository", async () => {
    const conn = await getLadybugConn();
    const otherRepoId = "embed-test-vector-scope-other";
    const otherFileId = "vector-scope-other-file";
    const query = "repository scoped vector search";
    const queryVector = [1, ...new Array<number>(767).fill(0)];
    const localVector = [0, 1, ...new Array<number>(766).fill(0)];
    const now = new Date().toISOString();
    const foreignSymbols = Array.from({ length: 325 }, (_, index) => ({
      ...symbols[0],
      symbolId: `foreign-vector-${String(index).padStart(3, "0")}`,
      repoId: otherRepoId,
      fileId: otherFileId,
      name: `foreignVector${index}`,
      searchText: `foreign vector ${index}`,
      updatedAt: now,
    }));

    await ladybugDb.upsertRepo(conn, {
      repoId: otherRepoId,
      rootPath: "/fake/embed-vector-scope-other",
      configJson: "{}",
      createdAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: otherFileId,
      repoId: otherRepoId,
      relPath: "src/foreign.ts",
      contentHash: "foreign-vector-hash",
      language: "ts",
      byteSize: 10,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertSymbolBatch(conn, foreignSymbols);
    await ladybugDb.createVersion(conn, {
      versionId: `${repoId}:vector-scope-v1`,
      repoId,
      createdAt: now,
      reason: "vector scope test",
      prevVersionHash: null,
      versionHash: null,
    });
    await ladybugDb.replaceGraphIntegrityManifestInTransaction(conn, repoId, {
      files: [],
      fileless: [],
    });
    await beginGraphIntegrityVersion(
      conn,
      repoId,
      `${repoId}:vector-scope-v1`,
      "vector-scope-digest",
      true,
    );

    await withWriteConn(async (writeConn) => {
      await ladybugDb.setSymbolVectorEmbedding(
        writeConn,
        repoId,
        symbols[0].symbolId,
        jinaModel,
        "local-vector",
        "local-vector-hash",
        localVector,
      );
      await ladybugDb.setSymbolVectorEmbeddingBatch(
        writeConn,
        otherRepoId,
        jinaModel,
        foreignSymbols.map(({ symbolId }) => ({
          symbolId,
          vector: `foreign-${symbolId}`,
          cardHash: `foreign-${symbolId}-hash`,
          vectorArray: queryVector,
        })),
      );
      assert.equal(
        await createVectorIndex(
          writeConn,
          "SymbolVectorEmbedding",
          "embeddingJinaCodeVec",
          "symbol_vec_jina_code_v2",
          768,
        ),
        true,
      );
      await ladybugDb.exec(
        writeConn,
        `MATCH (s:Symbol {symbolId: $symbolId}),
               (r:Repo {repoId: $otherRepoId}),
               (f:File {fileId: $otherFileId})
         MERGE (s)-[:SYMBOL_IN_REPO]->(r)
         MERGE (s)-[:SYMBOL_IN_FILE]->(f)
         SET s.repoId = $otherRepoId`,
        {
          symbolId: symbols[0].symbolId,
          otherRepoId,
          otherFileId,
        },
      );
    });

    const prefixedQuery = applyQueryPrefix(jinaModel, query);
    const queryContext = createRetrievalQueryContext({
      connection: conn,
      embeddingPromises: new Map([
        [`${jinaModel}\u0000${prefixedQuery}`, Promise.resolve(queryVector)],
      ]),
    });
    queryContext.healthPromises.set(
      repoId,
      Promise.resolve({
        fts: false,
        fileSummaryFts: false,
        vectorNomic: false,
        vectorJinaCode: true,
        vectorByEntityModel: {
          symbol: {
            [jinaModel]: true,
            "nomic-embed-text-v1.5": false,
          },
          fileSummary: { "nomic-embed-text-v1.5": false },
        },
        coveragePermille: { symbolVector: 1000, fileSummaryVector: 0 },
      }),
    );

    const result = await hybridSearch(
      {
        repoId,
        query,
        limit: 10,
        ftsEnabled: false,
        vectorEnabled: true,
      },
      queryContext,
    );
    assert.deepEqual(
      result.results.map(({ symbolId }) => symbolId),
      [symbols[0].symbolId],
    );

    const narrowed = await narrowFilesForQuery(
      { repoId, query, limit: 10, includeEvidence: false },
      queryContext,
    );
    assert.deepEqual(narrowed.paths, ["src/auth.ts"]);
  });

  it("refreshFileSummaryEmbeddings marks mock fallback as degraded without persistence", async () => {
    const conn = await getLadybugConn();
    const now = new Date().toISOString();
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary: "File: src/auth.ts\nLanguage: ts\nExports: authenticateUser",
        searchText: "file: src/auth.ts exports: authenticateUser",
        updatedAt: now,
      },
      {
        fileId: "file2",
        repoId,
        summary:
          "File: src/dashboard.ts\nLanguage: ts\nExports: renderDashboard",
        searchText: "file: src/dashboard.ts exports: renderDashboard",
        updatedAt: now,
      },
    ]);

    const result = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "mock",
      model: "jina-embeddings-v2-base-code",
      fileIds: ["file1", "file2"],
    });

    assert.deepStrictEqual(result, {
      embedded: 0,
      skipped: 0,
      missing: 2,
      degraded: true,
    });

    const summaries = await ladybugDb.getFileSummariesByFileIds(conn, [
      "file1",
      "file2",
    ]);
    for (const summary of summaries.values()) {
      assert.strictEqual(summary.embeddingJinaCode, null);
      assert.strictEqual(summary.embeddingJinaCodeCardHash, null);
    }
  });

  it("marks a mid-refresh FileSummary mock fallback as degraded", async () => {
    const conn = await getLadybugConn();
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary: "File: src/auth.ts\nLanguage: ts\nExports: authenticateUser",
        searchText: "file: src/auth.ts exports: authenticateUser",
        updatedAt: new Date().toISOString(),
      },
    ]);
    let mockFallback = false;
    const embeddingProvider: EmbeddingProvider = {
      async embed(texts): Promise<number[][]> {
        mockFallback = true;
        return texts.map(() => new Array<number>(64).fill(0));
      },
      getDimension(): number {
        return 768;
      },
      isMockFallback(): boolean {
        return mockFallback;
      },
    };

    const result = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: "nomic-embed-text-v1.5",
      fileIds: ["file1"],
      rebuildMinUncachedRows: 1,
      embeddingProvider,
    });

    assert.deepStrictEqual(result, {
      embedded: 0,
      skipped: 0,
      missing: 1,
      degraded: true,
    });
  });

  it("refreshFileSummaryEmbeddings degrades unknown models without persistence", async () => {
    const conn = await getLadybugConn();
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary: "File: src/auth.ts\nLanguage: ts\nExports: authenticateUser",
        searchText: "file: src/auth.ts exports: authenticateUser",
        updatedAt: new Date().toISOString(),
      },
    ]);

    const result = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "mock",
      model: "unknown-embedding-model",
      fileIds: ["file1"],
    });

    assert.deepStrictEqual(result, {
      embedded: 0,
      skipped: 0,
      missing: 1,
      degraded: true,
    });

    const summaries = await ladybugDb.getFileSummariesByFileIds(conn, [
      "file1",
    ]);
    assert.strictEqual(summaries.get("file1")?.embeddingJinaCode, null);
    assert.strictEqual(summaries.get("file1")?.embeddingNomic, null);
  });

  it("refreshFileSummaryEmbeddings scopes incremental runs and only re-embeds changed payloads", async () => {
    const conn = await getLadybugConn();
    await upsertStandardFileSummaries(conn);
    const { provider, calls } = createRecordingProvider();

    const first = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file1"],
      embeddingProvider: provider,
      rebuildMinUncachedRows: 1,
    });

    assert.deepStrictEqual(first, {
      embedded: 1,
      skipped: 0,
      missing: 0,
      degraded: false,
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].length, 1);
    assert.match(calls[0][0], /authenticateUser/);

    let rows = await readFileSummaryEmbeddingRows(conn, ["file1", "file2"]);
    const originalFile1 = rows.get("file1");
    assert.ok(originalFile1?.vector);
    assert.strictEqual(
      rows.get("file2")?.vector,
      null,
      "unrequested FileSummary should not be embedded",
    );

    const second = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file1"],
      embeddingProvider: provider,
    });

    assert.deepStrictEqual(second, {
      embedded: 0,
      skipped: 1,
      missing: 0,
      degraded: false,
      deferred: 1,
    });
    assert.strictEqual(
      calls.length,
      1,
      "cached FileSummary payload should not call the provider again",
    );

    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary:
          "File: src/auth.ts\nLanguage: ts\nExports: authenticateUser\nChanged payload",
        searchText:
          "file: src/auth.ts exports: authenticateUser summary: Changed payload",
        updatedAt: "2026-05-05T00:01:00Z",
      },
    ]);

    const third = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file1"],
      embeddingProvider: provider,
      rebuildMinUncachedRows: 1,
    });

    assert.deepStrictEqual(third, {
      embedded: 1,
      skipped: 0,
      missing: 0,
      degraded: false,
    });
    assert.strictEqual(calls.length, 2);
    assert.match(calls[1][0], /Changed payload/);

    rows = await readFileSummaryEmbeddingRows(conn, ["file1", "file2"]);
    assert.notStrictEqual(rows.get("file1")?.cardHash, originalFile1.cardHash);
    assert.strictEqual(
      rows.get("file2")?.vector,
      null,
      "payload changes outside the requested set should remain untouched",
    );
  });

  it("refreshFileSummaryEmbeddings accumulates deferred rows across incremental scopes", async () => {
    const conn = await getLadybugConn();
    await upsertStandardFileSummaries(conn);
    const { provider, calls } = createRecordingProvider();

    const first = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file1"],
      embeddingProvider: provider,
      rebuildMinUncachedRows: 3,
    });

    assert.deepStrictEqual(first, {
      embedded: 0,
      skipped: 0,
      missing: 0,
      degraded: false,
      deferred: 2,
    });
    assert.strictEqual(calls.length, 0);

    await ladybugDb.upsertFile(conn, {
      fileId: "file3",
      repoId,
      relPath: "src/settings.ts",
      contentHash: "hash3",
      language: "ts",
      byteSize: 300,
      lastIndexedAt: "2026-05-05T00:01:00Z",
    });
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file3",
        repoId,
        summary: "File: src/settings.ts\nLanguage: ts\nExports: loadSettings",
        searchText: "file: src/settings.ts exports: loadSettings",
        updatedAt: "2026-05-05T00:01:00Z",
      },
    ]);

    const second = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file3"],
      embeddingProvider: provider,
      rebuildMinUncachedRows: 3,
    });

    assert.deepStrictEqual(second, {
      embedded: 3,
      skipped: 0,
      missing: 0,
      degraded: false,
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].length, 3);

    const rows = await readFileSummaryEmbeddingRows(conn, [
      "file1",
      "file2",
      "file3",
    ]);
    for (const fileId of ["file1", "file2", "file3"]) {
      assertStoredVectorArray(rows.get(fileId)?.vectorArray, fileId);
    }
  });

  it("refreshFileSummaryEmbeddings reports empty payloads as missing instead of cached", async () => {
    const conn = await getLadybugConn();
    await ladybugDb.upsertFileSummaryBatch(conn, [
      {
        fileId: "file1",
        repoId,
        summary: null,
        searchText: "   ",
        updatedAt: "2026-05-05T00:00:00Z",
      },
    ]);
    const { provider, calls } = createRecordingProvider();

    for (const model of [jinaModel, "nomic-embed-text-v1.5"]) {
      const result = await refreshFileSummaryEmbeddings({
        repoId,
        provider: "local",
        model,
        fileIds: ["file1"],
        embeddingProvider: provider,
      });

      assert.deepStrictEqual(
        result,
        {
          embedded: 0,
          skipped: 0,
          missing: 1,
          degraded: false,
        },
        `${model} should treat empty raw payloads as missing`,
      );
    }
    assert.strictEqual(calls.length, 0);
  });

  it("refreshFileSummaryEmbeddings preserves metadata and vector arrays on rebuild writes", async () => {
    const events: PostIndexSessionTapEvent[] = [];
    installObservabilityTap(new Proxy({} as ObservabilityTap, {
      get: (_target, property) => property === "postIndexSession"
        ? (event: PostIndexSessionTapEvent) => events.push(event)
        : () => {},
    }));
    const conn = await getLadybugConn();
    const summaryUpdatedAt = "2026-05-05T00:00:00Z";
    await upsertStandardFileSummaries(conn, summaryUpdatedAt);
    const { provider } = createRecordingProvider();

    const result = await refreshFileSummaryEmbeddings({
      repoId,
      provider: "local",
      model: jinaModel,
      fileIds: ["file1", "file2"],
      embeddingProvider: provider,
      batchSize: 1,
      rebuildMinUncachedRows: 1,
    });

    assert.deepStrictEqual(result, {
      embedded: 2,
      skipped: 0,
      missing: 0,
      degraded: false,
    });
    assert.deepEqual(events.map(({ repoId }) => repoId), [repoId]);

    const rows = await readFileSummaryEmbeddingRows(conn, ["file1", "file2"]);
    for (const fileId of ["file1", "file2"]) {
      const row = rows.get(fileId);
      assert.ok(row, `${fileId} summary should exist`);
      assert.ok(row.vector, `${fileId} should store text vector metadata`);
      assert.ok(row.cardHash, `${fileId} should store a card hash`);
      assert.ok(
        row.embeddingUpdatedAt,
        `${fileId} should store embedding update metadata`,
      );
      assert.strictEqual(row.summaryUpdatedAt, summaryUpdatedAt);
      assert.match(row.summary ?? "", /File: src\//);
      assert.match(row.searchText ?? "", /file: src\//);
      assertStoredVectorArray(row.vectorArray, fileId);
    }
  });
});
