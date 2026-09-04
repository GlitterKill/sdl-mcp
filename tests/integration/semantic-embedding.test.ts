import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { SemanticConfigSchema } from "../../dist/config/types.js";
import {
  getRepoSymbolVectorEmbedding,
  getRepoSymbolVectorEmbeddings,
  resolveSymbolVectorPhysicalIdentity,
  setRepoSymbolVectorEmbedding,
  setRepoSymbolVectorEmbeddingBatch,
} from "../../dist/db/ladybug-symbol-embeddings.js";
import { withExclusiveLadybugOperation } from "../../dist/db/ladybug-operation-gate.js";
import { indexRepo as runIndexRepo } from "../../dist/indexer/indexer.js";

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
import { finalizeDerivedState } from "../../dist/indexer/finalize-derived-state.js";

import {
  AGENTFEEDBACK_EMBEDDING_PROPERTIES,
  AGENTFEEDBACK_VECTOR_INDEX_NAMES,
  createFtsIndex,
  createVectorIndex,
  dropVectorIndex,
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
import {
  beginGraphIntegrityVersion,
  getDerivedState,
} from "../../dist/db/ladybug-derived-state.js";
import {
  assessRepositorySymbolVectorHealth,
  clearRepositorySymbolVectorHealth,
  getRepositorySymbolVectorHealthGeneration,
  getRepositorySymbolVectorHealthSnapshots,
  invalidateRepositorySymbolVectorHealth,
  publishRepositorySymbolVectorHealthBatch,
  resolveRequiredRetrievalIndexes,
  type SymbolVectorHealthSnapshot,
} from "../../dist/retrieval/health.js";
import { getSymbolRetrievalCoverage } from "../../dist/db/ladybug-retrieval-health.js";
import {
  installObservabilityTap,
  resetObservabilityTap,
  type ObservabilityTap,
  type PostIndexSessionTapEvent,
} from "../../dist/observability/event-tap.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function queryFromPublishedVectorHealth<T>(
  snapshot: SymbolVectorHealthSnapshot | null | undefined,
  lanes: {
    exact: () => Promise<T[]>;
    ann: () => Promise<T[]>;
  },
): Promise<T[]> {
  if (snapshot?.mode === "hnsw") return lanes.ann();
  if (snapshot?.mode === "exact" || snapshot?.exactFallbackAllowed === true) {
    return lanes.exact();
  }
  return [];
}

describe("Semantic Embedding Pipeline", () => {
  const testDir = join(__dirname, "test-semantic-embedding");
  const graphDbPath = join(testDir, "graph");
  const repoId = "embed-test-repo";
  const jinaModel = "jina-embeddings-v2-base-code";
  const replacementRaceRepoId = "semantic-replacement-race";
  const previousConfig = process.env.SDL_CONFIG;
  const previousConfigPath = process.env.SDL_CONFIG_PATH;

  function vectorIdentity(targetRepoId = repoId, model = jinaModel) {
    return resolveSymbolVectorPhysicalIdentity(targetRepoId, model);
  }

  // Repository table creation and vector DML share one exclusive admission boundary.
  async function withExclusiveVectorWrite<T>(
    body: (
      conn: Awaited<ReturnType<typeof getLadybugConn>>,
    ) => Promise<T>,
  ): Promise<T> {
    return withExclusiveLadybugOperation(() => withWriteConn(body));
  }

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
      searchText: "authenticate user username password credentials",
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
      searchText: "fetch user profile data database",
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
      searchText: "render main dashboard UI component",
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
    clearRepositorySymbolVectorHealth(replacementRaceRepoId);
    clearRepositorySymbolVectorHealth(repoId);
    invalidateConfigCache();
    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = previousConfigPath;
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

  function makeBoundarySymbols(count: number): ladybugDb.SymbolRow[] {
    return Array.from({ length: count }, (_, index) => ({
      ...symbols[0],
      symbolId: `sym-boundary-${index}`,
      name: `boundarySymbol${index}`,
      rangeStartLine: 100 + index * 2,
      rangeEndLine: 101 + index * 2,
      astFingerprint: `fp-boundary-${index}`,
      signatureJson: JSON.stringify(`(value${index}: string) => string`),
      summary: `Boundary lifecycle symbol ${index}`,
    }));
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
      `MATCH (e:${vectorIdentity().tableName}) RETURN count(e) AS count`,
    );
    return ladybugDb.toNumber(row?.count ?? 0);
  }

  async function queryJinaNeighbor(
    conn: Awaited<ReturnType<typeof getLadybugConn>>,
    vector: number[],
  ): Promise<{ symbolId: string; distance: number }> {
    const identity = vectorIdentity();
    const rows = await queryStoredProcAll<{
      symbolId: string;
      distance: number;
    }>(
      conn,
      `CALL QUERY_VECTOR_INDEX('${identity.tableName}', '${identity.indexName}', ${JSON.stringify(vector)}, 1, efs := 200) RETURN node.symbolId AS symbolId, distance`,
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
    const identity = vectorIdentity();

    await withExclusiveVectorWrite(async (conn) => {
      for (const symbol of allSymbols) {
        const jinaVector = jinaVectors.get(symbol.symbolId)!;
        await setRepoSymbolVectorEmbedding(
          conn,
          repoId,
          symbol.symbolId,
          jinaModel,
          `${symbol.symbolId}-jina`,
          `${symbol.symbolId}-jina-hash`,
          jinaVector,
        );
        await setRepoSymbolVectorEmbedding(
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
        identity.tableName,
        identity.propertyName,
        identity.indexName,
        768,
      );
    });

    return jinaVectors.get(preservedSymbol.symbolId)!;
  }

  async function assertGraphDeletionLeavesVectorsUntouched(
    deletedSymbolIds: string[],
    preservedSymbolId: string,
    preservedJinaVector: number[],
  ): Promise<void> {
    const conn = await getLadybugConn();
    const identity = vectorIdentity();
    const rows = await ladybugDb.queryAll<{
      symbolId: string;
      model: string;
    }>(
      conn,
      `MATCH (e:${identity.tableName})
       RETURN e.symbolId AS symbolId, e.model AS model
       ORDER BY e.symbolId, e.model`,
    );
    for (const symbolId of deletedSymbolIds) {
      assert.deepStrictEqual(
        rows.filter((row) => row.symbolId === symbolId),
        [
          { symbolId, model: jinaModel },
          { symbolId, model: "nomic-embed-text-v1.5" },
        ],
        "structural graph deletion must not mutate semantic vector storage",
      );
    }
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
          tableName === identity.tableName && name === identity.indexName,
      ),
    );
    const neighbor = await queryJinaNeighbor(conn, preservedJinaVector);
    assert.strictEqual(neighbor.symbolId, preservedSymbolId);
    assert.ok(Math.abs(neighbor.distance) <= 1e-6);
  }

  it("deleteSymbolsByFileId leaves vector rows and live HNSW untouched", async () => {
    const preservedVector = await seedDeletionVectors(
      [symbols[0], symbols[1]],
      symbols[2],
    );

    await withWriteConn((conn) =>
      ladybugDb.deleteSymbolsByFileId(conn, "file1"),
    );

    await assertGraphDeletionLeavesVectorsUntouched(
      [symbols[0].symbolId, symbols[1].symbolId],
      symbols[2].symbolId,
      preservedVector,
    );
  });

  it("deleteSymbolsByFileIds leaves vector rows and live HNSW untouched", async () => {
    const preservedVector = await seedDeletionVectors(
      [symbols[0], symbols[1]],
      symbols[2],
    );

    await withWriteConn((conn) =>
      ladybugDb.deleteSymbolsByFileIds(conn, ["file1"]),
    );

    await assertGraphDeletionLeavesVectorsUntouched(
      [symbols[0].symbolId, symbols[1].symbolId],
      symbols[2].symbolId,
      preservedVector,
    );
  });

  it("deleteFilesByIds leaves vector rows and live HNSW untouched", async () => {
    const preservedVector = await seedDeletionVectors(
      [symbols[0], symbols[1]],
      symbols[2],
    );

    await withWriteConn((conn) => ladybugDb.deleteFilesByIds(conn, ["file1"]));

    await assertGraphDeletionLeavesVectorsUntouched(
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
    it(`${name} preserves foreign graph ownership without rewriting stale vector ownership`, async () => {
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
      await withExclusiveVectorWrite((writeConn) =>
        setRepoSymbolVectorEmbedding(
          writeConn,
          repoId,
          sharedSymbolId,
          jinaModel,
          "shared-vector",
          "shared-vector-hash",
          makeDeterministicVector("shared-vector", 30, 0),
        ),
      );

      await withWriteConn(deleteTarget);

      const ownership = await ladybugDb.querySingle<{
        repoId: string;
        embeddingRepoId: string;
      }>(
        conn,
        `MATCH (s:Symbol {symbolId: $symbolId})
         MATCH (e:${vectorIdentity().tableName} {symbolId: $symbolId})
         RETURN s.repoId AS repoId, e.repoId AS embeddingRepoId`,
        { symbolId: sharedSymbolId },
      );
      assert.deepStrictEqual(ownership, {
        repoId: otherRepoId,
        embeddingRepoId: repoId,
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

  it("deleteSymbolsByIds leaves vector rows and live HNSW untouched", async () => {
    const preservedVector = await seedDeletionVectors([symbols[0]], symbols[1]);

    await withWriteConn((conn) =>
      ladybugDb.deleteSymbolsByIds(conn, [symbols[0].symbolId]),
    );

    await assertGraphDeletionLeavesVectorsUntouched(
      [symbols[0].symbolId],
      symbols[1].symbolId,
      preservedVector,
    );
  });

  it("graph finalization preserves semantic dirty and refreshing lifecycle", async () => {
    const versionId = "semantic-graph-finalization-v1";
    await withWriteConn((conn) =>
      ladybugDb.exec(
        conn,
        `MERGE (d:DerivedState {repoId: $repoId})
         SET d.clustersDirty = true,
             d.processesDirty = true,
             d.algorithmsDirty = true,
             d.summariesDirty = true,
             d.embeddingsDirty = true,
             d.embeddingLifecycleState = 'refreshing',
             d.targetVersionId = $versionId`,
        { repoId, versionId },
      ),
    );

    await finalizeDerivedState({
      mode: "incremental",
      conn: await getLadybugConn(),
      repoId,
      versionId,
      filesTotal: 2,
      phaseTimings: null,
      measurePhase: async (_phaseName, operation) => operation(),
    });

    const finalized = await getDerivedState(repoId);
    assert.equal(finalized?.embeddingsDirty, true);
    assert.equal(finalized?.embeddingLifecycleState, "refreshing");
  });

  it("keeps stale vectors non-queryable after an incremental Symbol replacement commits", async () => {
    const raceRepoDir = join(testDir, "replacement-race-repo");
    const raceConfigPath = join(testDir, "replacement-race-config.json");
    const sourcePath = join(raceRepoDir, "src", "replacement.ts");
    mkdirSync(join(raceRepoDir, "src"), { recursive: true });
    writeFileSync(
      sourcePath,
      "export function beforeChange() { return 1; }\n",
      "utf8",
    );

    const semanticConfig = SemanticConfigSchema.parse({
      enabled: true,
      provider: "mock",
      generateSummaries: false,
      embeddingProfile: "specialized",
      symbolEmbeddingModels: [jinaModel],
      fileSummaryEmbeddingModels: [],
      retrieval: {
        fts: { enabled: false },
        vector: { enabled: true },
      },
    });
    const writeRaceConfig = (semanticEnabled: boolean): void => {
      writeFileSync(
        raceConfigPath,
        JSON.stringify({
          repos: [],
          policy: {},
          indexing: {
            pipeline: "legacy",
            engine: "typescript",
            enableFileWatching: false,
          },
          semantic: semanticEnabled
            ? semanticConfig
            : { enabled: false, generateSummaries: false },
          scip: {
            enabled: false,
            indexes: [],
            generator: { enabled: false },
          },
        }),
        "utf8",
      );
      process.env.SDL_CONFIG = raceConfigPath;
      delete process.env.SDL_CONFIG_PATH;
      invalidateConfigCache();
    };

    writeRaceConfig(false);
    await withWriteConn((conn) =>
      ladybugDb.upsertRepo(conn, {
        repoId: replacementRaceRepoId,
        rootPath: raceRepoDir,
        configJson: JSON.stringify({
          repoId: replacementRaceRepoId,
          rootPath: raceRepoDir,
          ignore: [],
          languages: ["ts"],
          maxFileBytes: 2_000_000,
          includeNodeModulesTypes: true,
        }),
        createdAt: "2026-09-04T00:00:00.000Z",
      }),
    );
    const baseline = await runIndexRepo(
      replacementRaceRepoId,
      "full",
      undefined,
      undefined,
      { isolatedRebuild: true },
    );
    const baselineConn = await getLadybugConn();
    const baselineSymbols = await ladybugDb.getSymbolsByRepo(
      baselineConn,
      replacementRaceRepoId,
    );
    const oldSymbol = baselineSymbols.find(
      (symbol) => symbol.name === "beforeChange",
    );
    assert.ok(oldSymbol, "baseline index must contain the old Symbol identity");

    await withExclusiveLadybugOperation(() =>
      withWriteConn(async (conn) => {
        for (const [index, symbol] of baselineSymbols.entries()) {
          await setRepoSymbolVectorEmbedding(
            conn,
            replacementRaceRepoId,
            symbol.symbolId,
            jinaModel,
            `seed-vector-${index}`,
            `seed-card-${index}`,
            makeDeterministicVector(symbol.symbolId, 40, index),
          );
        }
      }),
    );
    await withWriteConn((conn) =>
      ladybugDb.exec(
        conn,
        `MERGE (d:DerivedState {repoId: $repoId})
         SET d.embeddingsDirty = false,
             d.embeddingLifecycleState = 'steady',
             d.computedVersionId = $versionId,
             d.targetVersionId = $versionId`,
        { repoId: replacementRaceRepoId, versionId: baseline.versionId },
      ),
    );

    writeRaceConfig(true);
    const seededGeneration = invalidateRepositorySymbolVectorHealth(
      replacementRaceRepoId,
      baseline.versionId,
      semanticConfig,
      "refreshing",
    );
    const healthySnapshots = await withWriteConn((conn) =>
      assessRepositorySymbolVectorHealth(conn, {
        repoId: replacementRaceRepoId,
        versionId: baseline.versionId,
        generation: seededGeneration,
        lifecycleState: "steady",
        semanticConfig,
      }),
    );
    assert.equal(
      publishRepositorySymbolVectorHealthBatch({
        repoId: replacementRaceRepoId,
        versionId: baseline.versionId,
        capturedGeneration: seededGeneration,
        enabledModels: [jinaModel],
        snapshots: healthySnapshots,
      }),
      true,
    );
    assert.equal(
      getRepositorySymbolVectorHealthSnapshots(replacementRaceRepoId)?.get(
        jinaModel,
      )?.mode,
      "exact",
    );

    writeFileSync(
      sourcePath,
      "export function afterChange() { return 2; }\n",
      "utf8",
    );
    let enterBarrier!: () => void;
    const barrierEntered = new Promise<void>((resolve) => {
      enterBarrier = resolve;
    });
    let releaseBarrier!: () => void;
    const barrierRelease = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const incremental = runIndexRepo(
      replacementRaceRepoId,
      "incremental",
      undefined,
      undefined,
      {
        afterFirstStructuralSymbolWriteCommitted: async () => {
          enterBarrier();
          await barrierRelease;
        },
      },
    ).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );

    await barrierEntered;
    const pausedState = await getDerivedState(replacementRaceRepoId);
    assert.equal(pausedState?.embeddingsDirty, true);
    assert.equal(pausedState?.embeddingLifecycleState, "refreshing");
    assert.equal(
      getRepositorySymbolVectorHealthGeneration(replacementRaceRepoId),
      seededGeneration + 1,
    );
    const pausedSnapshots =
      getRepositorySymbolVectorHealthSnapshots(replacementRaceRepoId);
    assert.deepStrictEqual(pausedSnapshots && [...pausedSnapshots.keys()], [
      jinaModel,
    ]);
    const pausedSnapshot = pausedSnapshots?.get(jinaModel);
    assert.equal(pausedSnapshot?.lifecycleState, "refreshing");
    assert.equal(pausedSnapshot?.mode, "degraded");
    assert.equal(pausedSnapshot?.exactFallbackAllowed, false);

    const pausedConn = await getLadybugConn();
    const pausedSymbols = await ladybugDb.getSymbolsByRepo(
      pausedConn,
      replacementRaceRepoId,
    );
    assert.equal(
      pausedSymbols.some((symbol) => symbol.symbolId === oldSymbol.symbolId),
      false,
      "the replaced Symbol identity must be committed before the pause",
    );
    assert.ok(
      pausedSymbols.some((symbol) => symbol.name === "afterChange"),
      "the replacement Symbol must be committed before the pause",
    );
    const staleVectorRow = await getRepoSymbolVectorEmbedding(
      pausedConn,
      replacementRaceRepoId,
      oldSymbol.symbolId,
      jinaModel,
    );
    assert.ok(
      staleVectorRow,
      "semantic reconciliation, not the structural commit, removes the stale vector",
    );

    let exactQueries = 0;
    let annQueries = 0;
    const concurrentResults = await queryFromPublishedVectorHealth(
      pausedSnapshot,
      {
        exact: async () => {
          exactQueries += 1;
          return [staleVectorRow];
        },
        ann: async () => {
          annQueries += 1;
          return [staleVectorRow];
        },
      },
    );
    assert.deepStrictEqual(concurrentResults, []);
    assert.equal(exactQueries, 0);
    assert.equal(annQueries, 0);

    releaseBarrier();
    const outcome = await incremental;
    if (outcome.error) {
      assert.match(String(outcome.error), /(?:embedding refresh incomplete|semantic final assessment is incomplete)/i);
    }
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

    await withExclusiveVectorWrite(async (writeConn) => {
      await setRepoSymbolVectorEmbeddingBatch(
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
      await setRepoSymbolVectorEmbedding(
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
      `MATCH (e:${vectorIdentity().tableName} {symbolId: $symbolId})
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
      `MATCH (e:${vectorIdentity().tableName} {embeddingId: $embeddingId})
       SET e.embeddingJinaCodeVec = null`,
      { embeddingId: `${jinaModel}:${symbolId}` },
    );

    const complete = await getRepoSymbolVectorEmbeddings(
      conn,
      repoId,
      [symbolId],
      jinaModel,
    );
    assert.strictEqual(
      complete.has(symbolId),
      false,
      "text and hash without the selected numeric vector must be recomputed",
    );
    assert.strictEqual(
      await getRepoSymbolVectorEmbedding(conn, repoId, symbolId, jinaModel),
      null,
    );
  });

  it("single-row writes replace an embedding while its HNSW remains live", async () => {
    const conn = await getLadybugConn();
    const symbolId = symbols[0].symbolId;
    const firstVector = [1, ...new Array<number>(767).fill(0)];
    const replacementVector = [0, 1, ...new Array<number>(766).fill(0)];

    await withExclusiveVectorWrite(async (writeConn) => {
      await setRepoSymbolVectorEmbedding(
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
          vectorIdentity().tableName,
          vectorIdentity().propertyName,
          vectorIdentity().indexName,
          768,
        ),
        true,
      );
      await setRepoSymbolVectorEmbedding(
        writeConn,
        repoId,
        symbolId,
        jinaModel,
        "replacement-vector",
        "replacement-card-hash",
        replacementVector,
      );
    });

    const embedding = await getRepoSymbolVectorEmbedding(
      conn,
      repoId,
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
      `CALL QUERY_VECTOR_INDEX('${vectorIdentity().tableName}', '${vectorIdentity().indexName}', ${JSON.stringify(replacementVector)}, 1, efs := 200) RETURN node.symbolId AS symbolId, distance`,
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
          tableName === vectorIdentity().tableName &&
          name === vectorIdentity().indexName,
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

    await assert.rejects(
      refreshSymbolEmbeddings({
        repoId,
        provider: "local",
        model: "jina-embeddings-v2-base-code",
        symbols,
        embeddingProvider,
        onProgress: ({ current, total }) => progress.push({ current, total }),
      }),
      /provider degraded to mock/i,
    );
    assert.ok(progress.every(({ current, total }) => current < total));
  });

  it("fails the refresh when a replacement insert is rejected", async () => {
    const conn = await getLadybugConn();
    await withExclusiveVectorWrite((writeConn) =>
      setRepoSymbolVectorEmbedding(
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
      /dimension 767 does not match 768/i,
    );
    const preserved = await getRepoSymbolVectorEmbedding(
      conn,
      repoId,
      symbols[0].symbolId,
      jinaModel,
    );
    assert.equal(preserved?.vector, "stale-vector");
    assert.equal(preserved?.cardHash, "stale-card-hash");
  });

  it("startup rejects a configured Symbol HNSW name attached to the wrong property", async () => {
    const semanticConfig = SemanticConfigSchema.parse({
      enabled: true,
      provider: "mock",
      generateSummaries: false,
      embeddingProfile: "specialized",
      symbolEmbeddingModels: [jinaModel],
      fileSummaryEmbeddingModels: [],
      retrieval: {
        fts: { enabled: false },
        vector: { enabled: true },
      },
    });
    const identity = vectorIdentity();
    await withExclusiveVectorWrite(async (conn) => {
      await setRepoSymbolVectorEmbeddingBatch(
        conn,
        repoId,
        jinaModel,
        symbols.map((symbol, index) => ({
          symbolId: symbol.symbolId,
          vector: `jina-vector-${index}`,
          cardHash: `jina-hash-${index}`,
          vectorArray: makeDeterministicVector(symbol.symbolId, 50, index),
        })),
      );
      assert.equal(
        await createVectorIndex(
          conn,
          identity.tableName,
          "embeddingNomicVec",
          identity.indexName,
          768,
        ),
        true,
      );
    });

    const snapshots = await assessRepositorySymbolVectorHealth(
      await getLadybugConn(),
      {
        repoId,
        versionId: "vector-health-v1",
        generation: 1,
        lifecycleState: "steady",
        semanticConfig,
      },
    );
    const snapshot = snapshots.find(({ model }) => model === jinaModel);
    assert.equal(snapshot?.mode, "degraded");
    assert.equal(snapshot?.exactFallbackAllowed, true);
    assert.match(snapshot?.reason ?? "", /index identity is missing or ambiguous/);
    assert.equal(snapshot?.observedIndexIdentity?.tableName, identity.tableName);
    assert.equal(snapshot?.observedIndexIdentity?.property, "embeddingNomicVec");
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

    await withExclusiveVectorWrite(async (writeConn) => {
      await setRepoSymbolVectorEmbedding(
        writeConn,
        repoId,
        symbols[0].symbolId,
        jinaModel,
        "local-vector",
        "local-vector-hash",
        localVector,
      );
      await setRepoSymbolVectorEmbeddingBatch(
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
          vectorIdentity().tableName,
          vectorIdentity().propertyName,
          vectorIdentity().indexName,
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

    const semanticConfig = SemanticConfigSchema.parse({
      enabled: true,
      provider: "mock",
      generateSummaries: false,
      embeddingProfile: "specialized",
      symbolEmbeddingModels: [jinaModel],
      fileSummaryEmbeddingModels: [],
      retrieval: {
        fts: { enabled: false },
        vector: { enabled: true },
      },
    });
    const versionId = `${repoId}:vector-scope-v1`;
    const generation = invalidateRepositorySymbolVectorHealth(
      repoId,
      versionId,
      semanticConfig,
      "refreshing",
    );
    const expectedIndexIdentity = resolveRequiredRetrievalIndexes(
      semanticConfig,
      repoId,
    ).symbolVectors.find(({ model }) => model === jinaModel);
    const observedIndexIdentity = (await showIndexesStrict(conn)).find(
      (index) =>
        index.tableName === expectedIndexIdentity?.tableName &&
        index.name === expectedIndexIdentity.name &&
        index.property === expectedIndexIdentity.property,
    );
    assert.ok(expectedIndexIdentity);
    assert.ok(observedIndexIdentity);
    assert.equal(
      publishRepositorySymbolVectorHealthBatch({
        repoId,
        versionId,
        capturedGeneration: generation,
        enabledModels: [jinaModel],
        snapshots: [
          {
            repoId,
            versionId,
            generation,
            model: jinaModel,
            eligibleSymbolCount: 1,
            completeVectorCount: 1,
            lifecycleState: "steady",
            expectedIndexIdentity,
            observedIndexIdentity,
            mode: "hnsw",
            exactFallbackAllowed: true,
          },
        ],
      }),
      true,
    );

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
