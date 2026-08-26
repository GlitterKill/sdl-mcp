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
  createVectorIndex,
  dropVectorIndex,
  queryVectorIndexProbe,
  showIndexesStrict,
} from "../../dist/retrieval/index-lifecycle.js";
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

  it("bootstraps HNSW once and retains it during incremental refresh", async () => {
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
      incrementalPhases.filter(
        (phaseName) => phaseName === "hnsw.drop" || phaseName === "hnsw.create",
      ),
      [],
      "incremental Symbol writes must retain the live HNSW",
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
