import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-repo-file-test-db.lbug");

interface LadybugConnection {
  query: (q: string) => Promise<{
    hasNext: () => boolean;
    getNext: () => Promise<Record<string, unknown>>;
    getAll: () => Promise<Record<string, unknown>[]>;
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

async function exec(conn: LadybugConnection, q: string): Promise<void> {
  const result = await conn.query(q);
  result.close();
}

async function setupSchema(conn: LadybugConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/ladybug-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("LadybugDB Repo & File Queries", () => {
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

  it(
    "upsertRepo/getRepo round-trip with path normalization",
    { skip: !ladybugAvailable },
    async () => {
      const repoId = "repo-1";
      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:\\tmp\\my-repo",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00Z",
      });

      const repo = await queries.getRepo(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      assert.ok(repo);
      assert.strictEqual(repo.repoId, repoId);
      assert.ok(!repo.rootPath.includes("\\"), "rootPath should be normalized");
    },
  );

  it(
    "listAllRepoIds returns every repository in deterministic order",
    { skip: !ladybugAvailable },
    async () => {
      const { exec: execQuery } = await import(
        "../../dist/db/ladybug-core.js"
      );
      const total = 10_001;
      const batchSize = 1_000;
      for (let offset = 0; offset < total; offset += batchSize) {
        const rows = Array.from(
          { length: Math.min(batchSize, total - offset) },
          (_, index) => ({
            repoId: `repo-${String(offset + index).padStart(5, "0")}`,
          }),
        );
        await execQuery(
          conn as unknown as import("kuzu").Connection,
          `UNWIND $rows AS row
           MERGE (r:Repo {repoId: row.repoId})
           SET r.rootPath = '',
               r.configJson = '{}',
               r.createdAt = '2026-08-20T00:00:00.000Z'`,
          { rows },
        );
      }

      const repoIds = await queries.listAllRepoIds(
        conn as unknown as import("kuzu").Connection,
      );
      assert.strictEqual(repoIds.length, total);
      assert.strictEqual(repoIds[0], "repo-00000");
      assert.strictEqual(repoIds.at(-1), "repo-10000");
    },
  );

  it(
    "upsertFile/getFilesByRepo/getFileByRepoPath",
    { skip: !ladybugAvailable },
    async () => {
      const repoId = "repo-2";
      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:/tmp/repo-2",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-1",
        repoId,
        relPath: "src\\index.ts",
        contentHash: "hash-1",
        language: "ts",
        byteSize: 123,
        lastIndexedAt: null,
      });

      const files = await queries.getFilesByRepo(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0]?.directory, "src");
      assert.ok(
        !files[0]!.relPath.includes("\\"),
        "relPath should be normalized",
      );

      const fileByPath = await queries.getFileByRepoPath(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "src\\index.ts",
      );
      assert.ok(fileByPath);
      assert.strictEqual(fileByPath.fileId, "file-1");
    },
  );

  it(
    "getFilesByDirectory and getFileCount",
    { skip: !ladybugAvailable },
    async () => {
      const repoId = "repo-3";
      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:/tmp/repo-3",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-a",
        repoId,
        relPath: "src/a.ts",
        contentHash: "hash-a",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-b",
        repoId,
        relPath: "src/utils/b.ts",
        contentHash: "hash-b",
        language: "ts",
        byteSize: 2,
        lastIndexedAt: null,
      });
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-c",
        repoId,
        relPath: "README.md",
        contentHash: "hash-c",
        language: "md",
        byteSize: 3,
        lastIndexedAt: null,
      });

      const count = await queries.getFileCount(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      assert.strictEqual(count, 3);

      const srcFiles = await queries.getFilesByDirectory(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "src",
      );
      assert.strictEqual(srcFiles.length, 1);
      assert.strictEqual(srcFiles[0]?.fileId, "file-a");
    },
  );

  it(
    "getFilesByPrefix orders by relative path and file id before limiting",
    { skip: !ladybugAvailable },
    async () => {
      const repoId = "repo-prefix-order";
      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:/tmp/repo-prefix-order",
        configJson: "{}",
        createdAt: "2026-07-15T00:00:00Z",
      });

      for (const [fileId, relPath] of [
        ["file-z", "src/z.ts"],
        ["file-a-2", "src/a.ts"],
        ["file-m", "src/m.ts"],
        ["file-a-1", "src/a.ts"],
        ["file-b", "src/b.ts"],
      ]) {
        await queries.upsertFile(
          conn as unknown as import("kuzu").Connection,
          {
            fileId,
            repoId,
            relPath,
            contentHash: `${fileId}-hash`,
            language: "ts",
            byteSize: 1,
            lastIndexedAt: null,
          },
        );
      }

      const files = await queries.getFilesByPrefix(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "src/",
        3,
      );

      assert.deepStrictEqual(
        files.map(({ fileId, relPath }) => [relPath, fileId]),
        [
          ["src/a.ts", "file-a-1"],
          ["src/a.ts", "file-a-2"],
          ["src/b.ts", "file-b"],
        ],
      );
    },
  );

  it(
    "getFilesByPrefix filters exclusions before limiting",
    { skip: !ladybugAvailable },
    async () => {
      const repoId = "repo-prefix-exclusions";
      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:/tmp/repo-prefix-exclusions",
        configJson: "{}",
        createdAt: "2026-07-28T00:00:00Z",
      });

      const excludedFiles = Array.from({ length: 200 }, (_, index) => {
        const suffix = String(index).padStart(3, "0");
        return {
          fileId: `excluded-${suffix}`,
          repoId,
          relPath: `src/foo/a-${suffix}.ts`,
          contentHash: `excluded-${suffix}-hash`,
          language: "ts",
          byteSize: 1,
          lastIndexedAt: null,
        };
      });
      const visibleFile = {
        fileId: "visible-file",
        repoId,
        relPath: "src/foo/z-visible.ts",
        contentHash: "visible-hash",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      };
      await queries.upsertFileBatch(
        conn as unknown as import("kuzu").Connection,
        [...excludedFiles, visibleFile],
      );

      const withoutExclusions = await queries.getFilesByPrefix(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "src/foo/",
        1,
        [],
      );
      assert.strictEqual(withoutExclusions[0]?.fileId, "excluded-000");

      const withExclusions = await queries.getFilesByPrefix(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "src/foo/",
        1,
        excludedFiles.map(({ fileId }) => fileId),
      );
      assert.deepStrictEqual(
        withExclusions.map(({ fileId, relPath }) => [fileId, relPath]),
        [["visible-file", "src/foo/z-visible.ts"]],
      );
    },
  );

  it(
    "deleteFilesByIds cascades to symbols/edges/metrics",
    { skip: !ladybugAvailable },
    async () => {
      const repoId = "repo-4";
      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:/tmp/repo-4",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-del",
        repoId,
        relPath: "src/del.ts",
        contentHash: "hash-del",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });

      await exec(conn, "CREATE (:Symbol {symbolId: 'sym-del-a'})");
      await exec(conn, "CREATE (:Symbol {symbolId: 'sym-del-b'})");
      await exec(conn, "CREATE (:Metrics {symbolId: 'sym-del-a'})");

      await exec(
        conn,
        "MATCH (r:Repo {repoId: 'repo-4'}), (s:Symbol {symbolId: 'sym-del-a'}) CREATE (s)-[:SYMBOL_IN_REPO]->(r)",
      );
      await exec(
        conn,
        "MATCH (r:Repo {repoId: 'repo-4'}), (s:Symbol {symbolId: 'sym-del-b'}) CREATE (s)-[:SYMBOL_IN_REPO]->(r)",
      );
      await exec(
        conn,
        "MATCH (f:File {fileId: 'file-del'}), (s:Symbol {symbolId: 'sym-del-a'}) CREATE (s)-[:SYMBOL_IN_FILE]->(f)",
      );
      await exec(
        conn,
        "MATCH (f:File {fileId: 'file-del'}), (s:Symbol {symbolId: 'sym-del-b'}) CREATE (s)-[:SYMBOL_IN_FILE]->(f)",
      );
      await exec(
        conn,
        "MATCH (a:Symbol {symbolId: 'sym-del-a'}), (b:Symbol {symbolId: 'sym-del-b'}) CREATE (a)-[:DEPENDS_ON]->(b)",
      );

      await queries.deleteFilesByIds(
        conn as unknown as import("kuzu").Connection,
        ["file-del"],
      );

      const file = await queries.getFileByRepoPath(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "src/del.ts",
      );
      assert.strictEqual(file, null);

      const symCount = await conn.query(
        "MATCH (s:Symbol) WHERE s.symbolId IN ['sym-del-a','sym-del-b'] RETURN count(s) AS c",
      );
      try {
        const row = await symCount.getNext();
        assert.strictEqual(Number(row.c ?? 0), 0);
      } finally {
        symCount.close();
      }

      const metricsCount = await conn.query(
        "MATCH (m:Metrics {symbolId: 'sym-del-a'}) RETURN count(m) AS c",
      );
      try {
        const row = await metricsCount.getNext();
        assert.strictEqual(Number(row.c ?? 0), 0);
      } finally {
        metricsCount.close();
      }

      const edgeCount = await conn.query(
        "MATCH ()-[d:DEPENDS_ON]->() RETURN count(d) AS c",
      );
      try {
        const row = await edgeCount.getNext();
        assert.strictEqual(Number(row.c ?? 0), 0);
      } finally {
        edgeCount.close();
      }
    },
  );

  it("deleteRepo cascades to files", { skip: !ladybugAvailable }, async () => {
    const repoId = "repo-5";
    await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
      repoId,
      rootPath: "C:/tmp/repo-5",
      configJson: "{}",
      createdAt: "2026-03-04T00:00:00Z",
    });

    await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
      fileId: "file-x",
      repoId,
      relPath: "x.ts",
      contentHash: "hash-x",
      language: "ts",
      byteSize: 1,
      lastIndexedAt: null,
    });

    await queries.deleteRepo(
      conn as unknown as import("kuzu").Connection,
      repoId,
    );

    const repo = await queries.getRepo(
      conn as unknown as import("kuzu").Connection,
      repoId,
    );
    assert.strictEqual(repo, null);
  });
});


describe("repository vector teardown orchestration", () => {
  const repoId = "delete-repo";
  const semantic = {
    enabled: true,
    symbolEmbeddingModels: [
      "jina-embeddings-v2-base-code",
      "nomic-embed-text-v1.5",
    ],
    fileSummaryEmbeddingModels: [],
  };

  async function runTeardownFixture(options: {
    failAt?: "drop-index" | "prepared-cache-reset" | "graph-delete";
    tablePresent?: boolean;
    indexesPresent?: boolean;
    catalogRows?: Array<{
      name: string;
      type: "vector";
      property: string;
      tableName?: string;
      status: "healthy" | "unknown";
      extensionLoaded?: boolean;
    }>;
  } = {}) {
    const {
      _teardownRepositoryDatabaseForTesting,
    } = await import("../../dist/mcp/tools/repo.js");
    const {
      resolveRequiredRetrievalIndexes,
    } = await import("../../dist/retrieval/health.js");
    const required = resolveRequiredRetrievalIndexes(semantic, repoId)
      .symbolVectors;
    const tableName = required[0]!.tableName;
    const controlRepoId = "control-repo";
    const controlTableName = resolveRequiredRetrievalIndexes(semantic, controlRepoId)
      .symbolVectors[0]!.tableName;
    const events: string[] = [];
    let durableLifecycle: "steady" | "deleting" | null = "steady";
    let tablePresent = options.tablePresent ?? true;
    let indexes = options.catalogRows ?? (
      options.indexesPresent === false
        ? []
        : required.map((index) => ({
            name: index.name!,
            type: "vector" as const,
            property: index.property!,
            tableName: index.tableName,
            status: "healthy" as const,
            extensionLoaded: true,
          }))
    );
    let graphDeletes = 0;
    let otherRepoRows = 1;
    const publishedReasons: string[] = [];

    const failAt = (boundary: typeof options.failAt) => {
      if (options.failAt === boundary) {
        throw new Error(`injected ${boundary} failure`);
      }
    };

    const run = () => _teardownRepositoryDatabaseForTesting(
      repoId,
      semantic,
      {
        withExclusiveOperation: async (task) => {
          events.push("gate:start");
          try {
            return await task();
          } finally {
            events.push("gate:release");
          }
        },
        withWriteConnection: async (task) => task({} as never),
        getRepo: async () => ({ repoId }),
        getLatestVersion: async () => ({ versionId: "v1" }) as never,
        markDeleting: async (_conn, targetRepoId) => {
          assert.strictEqual(targetRepoId, repoId);
          events.push("durable:deleting");
          durableLifecycle = "deleting";
        },
        invalidateHealth: () => {
          events.push("cache:invalidate");
          return 17;
        },
        inspectTable: async (_conn, targetRepoId) => {
          assert.strictEqual(targetRepoId, repoId);
          events.push("catalog:table");
          return {
            tableName,
            state: tablePresent ? "present" as const : "absent" as const,
          };
        },
        showIndexes: async () => {
          events.push("catalog:indexes");
          return indexes;
        },
        validateOwnership: async (_conn, targetRepoId) => {
          assert.strictEqual(targetRepoId, repoId);
          events.push("catalog:ownership");
        },
        dropIndex: async (_conn, targetTableName, indexName) => {
          assert.strictEqual(targetTableName, tableName);
          events.push(`drop-index:${indexName}`);
          failAt("drop-index");
          const before = indexes.length;
          indexes = indexes.filter((index) => index.name !== indexName);
          return { status: before === indexes.length ? "absent" : "dropped" };
        },
        dropTable: async (_conn, targetTableName) => {
          if (targetTableName === controlTableName) otherRepoRows = 0;
          assert.strictEqual(targetTableName, tableName);
          events.push("drop-table");
          tablePresent = false;
        },
        resetPreparedCaches: () => {
          events.push("prepared-cache-reset");
          failAt("prepared-cache-reset");
        },
        deleteGraph: async (_conn, targetRepoId) => {
          if (targetRepoId === controlRepoId) otherRepoRows = 0;
          assert.strictEqual(targetRepoId, repoId);
          events.push("graph-delete");
          graphDeletes += 1;
          failAt("graph-delete");
          durableLifecycle = null;
        },
        clearHealth: () => {
          events.push("cache:clear");
        },
        getDerivedState: async () =>
          durableLifecycle === null
            ? null
            : ({ embeddingLifecycleState: durableLifecycle }) as never,
        assessHealth: async (_conn, input) => [{
          repoId,
          versionId: input.versionId,
          generation: input.generation,
          model: semantic.symbolEmbeddingModels[0],
          lifecycleState: input.lifecycleState,
          mode: "degraded",
          exactFallbackAllowed: false,
          reason: "repository vector deletion is pending",
        }] as never,
        publishHealth: ({ snapshots }) => {
          events.push("cache:publish-deletion-pending");
          publishedReasons.push(...snapshots.map((snapshot) => snapshot.reason ?? ""));
          return true;
        },
        publishDiagnostic: (diagnostic) => {
          events.push(`diagnostic:${diagnostic.code}`);
        },
      },
    );

    return {
      run,
      events,
      get durableLifecycle() {
        return durableLifecycle;
      },
      get tablePresent() {
        return tablePresent;
      },
      get indexes() {
        return indexes;
      },
      get graphDeletes() {
        return graphDeletes;
      },
      get otherRepoRows() {
        return otherRepoRows;
      },
      publishedReasons,
    };
  }

  it("orders durable fencing, strict teardown, graph deletion, and cache clearing inside the exclusive gate", async () => {
    const fixture = await runTeardownFixture();
    await fixture.run();

    assert.deepStrictEqual(fixture.events, [
      "gate:start",
      "durable:deleting",
      "cache:invalidate",
      "catalog:table",
      "catalog:indexes",
      "catalog:ownership",
      ...fixture.events.filter((event) => event.startsWith("drop-index:")),
      "drop-table",
      "prepared-cache-reset",
      "graph-delete",
      "cache:clear",
      "gate:release",
    ]);
    assert.strictEqual(fixture.durableLifecycle, null);
    assert.strictEqual(fixture.otherRepoRows, 1);
    assert.strictEqual(
      fixture.events.some((event) => event === "cache:publish-deletion-pending"),
      false,
    );
  });

  it("treats absent indexes and an absent table as already torn down", async () => {
    const fixture = await runTeardownFixture({
      tablePresent: false,
      indexesPresent: false,
    });
    await fixture.run();

    assert.strictEqual(fixture.graphDeletes, 1);
    assert.strictEqual(fixture.events.includes("drop-table"), false);
    assert.strictEqual(fixture.events.includes("prepared-cache-reset"), false);
    assert.strictEqual(fixture.otherRepoRows, 1);
  });

  it("treats absent expected indexes as already dropped before table teardown", async () => {
    const fixture = await runTeardownFixture({
      tablePresent: true,
      indexesPresent: false,
    });
    await fixture.run();

    assert.strictEqual(fixture.graphDeletes, 1);
    assert.strictEqual(
      fixture.events.some((event) => event.startsWith("drop-index:")),
      false,
    );
    assert.strictEqual(fixture.events.includes("drop-table"), true);
    assert.strictEqual(fixture.events.includes("prepared-cache-reset"), true);
    assert.strictEqual(fixture.otherRepoRows, 1);
  });


  it("does not delete graph state when an index drop fails", async () => {
    const fixture = await runTeardownFixture({ failAt: "drop-index" });
    await assert.rejects(fixture.run, /injected drop-index failure/);

    assert.strictEqual(fixture.graphDeletes, 0);
    assert.strictEqual(fixture.tablePresent, true);
    assert.strictEqual(fixture.durableLifecycle, "deleting");
    assert.match(fixture.publishedReasons.join("\n"), /deletion is pending/);
    assert.ok(
      fixture.events.indexOf("cache:publish-deletion-pending") <
        fixture.events.indexOf("gate:release"),
    );
    assert.strictEqual(fixture.otherRepoRows, 1);
  });

  it("keeps durable deleting when cache reset fails after the table drop", async () => {
    const fixture = await runTeardownFixture({
      failAt: "prepared-cache-reset",
    });
    await assert.rejects(fixture.run, /injected prepared-cache-reset failure/);

    assert.strictEqual(fixture.tablePresent, false);
    assert.strictEqual(fixture.graphDeletes, 0);
    assert.strictEqual(fixture.durableLifecycle, "deleting");
    assert.match(fixture.publishedReasons.join("\n"), /deletion is pending/);
    assert.strictEqual(fixture.otherRepoRows, 1);
  });

  it("resumes after a graph-delete failure without recreating absent vector objects", async () => {
    const fixture = await runTeardownFixture({ failAt: "graph-delete" });
    await assert.rejects(fixture.run, /injected graph-delete failure/);
    assert.strictEqual(fixture.tablePresent, false);
    assert.strictEqual(fixture.durableLifecycle, "deleting");
    assert.strictEqual(fixture.otherRepoRows, 1);


    const retry = await runTeardownFixture({
      tablePresent: fixture.tablePresent,
      indexesPresent: false,
    });
    await retry.run();

    assert.strictEqual(retry.graphDeletes, 1);
    assert.strictEqual(retry.durableLifecycle, null);
    assert.strictEqual(retry.events.includes("drop-table"), false);
    assert.strictEqual(retry.otherRepoRows, 1);
  });

  it("rejects incompatible repository-table vector catalogs before DDL", async (t) => {
    const {
      resolveRequiredRetrievalIndexes,
    } = await import("../../dist/retrieval/health.js");
    const expected = resolveRequiredRetrievalIndexes(semantic, repoId)
      .symbolVectors[0]!;
    const exactRow = {
      name: expected.name!,
      type: "vector" as const,
      property: expected.property!,
      tableName: expected.tableName,
      status: "healthy" as const,
      extensionLoaded: true,
    };
    const cases = [
      {
        name: "wrong physical identity",
        rows: [{ ...exactRow, tableName: "SymbolVectorEmbedding_r_wrong" }],
        error: /incompatible/i,
      },
      {
        name: "ambiguous physical identity",
        rows: [exactRow, { ...exactRow, tableName: undefined }],
        error: /ambiguous/i,
      },
      {
        name: "unexpected table index",
        rows: [{
          ...exactRow,
          name: "unexpected_vector_index",
          property: "unexpectedVectorProperty",
        }],
        error: /unexpected vector index identity/i,
      },
    ];

    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        const fixture = await runTeardownFixture({
          catalogRows: testCase.rows,
        });

        await assert.rejects(fixture.run, testCase.error);
        assert.strictEqual(
          fixture.events.some((event) => event.startsWith("drop-index:")),
          false,
        );
        assert.strictEqual(fixture.events.includes("drop-table"), false);
        assert.strictEqual(fixture.graphDeletes, 0);
        assert.strictEqual(fixture.otherRepoRows, 1);
      });
    }
  });
});
