import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-search-test-db.lbug");

interface LadybugConnection {
  query: (q: string) => Promise<{
    hasNext: () => boolean;
    getNext: () => Promise<Record<string, unknown>>;
    close: () => void;
  }>;
  close: () => Promise<void>;
}

interface LadybugDatabase {
  close: () => Promise<void>;
}

interface SearchSymbolLiteCandidate {
  symbolId: string;
  name: string;
  fileId: string;
  file: string;
  kind: string;
  exported: boolean;
  summary: string;
  searchText: string;
}

interface ScopedSearchQueries {
  getScopedSearchSymbolPool: (
    conn: import("kuzu").Connection,
    repoId: string,
    focusPaths: string[],
  ) => Promise<SearchSymbolLiteCandidate[]>;
  searchSymbolsLiteInPool: (
    candidates: SearchSymbolLiteCandidate[],
    query: string,
    limit?: number,
    kinds?: string[],
  ) => Array<Omit<SearchSymbolLiteCandidate, "summary" | "searchText">>;
  searchSymbolsLiteQueriesInPool: (
    candidates: SearchSymbolLiteCandidate[],
    queries: Array<{ query: string; limit: number; kinds?: string[] }>,
  ) => Array<Array<Omit<SearchSymbolLiteCandidate, "summary" | "searchText">>>;
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

async function setupSchema(conn: LadybugConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/ladybug-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("LadybugDB Search Queries", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;

  const repoId = "search-repo";

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");

      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:/tmp/search-repo",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-core",
        repoId,
        relPath: "src/core.ts",
        contentHash: "h1",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-adapter",
        repoId,
        relPath: "src/adapter/adapter.ts",
        contentHash: "h2",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-src-utils",
        repoId,
        relPath: "src/util/paths.ts",
        contentHash: "h3",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-tests-utils",
        repoId,
        relPath: "tests/unit/paths.test.ts",
        contentHash: "h4",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: "file-src-private",
        repoId,
        relPath: "src/internal/config.ts",
        contentHash: "h5",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-foo-class",
        repoId,
        fileId: "file-core",
        kind: "class",
        name: "Foo",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 2,
        rangeEndCol: 0,
        astFingerprint: "a",
        signatureJson: null,
        summary: "core foo class",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-foo-fn",
        repoId,
        fileId: "file-core",
        kind: "function",
        name: "Foo",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 10,
        rangeStartCol: 0,
        rangeEndLine: 11,
        rangeEndCol: 0,
        astFingerprint: "b",
        signatureJson: null,
        summary: "core foo function",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-foo-adapter",
        repoId,
        fileId: "file-adapter",
        kind: "function",
        name: "Foo",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 0,
        astFingerprint: "c",
        signatureJson: null,
        summary: "adapter foo",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-barfoo",
        repoId,
        fileId: "file-core",
        kind: "function",
        name: "BarFoo",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 20,
        rangeStartCol: 0,
        rangeEndLine: 20,
        rangeEndCol: 0,
        astFingerprint: "d",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-summary-only",
        repoId,
        fileId: "file-core",
        kind: "function",
        name: "Baz",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 30,
        rangeStartCol: 0,
        rangeEndLine: 30,
        rangeEndCol: 0,
        astFingerprint: "e",
        signatureJson: null,
        summary: "mentions Foo in summary",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-normalize-src",
        repoId,
        fileId: "file-src-utils",
        kind: "function",
        name: "normalizePath",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 40,
        rangeStartCol: 0,
        rangeEndLine: 45,
        rangeEndCol: 0,
        astFingerprint: "f",
        signatureJson: null,
        summary: "production normalize path helper",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-normalize-test",
        repoId,
        fileId: "file-tests-utils",
        kind: "function",
        name: "normalizePath",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 4,
        rangeStartCol: 0,
        rangeEndLine: 8,
        rangeEndCol: 0,
        astFingerprint: "g",
        signatureJson: null,
        summary: "test helper normalize path",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-resolve-exported",
        repoId,
        fileId: "file-core",
        kind: "function",
        name: "resolveConfig",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 50,
        rangeStartCol: 0,
        rangeEndLine: 55,
        rangeEndCol: 0,
        astFingerprint: "h",
        signatureJson: null,
        summary: "exported config resolver",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-resolve-private",
        repoId,
        fileId: "file-src-private",
        kind: "function",
        name: "resolveConfig",
        exported: false,
        visibility: "private",
        language: "typescript",
        rangeStartLine: 5,
        rangeStartCol: 0,
        rangeEndLine: 10,
        rangeEndCol: 0,
        astFingerprint: "i",
        signatureJson: null,
        summary: "private config resolver",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-shared-real",
        repoId,
        fileId: "file-core",
        kind: "function",
        name: "SharedThing",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 60,
        rangeStartCol: 0,
        rangeEndLine: 65,
        rangeEndCol: 0,
        astFingerprint: "j",
        signatureJson: null,
        summary: "real shared thing",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.exec(
        conn as unknown as import("kuzu").Connection,
        `MATCH (r:Repo {repoId: $repoId})
         CREATE (p:Symbol {
           symbolId: 'unresolved:call:SharedThing',
           repoId: $repoId,
           kind: 'function',
           name: 'SharedThing',
           exported: false,
           visibility: '',
           language: 'typescript',
           rangeStartLine: null,
           rangeStartCol: null,
           rangeEndLine: null,
           rangeEndCol: null,
           astFingerprint: '',
           signatureJson: null,
           summary: 'stale unresolved dependency placeholder',
           invariantsJson: null,
           sideEffectsJson: null,
           roleTagsJson: '[]',
           searchText: 'SharedThing placeholder',
           updatedAt: '2026-03-04T00:00:00Z',
           external: false,
           symbolStatus: 'real',
           placeholderKind: 'call',
           placeholderTarget: 'SharedThing'
         })
         CREATE (p)-[:SYMBOL_IN_REPO]->(r)`,
        { repoId },
      );

      await queries.batchMergeExternalSymbols(
        conn as unknown as import("kuzu").Connection,
        repoId,
        [
          {
            symbolId: "scip-external-chunk",
            kind: "function",
            name: "chunk",
            exported: true,
            language: "typescript",
            rangeStartLine: 0,
            rangeStartCol: 0,
            rangeEndLine: 0,
            rangeEndCol: 0,
            external: true,
            scipSymbol: "scip-typescript npm lodash 4.17.21 `chunk`().",
            source: "scip",
            packageName: "lodash",
            packageVersion: "4.17.21",
            updatedAt: "2026-03-04T00:00:00Z",
          },
        ],
      );
    } catch {
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    if (!ladybugAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it(
    "exact match ranks first and kind priority applies",
    { skip: !ladybugAvailable },
    async () => {
      const results = await queries.searchSymbols(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "Foo",
        10,
      );

      assert.ok(results.length >= 2);
      assert.strictEqual(results[0]!.name, "Foo");
      assert.strictEqual(results[0]!.kind, "class");
      assert.strictEqual(results[1]!.name, "Foo");
    },
  );

  it(
    "case-insensitive exact match ranks ahead of partial matches",
    { skip: !ladybugAvailable },
    async () => {
      const results = await queries.searchSymbolsLite(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "foo",
        10,
      );

      assert.ok(results.length >= 2);
      assert.strictEqual(results[0]!.name, "Foo");
    },
  );

  it("deprioritizes adapter files", { skip: !ladybugAvailable }, async () => {
    const results = await queries.searchSymbolsLite(
      conn as unknown as import("kuzu").Connection,
      repoId,
      "Foo",
      10,
    );

    const firstAdapterIdx = results.findIndex(
      (r) => r.fileId === "file-adapter",
    );
    const firstCoreIdx = results.findIndex((r) => r.fileId === "file-core");
    assert.ok(firstCoreIdx !== -1);
    assert.ok(firstAdapterIdx !== -1);
    assert.ok(firstCoreIdx < firstAdapterIdx);
  });

  it("respects limit", { skip: !ladybugAvailable }, async () => {
    const results = await queries.searchSymbolsLite(
      conn as unknown as import("kuzu").Connection,
      repoId,
      "Foo",
      2,
    );
    assert.strictEqual(results.length, 2);
  });

  it("batch search preserves token order and per-token limits", { skip: !ladybugAvailable }, async () => {
    const [fooResults, configResults] = await queries.searchSymbolsLiteBatch(
      conn as unknown as import("kuzu").Connection,
      repoId,
      ["Foo", "resolveConfig"],
      1,
      ["class", "function"],
    );

    assert.strictEqual(fooResults.length, 1);
    assert.strictEqual(fooResults[0]!.symbolId, "sym-foo-class");
    assert.strictEqual(configResults.length, 1);
    assert.strictEqual(configResults[0]!.symbolId, "sym-resolve-exported");
  });

  it(
    "searches all real scoped symbols by name, summary, and full camel query ranking",
    { skip: !ladybugAvailable },
    async () => {
      const scoped = queries as unknown as ScopedSearchQueries;
      assert.equal(typeof scoped.getScopedSearchSymbolPool, "function");
      assert.equal(typeof scoped.searchSymbolsLiteInPool, "function");
      assert.equal(typeof scoped.searchSymbolsLiteQueriesInPool, "function");

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-handle-workflow-helper",
        repoId,
        fileId: "file-core",
        kind: "function",
        name: "handleWorkflowHelper",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 70,
        rangeStartCol: 0,
        rangeEndLine: 75,
        rangeEndCol: 0,
        astFingerprint: "handle-helper",
        signatureJson: null,
        summary: "workflow helper",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-handle-workflow",
        repoId,
        fileId: "file-core",
        kind: "function",
        name: "handleWorkflow",
        exported: false,
        visibility: "private",
        language: "typescript",
        rangeStartLine: 80,
        rangeStartCol: 0,
        rangeEndLine: 85,
        rangeEndCol: 0,
        astFingerprint: "handle-exact",
        signatureJson: null,
        summary: "workflow handler",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const pool = await scoped.getScopedSearchSymbolPool(
        conn as unknown as import("kuzu").Connection,
        repoId,
        ["src/core.ts", "src/internal"],
      );

      const summaryMatches = scoped.searchSymbolsLiteInPool(pool, "Foo", 20);
      const privateMatches = scoped.searchSymbolsLiteInPool(
        pool,
        "resolveConfig",
        20,
      );
      const camelMatches = scoped.searchSymbolsLiteInPool(
        pool,
        "handleWorkflow",
        20,
      );
      const globalCamelMatches = await queries.searchSymbolsLite(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "handleWorkflow",
        20,
      );
      const batchedMatches = scoped.searchSymbolsLiteQueriesInPool(pool, [
        { query: "Foo", limit: 20 },
        { query: "resolveConfig", limit: 20 },
        { query: "handleWorkflow", limit: 20 },
      ]);

      assert.equal(
        summaryMatches.some((row) => row.symbolId === "sym-summary-only"),
        true,
      );
      assert.equal(
        privateMatches.some((row) => row.symbolId === "sym-resolve-private"),
        true,
      );
      assert.equal(camelMatches[0]?.symbolId, "sym-handle-workflow");
      assert.deepEqual(
        camelMatches.map((row) => row.symbolId),
        globalCamelMatches.map((row) => row.symbolId),
      );
      assert.deepEqual(batchedMatches, [
        summaryMatches,
        privateMatches,
        camelMatches,
      ]);
    },
  );

  it(
    "honors mixed and root scopes while excluding non-file-backed symbols",
    { skip: !ladybugAvailable },
    async () => {
      const scoped = queries as unknown as ScopedSearchQueries;
      assert.equal(typeof scoped.getScopedSearchSymbolPool, "function");

      const mixed = await scoped.getScopedSearchSymbolPool(
        conn as unknown as import("kuzu").Connection,
        repoId,
        ["src/core.ts", "tests"],
      );
      const mixedFiles = new Set(mixed.map((row) => row.file));
      assert.deepEqual(
        [...mixedFiles].sort(),
        ["src/core.ts", "tests/unit/paths.test.ts"],
      );

      const root = await scoped.getScopedSearchSymbolPool(
        conn as unknown as import("kuzu").Connection,
        repoId,
        ["src/core.ts", "."],
      );
      assert.equal(
        root.some((row) => row.symbolId === "sym-resolve-private"),
        true,
      );
      assert.equal(
        root.some((row) => row.symbolId === "unresolved:call:SharedThing"),
        false,
      );
      assert.equal(
        root.some((row) => row.symbolId === "scip-external-chunk"),
        false,
      );
      assert.deepEqual(
        root.map((row) => `${row.file}\0${row.symbolId}`),
        root
          .map((row) => `${row.file}\0${row.symbolId}`)
          .toSorted((left, right) => left.localeCompare(right)),
      );
    },
  );

  it(
    "keeps scoped symbols reachable beyond the first 200 files",
    { skip: !ladybugAvailable },
    async () => {
      const scoped = queries as unknown as ScopedSearchQueries;
      assert.equal(typeof scoped.getScopedSearchSymbolPool, "function");

      const files = Array.from({ length: 205 }, (_, index) => {
        const suffix = String(index).padStart(3, "0");
        return {
          fileId: `file-bulk-${suffix}`,
          repoId,
          relPath: `bulk/file-${suffix}.ts`,
          contentHash: `bulk-${suffix}`,
          language: "ts",
          byteSize: 1,
          lastIndexedAt: "2026-03-04T00:00:00Z",
        };
      });
      await queries.upsertFileBatch(
        conn as unknown as import("kuzu").Connection,
        files,
        { chunkSize: 256 },
      );
      await queries.upsertSymbolBatch(
        conn as unknown as import("kuzu").Connection,
        files.map((file, index) => ({
          symbolId: `sym-bulk-${String(index).padStart(3, "0")}`,
          repoId,
          fileId: file.fileId,
          kind: "function",
          name: index === 204 ? "lastScopedTarget" : `bulkSymbol${index}`,
          exported: false,
          visibility: "private",
          language: "typescript",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 1,
          rangeEndCol: 0,
          astFingerprint: `bulk-${index}`,
          signatureJson: null,
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          updatedAt: "2026-03-04T00:00:00Z",
        })),
        { chunkSize: 256 },
      );

      const pool = await scoped.getScopedSearchSymbolPool(
        conn as unknown as import("kuzu").Connection,
        repoId,
        ["bulk"],
      );

      assert.equal(pool.length, 205);
      assert.equal(
        pool.some((row) => row.symbolId === "sym-bulk-204"),
        true,
      );
      assert.equal(
        scoped.searchSymbolsLiteInPool(pool, "lastScopedTarget", 5)[0]
          ?.symbolId,
        "sym-bulk-204",
      );
    },
  );

  it(
    "prefers src symbols over tests for multi-term ties",
    { skip: !ladybugAvailable },
    async () => {
      const results = await queries.searchSymbols(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "normalizePath",
        10,
        ["function"],
      );

      assert.equal(results[0]?.symbolId, "sym-normalize-src");
      assert.equal(results[1]?.symbolId, "sym-normalize-test");
    },
  );

  it(
    "prefers exported symbols over private ones for multi-term ties",
    { skip: !ladybugAvailable },
    async () => {
      const results = await queries.searchSymbolsLite(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "resolveConfig",
        10,
        ["function"],
      );

      assert.equal(results[0]?.symbolId, "sym-resolve-exported");
      assert.equal(results[1]?.symbolId, "sym-resolve-private");
    },
  );

  it(
    "excludes unresolved dependency placeholders from full and lite search results",
    { skip: !ladybugAvailable },
    async () => {
      const full = await queries.searchSymbols(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "SharedThing",
        10,
      );
      const lite = await queries.searchSymbolsLite(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "SharedThing",
        10,
      );

      for (const [label, rows] of [
        ["full", full],
        ["lite", lite],
      ] as const) {
        assert.ok(
          rows.some((row) => row.symbolId === "sym-shared-real"),
          `${label} search should still return the real file-backed symbol`,
        );
        assert.equal(
          rows.some((row) => row.symbolId === "unresolved:call:SharedThing"),
          false,
          `${label} search must not return unresolved dependency placeholders`,
        );
      }
    },
  );

  it(
    "keeps SCIP external symbols searchable unless excludeExternal is set",
    { skip: !ladybugAvailable },
    async () => {
      const full = await queries.searchSymbols(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "chunk",
        10,
      );
      const lite = await queries.searchSymbolsLite(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "chunk",
        10,
      );
      const exact = await queries.findSymbolByExactName(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "chunk",
      );

      assert.equal(
        full.some((row) => row.symbolId === "scip-external-chunk"),
        true,
      );
      assert.equal(
        lite.some((row) => row.symbolId === "scip-external-chunk"),
        true,
      );
      assert.equal(exact?.symbolId, "scip-external-chunk");

      const filteredFull = await queries.searchSymbols(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "chunk",
        10,
        undefined,
        true,
      );
      const filteredLite = await queries.searchSymbolsLite(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "chunk",
        10,
        undefined,
        true,
      );
      const filteredExact = await queries.findSymbolByExactName(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "chunk",
        undefined,
        true,
      );

      assert.equal(
        filteredFull.some((row) => row.symbolId === "scip-external-chunk"),
        false,
      );
      assert.equal(
        filteredLite.some((row) => row.symbolId === "scip-external-chunk"),
        false,
      );
      assert.equal(filteredExact, null);
    },
  );

  it(
    "hydrates only searchable symbols for semantic/hybrid search candidates",
    { skip: !ladybugAvailable },
    async () => {
      const hydrated = await queries.getSearchableSymbolsByIds(
        conn as unknown as import("kuzu").Connection,
        repoId,
        [
          "sym-shared-real",
          "unresolved:call:SharedThing",
          "scip-external-chunk",
        ],
      );

      assert.equal(hydrated.has("sym-shared-real"), true);
      assert.equal(hydrated.has("scip-external-chunk"), true);
      assert.equal(hydrated.has("unresolved:call:SharedThing"), false);

      const filtered = await queries.getSearchableSymbolsByIds(
        conn as unknown as import("kuzu").Connection,
        repoId,
        ["sym-shared-real", "scip-external-chunk"],
        true,
      );

      assert.equal(filtered.has("sym-shared-real"), true);
      assert.equal(filtered.has("scip-external-chunk"), false);
    },
  );
});
