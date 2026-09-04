/**
 * Tests for upsertSymbolBatch — file-scoped batch symbol persistence.
 *
 * Covers:
 *   - Zero symbols (no-op)
 *   - One symbol (round-trip)
 *   - Typical-file symbol count (many symbols, all persisted)
 *   - Idempotent re-upserts (second call with same data is a no-op)
 *   - Update on re-upsert (changed fields are written)
 *   - Transaction rollback propagates (batch inside a failing transaction)
 *   - Parity with upsertSymbol (both produce identical DB state)
 *   - Fake-connection: single transaction wraps entire batch
 *   - Fake-connection: zero symbols issues no statements
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  resolveSymbolVectorPhysicalIdentity,
  setRepoSymbolVectorEmbedding,
} from "../../dist/db/ladybug-symbol-embeddings.js";
import { withExclusiveLadybugOperation } from "../../dist/db/ladybug-operation-gate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-symbol-batch-upsert-test-db.lbug");

// ── Shared helpers ─────────────────────────────────────────────────────────

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

type Queries = typeof import("../../dist/db/ladybug-queries.js");
type SymbolRow = import("../../dist/db/ladybug-queries.js").SymbolRow;

const TEST_CASE_JSON =
  '{"framework":"node:test","title":"keeps sdl.info callable","suitePath":["Code Mode"],"modifiers":["only"]}';

function makeSymbol(
  symbolId: string,
  repoId: string,
  fileId: string,
  name: string,
  overrides: Partial<SymbolRow> = {},
): SymbolRow {
  return {
    symbolId,
    repoId,
    fileId,
    kind: "function",
    name,
    exported: true,
    visibility: null,
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 10,
    rangeEndCol: 1,
    astFingerprint: `fp-${symbolId}`,
    signatureJson: null,
    summary: null,
    invariantsJson: null,
    sideEffectsJson: null,
    updatedAt: "2026-04-14T00:00:00Z",
    ...overrides,
  };
}

// ── Fake-connection helpers (no real DB required) ──────────────────────────

class FakeQueryResult {
  close(): void {}
  async getAll(): Promise<unknown[]> {
    return [];
  }
}

function createFakeConnection(statements: string[]): import("kuzu").Connection {
  return {
    async prepare(statement: string) {
      return {
        statement,
        isSuccess() {
          return true;
        },
        getErrorMessage() {
          return "";
        },
      };
    },
    async execute(preparedStatement: { statement: string }) {
      statements.push(preparedStatement.statement);
      return new FakeQueryResult();
    },
  } as unknown as import("kuzu").Connection;
}

function countStatements(statements: string[], fragment: string): number {
  return statements.filter((s) => s.includes(fragment)).length;
}

// ── Integration suite (real LadybugDB) ────────────────────────────────────

describe("upsertSymbolBatch — integration", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let queries: Queries;
  let ladybugAvailable = true;

  const repoId = "batch-upsert-repo";
  const fileId = "batch-upsert-file";

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");

      const conn_ = conn as unknown as import("kuzu").Connection;
      await queries.upsertRepo(conn_, {
        repoId,
        rootPath: "/tmp/batch-upsert-repo",
        configJson: "{}",
        createdAt: "2026-04-14T00:00:00Z",
      });
      await queries.upsertFile(conn_, {
        fileId,
        repoId,
        relPath: "src/example.ts",
        contentHash: "hash-initial",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: null,
      });
    } catch {
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    await cleanupTestDb(db, conn);
  });

  it(
    "zero symbols — no-op, file is untouched",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;

      await assert.doesNotReject(
        () => queries.upsertSymbolBatch(conn_, []),
        "upsertSymbolBatch([]) should not throw",
      );

      const symbols = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(symbols.length, 0, "no symbols should be present");
    },
  );

  it(
    "one symbol — round-trip persists all fields",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const sym = makeSymbol("batch-one-sym", repoId, fileId, "singleFn", {
        exported: false,
        visibility: "private",
        signatureJson: '{"params":["x"]}',
        summary: "does something",
        invariantsJson: '["x > 0"]',
        sideEffectsJson: '["logs"]',
        summaryQuality: 0.9,
        summarySource: "llm",
        testCaseJson: TEST_CASE_JSON,
      });

      await queries.upsertSymbolBatch(conn_, [sym]);

      const result = await queries.getSymbol(conn_, "batch-one-sym");
      assert.ok(result, "symbol should exist after batch upsert");
      assert.strictEqual(result.symbolId, sym.symbolId);
      assert.strictEqual(result.name, sym.name);
      assert.strictEqual(result.exported, sym.exported);
      assert.strictEqual(result.visibility, sym.visibility);
      assert.strictEqual(result.signatureJson, sym.signatureJson);
      assert.strictEqual(result.summary, sym.summary);
      assert.strictEqual(result.invariantsJson, sym.invariantsJson);
      assert.strictEqual(result.sideEffectsJson, sym.sideEffectsJson);
      assert.strictEqual(result.testCaseJson, TEST_CASE_JSON);

      const searchRows = await queries.searchSymbols(
        conn_,
        repoId,
        "singleFn",
        10,
      );
      assert.strictEqual(searchRows[0]?.testCaseJson, TEST_CASE_JSON);

      const searchableRows = await queries.getSearchableSymbolsByIds(
        conn_,
        repoId,
        [sym.symbolId],
      );
      assert.strictEqual(
        searchableRows.get(sym.symbolId)?.testCaseJson,
        TEST_CASE_JSON,
      );
      assert.strictEqual(result.repoId, repoId);
      assert.strictEqual(result.fileId, fileId);
    },
  );

  it(
    "getSymbol hydrates persisted external symbol metadata",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const sym = makeSymbol(
        "batch-external-sym",
        repoId,
        fileId,
        "externalFn",
        {
          external: true,
          source: "scip",
          packageName: "@scope/example",
          packageVersion: "1.2.3",
          scipSymbol: "scip-typescript npm @scope/example 1.2.3 externalFn().",
        },
      );

      await queries.upsertSymbolBatch(conn_, [sym]);

      const result = await queries.getSymbol(conn_, sym.symbolId);
      assert.ok(result, "external symbol should exist after batch upsert");
      assert.deepStrictEqual(
        {
          external: result.external,
          packageName: result.packageName,
          packageVersion: result.packageVersion,
          scipSymbol: result.scipSymbol,
        },
        {
          external: true,
          packageName: "@scope/example",
          packageVersion: "1.2.3",
          scipSymbol: "scip-typescript npm @scope/example 1.2.3 externalFn().",
        },
      );
    },
  );

  it(
    "counts the exact union of scoped and incoming persisted symbols",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const otherFileId = "batch-upsert-other-file";
      await queries.upsertFile(conn_, {
        fileId: otherFileId,
        repoId,
        relPath: "src/other.ts",
        contentHash: "hash-other",
        language: "ts",
        byteSize: 50,
        lastIndexedAt: null,
      });

      const scopedSymbols = [
        makeSymbol("replacement-scoped-a", repoId, fileId, "scopedA"),
        makeSymbol("replacement-scoped-b", repoId, fileId, "scopedB"),
      ];
      const incomingExisting = makeSymbol(
        "replacement-incoming-existing",
        repoId,
        otherFileId,
        "incomingExisting",
      );
      await queries.upsertSymbolBatch(conn_, [
        ...scopedSymbols,
        incomingExisting,
      ]);

      const count = await queries.countProviderReplacementSymbols(
        conn_,
        repoId,
        [fileId],
        [
          scopedSymbols[0]!.symbolId,
          incomingExisting.symbolId,
          "replacement-missing",
        ],
      );

      assert.strictEqual(count, 3);
    },
  );

  it(
    "provider retirement defers vector cleanup to semantic reconciliation",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const otherFileId = "provider-retirement-other-file";
      await queries.upsertFile(conn_, {
        fileId: otherFileId,
        repoId,
        relPath: "src/provider-other.ts",
        contentHash: "provider-other-hash",
        language: "ts",
        byteSize: 50,
        lastIndexedAt: null,
      });
      const scoped = makeSymbol(
        "provider-retired-scoped",
        repoId,
        fileId,
        "scoped",
      );
      const incoming = makeSymbol(
        "provider-retired-incoming",
        repoId,
        otherFileId,
        "incoming",
      );
      const preserved = makeSymbol(
        "provider-retirement-preserved",
        repoId,
        otherFileId,
        "preserved",
      );
      await queries.upsertSymbolBatch(conn_, [scoped, incoming, preserved]);
      const vectorTableName = resolveSymbolVectorPhysicalIdentity(
        repoId,
        "jina-embeddings-v2-base-code",
      ).tableName;

      await withExclusiveLadybugOperation(async () => {
        for (const symbol of [scoped, incoming, preserved]) {
          await setRepoSymbolVectorEmbedding(
            conn_,
            repoId,
            symbol.symbolId,
            "jina-embeddings-v2-base-code",
            `${symbol.symbolId}-jina`,
            `${symbol.symbolId}-jina-hash`,
            new Array<number>(768).fill(0.1),
          );
          await setRepoSymbolVectorEmbedding(
            conn_,
            repoId,
            symbol.symbolId,
            "nomic-embed-text-v1.5",
            `${symbol.symbolId}-nomic`,
            `${symbol.symbolId}-nomic-hash`,
            new Array<number>(768).fill(0.2),
          );
        }
      });

      await queries.deleteProviderReplacementSymbols(
        conn_,
        repoId,
        [fileId],
        [incoming.symbolId],
      );

      const rows = await queries.queryAll<{ symbolId: string; model: string }>(
        conn_,
        `MATCH (e:${vectorTableName})
         RETURN e.symbolId AS symbolId, e.model AS model
         ORDER BY e.symbolId, e.model`,
      );
      assert.deepStrictEqual(rows, [
        { symbolId: incoming.symbolId, model: "jina-embeddings-v2-base-code" },
        { symbolId: incoming.symbolId, model: "nomic-embed-text-v1.5" },
        { symbolId: scoped.symbolId, model: "jina-embeddings-v2-base-code" },
        { symbolId: scoped.symbolId, model: "nomic-embed-text-v1.5" },
        { symbolId: preserved.symbolId, model: "jina-embeddings-v2-base-code" },
        { symbolId: preserved.symbolId, model: "nomic-embed-text-v1.5" },
      ]);
    },
  );

  it(
    "provider retirement preserves shared Symbols, unchanged-file links, and vectors",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const otherRepoId = "provider-retirement-other-repo";
      const sameRepoFileId = "provider-retirement-same-repo-file";
      const otherFileId = "provider-retirement-shared-file";
      const shared = makeSymbol(
        "provider-retirement-shared",
        repoId,
        fileId,
        "shared",
      );
      await queries.upsertRepo(conn_, {
        repoId: otherRepoId,
        rootPath: "/tmp/provider-retirement-other-repo",
        configJson: "{}",
        createdAt: "2026-04-14T00:00:00Z",
      });
      await queries.upsertFile(conn_, {
        fileId: sameRepoFileId,
        repoId,
        relPath: "src/shared-unchanged.ts",
        contentHash: "shared-unchanged-hash",
        language: "ts",
        byteSize: 50,
        lastIndexedAt: null,
      });
      await queries.upsertFile(conn_, {
        fileId: otherFileId,
        repoId: otherRepoId,
        relPath: "src/shared.ts",
        contentHash: "shared-hash",
        language: "ts",
        byteSize: 50,
        lastIndexedAt: null,
      });
      await queries.upsertSymbolBatch(conn_, [shared]);
      await queries.exec(
        conn_,
        `MATCH (s:Symbol {symbolId: $symbolId}), (r:Repo {repoId: $otherRepoId})
         CREATE (s)-[:SYMBOL_IN_REPO]->(r)`,
        { symbolId: shared.symbolId, otherRepoId },
      );
      await queries.exec(
        conn_,
        `MATCH (s:Symbol {symbolId: $symbolId}),
               (sameRepoFile:File {fileId: $sameRepoFileId}),
               (otherFile:File {fileId: $otherFileId})
         CREATE (s)-[:SYMBOL_IN_FILE]->(sameRepoFile)
         CREATE (s)-[:SYMBOL_IN_FILE]->(otherFile)`,
        { symbolId: shared.symbolId, sameRepoFileId, otherFileId },
      );
      const vectorTableName = resolveSymbolVectorPhysicalIdentity(
        repoId,
        "jina-embeddings-v2-base-code",
      ).tableName;
      await withExclusiveLadybugOperation(() =>
        setRepoSymbolVectorEmbedding(
          conn_,
          repoId,
          shared.symbolId,
          "jina-embeddings-v2-base-code",
          "shared-vector",
          "shared-vector-hash",
          new Array<number>(768).fill(0.3),
        ),
      );

      await queries.deleteProviderReplacementSymbols(
        conn_,
        repoId,
        [fileId],
        [],
      );

      const symbol = await queries.querySingle<{
        repoId: string;
        currentMemberships: unknown;
        otherMemberships: unknown;
        targetFiles: unknown;
        sameRepoFiles: unknown;
        otherFiles: unknown;
      }>(
        conn_,
        `MATCH (s:Symbol {symbolId: $symbolId})
         RETURN s.repoId AS repoId,
                count { MATCH (s)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId}) } AS currentMemberships,
                count { MATCH (s)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $otherRepoId}) } AS otherMemberships,
                count { MATCH (s)-[:SYMBOL_IN_FILE]->(:File {fileId: $fileId}) } AS targetFiles,
                count { MATCH (s)-[:SYMBOL_IN_FILE]->(:File {fileId: $sameRepoFileId}) } AS sameRepoFiles,
                count { MATCH (s)-[:SYMBOL_IN_FILE]->(:File {fileId: $otherFileId}) } AS otherFiles`,
        {
          symbolId: shared.symbolId,
          repoId,
          otherRepoId,
          fileId,
          sameRepoFileId,
          otherFileId,
        },
      );
      assert.deepStrictEqual(symbol, {
        repoId,
        currentMemberships: 1,
        otherMemberships: 1,
        targetFiles: 0,
        sameRepoFiles: 1,
        otherFiles: 1,
      });
      assert.deepStrictEqual(
        await queries.querySingle<{ repoId: string; cardHash: string }>(
          conn_,
          `MATCH (e:${vectorTableName} {symbolId: $symbolId})
           RETURN e.repoId AS repoId, e.cardHash AS cardHash`,
          { symbolId: shared.symbolId },
        ),
        { repoId, cardHash: "shared-vector-hash" },
      );
    },
  );

  it(
    "rejects oversized provider replacement before deleting any Symbol rows",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const symbols = Array.from({ length: 2_049 }, (_, index) =>
        makeSymbol(
          `replacement-guard-${index}`,
          repoId,
          fileId,
          `guarded${index}`,
        ),
      );
      await queries.upsertSymbolBatch(conn_, symbols);

      await assert.rejects(
        queries.deleteProviderReplacementSymbols(
          conn_,
          repoId,
          [fileId],
          symbols.map((symbol) => symbol.symbolId),
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, "IndexError");
          assert.match(error.message, /2049/);
          assert.match(error.message, /2048/);
          assert.match(error.message, /fresh database rebuild is required/i);
          return true;
        },
      );

      const persisted = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(persisted.length, symbols.length);
    },
  );

  it(
    "provider metadata classification survives the bounded batch writer",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const providerTarget =
        "rust-analyzer cargo sdl-mcp-native 0.1.0 extract/summary/impl#[BodySignals][Default]default().";
      const providerSymbol = makeSymbol(
        "batch-provider-metadata",
        repoId,
        fileId,
        "default",
        {
          source: "scip",
          scipSymbol: providerTarget,
          symbolStatus: "unresolved",
          placeholderKind: "provider-metadata",
          placeholderTarget: providerTarget,
        },
      );
      const defaultSymbol = makeSymbol(
        "batch-default-status",
        repoId,
        fileId,
        "ordinaryFn",
      );

      await queries.upsertSymbolBatch(conn_, [providerSymbol, defaultSymbol]);

      const rawResult = await conn.query(
        "MATCH (s:Symbol) RETURN s.symbolId AS symbolId, s.symbolStatus AS symbolStatus, s.placeholderKind AS placeholderKind, s.placeholderTarget AS placeholderTarget",
      );
      const persistedById = new Map<string, Record<string, unknown>>();
      while (rawResult.hasNext()) {
        const row = await rawResult.getNext();
        persistedById.set(String(row.symbolId), row);
      }
      rawResult.close();

      const persistedProvider = persistedById.get(providerSymbol.symbolId);
      assert.strictEqual(persistedProvider?.symbolStatus, "unresolved");
      assert.strictEqual(
        persistedProvider?.placeholderKind,
        "provider-metadata",
      );
      assert.strictEqual(
        persistedProvider?.placeholderTarget,
        providerTarget,
      );

      const persistedDefault = persistedById.get(defaultSymbol.symbolId);
      assert.strictEqual(persistedDefault?.symbolStatus, "real");
      assert.strictEqual(persistedDefault?.placeholderKind, "");
      assert.strictEqual(persistedDefault?.placeholderTarget, "");
    },
  );

  it(
    "typical file — all symbols persisted, count matches",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const SYMBOL_COUNT = 30;
      const symbols = Array.from({ length: SYMBOL_COUNT }, (_, i) =>
        makeSymbol(`batch-typical-${i}`, repoId, fileId, `fn${i}`),
      );

      await queries.upsertSymbolBatch(conn_, symbols);

      const persisted = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(
        persisted.length,
        SYMBOL_COUNT,
        "all symbols should be persisted",
      );
    },
  );

  it(
    "mixed integral and fractional summaryQuality values persist in one logical batch",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const symbols = [
        makeSymbol("batch-quality-zero", repoId, fileId, "qualityZero", {
          summaryQuality: 0,
        }),
        makeSymbol("batch-quality-fractional", repoId, fileId, "qualityFrac", {
          summaryQuality: 0.55,
        }),
        makeSymbol("batch-quality-one", repoId, fileId, "qualityOne", {
          summaryQuality: 1,
        }),
      ];

      await queries.upsertSymbolBatch(conn_, symbols);

      const zero = await queries.getSymbol(conn_, "batch-quality-zero");
      const fractional = await queries.getSymbol(
        conn_,
        "batch-quality-fractional",
      );
      const one = await queries.getSymbol(conn_, "batch-quality-one");
      assert.strictEqual(zero?.summaryQuality, 0);
      assert.strictEqual(fractional?.summaryQuality, 0.55);
      assert.strictEqual(one?.summaryQuality, 1);
    },
  );

  it(
    "known fresh provider symbols - COPY persists nodes and ownership relationships",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const symbols = [
        makeSymbol("known-copy-1", repoId, fileId, "knownOne", {
          summary: "first line\nsecond \"quoted\", field",
          signatureJson: '{"text":"function knownOne()"}',
          summaryQuality: 0.6,
          summarySource: "provider:scip",
          source: "scip",
          scipSymbol: "scip npm pkg 1.0.0 src/index.ts/knownOne().",
        }),
        makeSymbol("known-copy-2", repoId, fileId, "knownTwo", {
          roleTagsJson: '["provider-primary"]',
          searchText: "knownTwo provider symbol",
          external: false,
          source: "scip",
          packageName: null,
          packageVersion: null,
          scipSymbol: "scip npm pkg 1.0.0 src/index.ts/knownTwo().",
        }),
      ];

      await queries.upsertKnownFileSymbols(conn_, symbols);

      const persisted = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(persisted.length, 2, "both COPY-loaded symbols exist");
      const first = persisted.find((symbol) => symbol.symbolId === "known-copy-1");
      assert.ok(first, "symbol should be readable through file/repo rels");
      assert.strictEqual(first.repoId, repoId);
      assert.strictEqual(first.fileId, fileId);
      assert.strictEqual(first.summary, symbols[0]!.summary);
      assert.strictEqual(first.scipSymbol, symbols[0]!.scipSymbol);
    },
  );

  it(
    "idempotent re-upsert — second call with same data is a no-op",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const symbols = [
        makeSymbol("batch-idem-1", repoId, fileId, "idemA"),
        makeSymbol("batch-idem-2", repoId, fileId, "idemB"),
      ];

      await queries.upsertSymbolBatch(conn_, symbols);
      // Second call with identical data — should not throw, count unchanged.
      await assert.doesNotReject(
        () => queries.upsertSymbolBatch(conn_, symbols),
        "idempotent re-upsert should not throw",
      );

      const persisted = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(persisted.length, 2, "count should stay at 2");
    },
  );

  it(
    "re-upsert updates changed fields",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const sym = makeSymbol("batch-update-sym", repoId, fileId, "updFn", {
        summary: "original",
        astFingerprint: "fp-v1",
      });
      await queries.upsertSymbolBatch(conn_, [sym]);

      const updated = { ...sym, summary: "updated", astFingerprint: "fp-v2" };
      await queries.upsertSymbolBatch(conn_, [updated]);

      const result = await queries.getSymbol(conn_, "batch-update-sym");
      assert.ok(result);
      assert.strictEqual(result.summary, "updated");
      assert.strictEqual(result.astFingerprint, "fp-v2");
    },
  );

  it(
    "parity with upsertSymbol — identical DB state for same input",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;

      // Second file for the serial path
      const fileId2 = "batch-parity-file";
      await queries.upsertFile(conn_, {
        fileId: fileId2,
        repoId,
        relPath: "src/parity.ts",
        contentHash: "hash-parity",
        language: "ts",
        byteSize: 50,
        lastIndexedAt: null,
      });

      // Two symbols that will be persisted via upsertSymbol (serial)
      const serial = [
        makeSymbol("parity-serial-1", repoId, fileId, "fn1"),
        makeSymbol("parity-serial-2", repoId, fileId, "fn2"),
      ];
      for (const s of serial) {
        await queries.upsertSymbol(conn_, s);
      }

      // Equivalent symbols persisted via upsertSymbolBatch
      const batch = serial.map((s) => ({
        ...s,
        symbolId: s.symbolId.replace("serial", "batch"),
        fileId: fileId2,
      }));
      await queries.upsertSymbolBatch(conn_, batch);

      const serialResults = (
        await queries.getSymbolsByFile(conn_, fileId)
      ).sort((a, b) => a.name.localeCompare(b.name));
      const batchResults = (
        await queries.getSymbolsByFile(conn_, fileId2)
      ).sort((a, b) => a.name.localeCompare(b.name));

      assert.strictEqual(
        serialResults.length,
        batchResults.length,
        "same number of symbols",
      );

      // Compare field-by-field (excluding symbolId/fileId which differ
      // intentionally). Empty/null nullable strings are normalised because
      // the per-row `upsertSymbol` and the UNWIND-batched
      // `upsertSymbolBatch` paths landed on slightly different empty-state
      // representations after the batched-MERGE migration (commit 948bef4):
      // one stores `null`, the other stores `""`. Both are semantically
      // "no summary present"; the test is asserting parity of the
      // observable SymbolRow shape, not the exact byte representation.
      const normalise = (v: string | null): string | null =>
        v === null || v === "" ? null : v;
      for (let i = 0; i < serialResults.length; i++) {
        const s = serialResults[i]!;
        const b = batchResults[i]!;
        assert.strictEqual(s.kind, b.kind);
        assert.strictEqual(s.name, b.name);
        assert.strictEqual(s.exported, b.exported);
        assert.strictEqual(s.language, b.language);
        assert.strictEqual(s.rangeStartLine, b.rangeStartLine);
        assert.strictEqual(s.astFingerprint, b.astFingerprint);
        assert.strictEqual(normalise(s.summary), normalise(b.summary));
      }
    },
  );

  it(
    "getSymbolsByFile enforces deterministic top-K ordering in LadybugDB",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      await queries.upsertSymbolBatch(conn_, [
        makeSymbol("nonexported-line-0", repoId, fileId, "nonexportedZero", {
          exported: false,
          rangeStartLine: 0,
        }),
        makeSymbol("exported-z-line-5", repoId, fileId, "exportedZ", {
          rangeStartLine: 5,
        }),
        makeSymbol("exported-a-line-5", repoId, fileId, "exportedA", {
          rangeStartLine: 5,
        }),
        makeSymbol("exported-line-2", repoId, fileId, "exportedTwo", {
          rangeStartLine: 2,
        }),
        makeSymbol("nonexported-line-1", repoId, fileId, "nonexportedOne", {
          exported: false,
          rangeStartLine: 1,
        }),
      ]);

      const limited = await queries.getSymbolsByFile(conn_, fileId, 3);

      assert.deepStrictEqual(
        limited.map((symbol) => symbol.symbolId),
        ["exported-line-2", "exported-a-line-5", "exported-z-line-5"],
      );
      assert.strictEqual(
        (await queries.getSymbolsByFile(conn_, fileId)).length,
        5,
        "omitting the limit must preserve existing unbounded callers",
      );
    },
  );

  it(
    "rollback propagates — symbols not visible after outer transaction aborts",
    { skip: !ladybugAvailable },
    async () => {
      const conn_ = conn as unknown as import("kuzu").Connection;
      const symbols = [
        makeSymbol("batch-rollback-1", repoId, fileId, "willBeRolledBack"),
      ];

      await assert.rejects(
        () =>
          queries.withTransaction(conn_, async (txConn) => {
            await queries.upsertSymbolBatch(txConn, symbols);
            throw new Error("intentional rollback trigger");
          }),
        /intentional rollback trigger/,
        "outer transaction should propagate the error",
      );

      const persisted = await queries.getSymbolsByFile(conn_, fileId);
      assert.strictEqual(
        persisted.length,
        0,
        "symbols should not be visible after rollback",
      );
    },
  );
});

describe("batchMergeExternalSymbols - unit (fake connection)", () => {
  it("N external symbols use UNWIND-batched node and relationship passes", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const { batchMergeExternalSymbols } =
      await import("../../dist/db/ladybug-queries.js");

    await batchMergeExternalSymbols(conn, "fake-repo", [
      makeExternalSymbol("external-1", "apiOne"),
      makeExternalSymbol("external-2", "apiTwo"),
      makeExternalSymbol("external-3", "apiThree"),
    ]);

    assert.strictEqual(
      countStatements(statements, "MERGE (s:Symbol"),
      1,
      "external symbols should be merged in one node batch, not one query per symbol",
    );
    assert.strictEqual(
      countStatements(statements, "UNWIND"),
      2,
      "external symbols should use node and SYMBOL_IN_REPO relationship passes",
    );
    assert.strictEqual(
      countStatements(statements, "MERGE (s)-[:SYMBOL_IN_REPO]"),
      0,
      "relationship writes should avoid MERGE-rel inside UNWIND",
    );
  });
});

function makeExternalSymbol(symbolId: string, name: string) {
  return {
    symbolId,
    kind: "function",
    name,
    exported: true,
    language: "external",
    rangeStartLine: 0,
    rangeStartCol: 0,
    rangeEndLine: 0,
    rangeEndCol: 0,
    external: true,
    scipSymbol: `scip-typescript npm dep 1.0.0 dep/index.ts/${name}().`,
    source: "scip" as const,
    packageName: "dep",
    packageVersion: "1.0.0",
    updatedAt: "2026-05-25T00:00:00.000Z",
  };
}

// ── Unit suite (fake connection — no real DB) ──────────────────────────────

describe("upsertSymbolBatch — unit (fake connection)", () => {
  it("zero symbols — no statements issued", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const { upsertSymbolBatch } =
      await import("../../dist/db/ladybug-queries.js");

    await upsertSymbolBatch(conn, []);

    // No BEGIN TRANSACTION, no MERGE statements.
    assert.strictEqual(
      statements.length,
      0,
      "zero symbols should issue no statements",
    );
  });

  it("N symbols — single BEGIN/COMMIT wraps one UNWIND-batched MERGE", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const { upsertSymbolBatch } =
      await import("../../dist/db/ladybug-queries.js");

    const repoId = "fake-repo";
    const fileId = "fake-file";
    const symbols = [
      makeSymbol("fake-sym-1", repoId, fileId, "a"),
      makeSymbol("fake-sym-2", repoId, fileId, "b"),
      makeSymbol("fake-sym-3", repoId, fileId, "c"),
    ];

    await upsertSymbolBatch(conn, symbols);

    assert.strictEqual(
      countStatements(statements, "BEGIN TRANSACTION"),
      1,
      "exactly one BEGIN TRANSACTION",
    );
    assert.strictEqual(
      countStatements(statements, "COMMIT"),
      1,
      "exactly one COMMIT",
    );
    assert.strictEqual(
      countStatements(statements, "ROLLBACK"),
      0,
      "no ROLLBACK on success",
    );
    // Post commit 948bef4 (UNWIND-batched MERGE) and the W3 workaround
    // for LadybugDB UNWIND+MERGE-rel (`src/db/ladybug-symbols.ts:187`),
    // `upsertSymbolBatch` issues a three-pass UNWIND:
    //   1. UNWIND → MERGE (s:Symbol …) + SET props
    //   2. UNWIND → CREATE (s)-[:SYMBOL_IN_FILE]->(f) idempotent
    //   3. UNWIND → CREATE (s)-[:SYMBOL_IN_REPO]->(r) idempotent
    // No `MERGE (rel)` form because that pattern triggered the
    // `invalid unordered_map<K, T> key` runtime bug in 0.15-0.16.
    assert.strictEqual(
      countStatements(statements, "MERGE (s:Symbol"),
      1,
      "exactly one MERGE on the Symbol node, regardless of N",
    );
    assert.strictEqual(
      countStatements(statements, "UNWIND"),
      3,
      "three UNWIND passes (node-merge + two CREATE-rel passes)",
    );
  });

  it("inside outer transaction — no nested BEGIN/COMMIT", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const { upsertSymbolBatch, withTransaction } =
      await import("../../dist/db/ladybug-queries.js");

    const repoId = "fake-repo";
    const fileId = "fake-file";
    const symbols = [makeSymbol("fake-nested-sym", repoId, fileId, "nested")];

    await withTransaction(conn, async (txConn) => {
      await upsertSymbolBatch(txConn, symbols);
    });

    // Only one BEGIN/COMMIT total — from the outer withTransaction.
    assert.strictEqual(
      countStatements(statements, "BEGIN TRANSACTION"),
      1,
      "only one BEGIN TRANSACTION even when nested",
    );
    assert.strictEqual(
      countStatements(statements, "COMMIT"),
      1,
      "only one COMMIT even when nested",
    );
  });
});


describe("repository-routed symbol vector storage — unit", () => {
  it("propagates SHOW_TABLES failures without preparing the catalog call", async () => {
    const { getRepoSymbolVectorEmbedding } =
      await import("../../dist/db/ladybug-symbol-embeddings.js");
    let queryCalls = 0;
    let prepareCalls = 0;
    const conn = {
      async query() {
        queryCalls += 1;
        throw new Error("catalog unavailable sentinel");
      },
      async prepare() {
        prepareCalls += 1;
        throw new Error("catalog calls must not be prepared");
      },
    } as unknown as Connection;

    await assert.rejects(
      getRepoSymbolVectorEmbedding(
        conn,
        "missing-repo",
        "symbol-1",
        "jina-embeddings-v2-base-code",
      ),
      /catalog unavailable sentinel/,
    );
    assert.strictEqual(queryCalls, 1);
    assert.strictEqual(prepareCalls, 0);
  });

  it("rejects a pre-existing wrong schema before CREATE, DELETE, or MERGE", async () => {
    const {
      resolveSymbolVectorPhysicalIdentity,
      setRepoSymbolVectorEmbedding,
    } = await import("../../dist/db/ladybug-symbol-embeddings.js");
    const { withExclusiveLadybugOperation } =
      await import("../../dist/db/ladybug-operation-gate.js");
    const tableName = resolveSymbolVectorPhysicalIdentity(
      "wrong-schema-repo",
      "jina-embeddings-v2-base-code",
    ).tableName;
    const statements: string[] = [];
    const conn = {
      async query(statement: string) {
        statements.push(statement);
        const rows = statement.includes("SHOW_TABLES")
          ? [{ name: tableName, type: "NODE" }]
          : [{ name: "embeddingId", type: "STRING", "primary key": true }];
        return {
          async getAll() {
            return rows;
          },
          close() {},
        };
      },
      async prepare(statement: string) {
        statements.push(statement);
        return {
          statement,
          isSuccess() {
            return true;
          },
          getErrorMessage() {
            return "";
          },
        };
      },
      async execute() {
        return new FakeQueryResult();
      },
    } as unknown as Connection;

    await assert.rejects(
      withExclusiveLadybugOperation(() =>
        setRepoSymbolVectorEmbedding(
          conn,
          "wrong-schema-repo",
          "symbol-1",
          "jina-embeddings-v2-base-code",
          "vector",
          "hash",
          new Array<number>(768).fill(0.1),
        ),
      ),
      /schema/i,
    );
    assert.ok(
      statements.every(
        (statement) => !/\b(?:CREATE|DELETE|MERGE)\b/.test(statement),
      ),
      `unexpected mutation statement: ${statements.join("\n")}`,
    );
  });

  it("validates ownership with one fail-fast predicate query", async () => {
    const {
      resolveSymbolVectorPhysicalIdentity,
      validateRepoSymbolVectorOwnership,
    } = await import("../../dist/db/ladybug-symbol-embeddings.js");
    const repoId = "ownership-query-repo";
    const tableName = resolveSymbolVectorPhysicalIdentity(
      repoId,
      "jina-embeddings-v2-base-code",
    ).tableName;
    const catalogColumns = [
      { name: "embeddingId", type: "STRING", "primary key": true },
      { name: "repoId", type: "STRING", "primary key": false },
      { name: "symbolId", type: "STRING", "primary key": false },
      { name: "model", type: "STRING", "primary key": false },
      { name: "embeddingVector", type: "STRING", "primary key": false },
      { name: "cardHash", type: "STRING", "primary key": false },
      { name: "updatedAt", type: "STRING", "primary key": false },
      {
        name: "embeddingJinaCodeVec",
        type: "DOUBLE[768]",
        "primary key": false,
      },
      {
        name: "embeddingNomicVec",
        type: "DOUBLE[768]",
        "primary key": false,
      },
    ];
    const preparedStatements: string[] = [];
    let executeCalls = 0;
    const conn = {
      async query(statement: string) {
        const rows = statement.includes("SHOW_TABLES")
          ? [{ name: tableName, type: "NODE" }]
          : catalogColumns;
        return {
          async getAll() {
            return rows;
          },
          close() {},
        };
      },
      async prepare(statement: string) {
        preparedStatements.push(statement);
        return {
          statement,
          isSuccess() {
            return true;
          },
          getErrorMessage() {
            return "";
          },
        };
      },
      async execute() {
        executeCalls += 1;
        return new FakeQueryResult();
      },
    } as unknown as Connection;

    await validateRepoSymbolVectorOwnership(
      conn,
      repoId,
      "jina-embeddings-v2-base-code",
    );

    assert.strictEqual(executeCalls, 1);
    assert.strictEqual(preparedStatements.length, 1);
    const statement = preparedStatements[0] ?? "";
    assert.match(statement, /WHERE e\.repoId IS NULL OR e\.repoId <> \$repoId/);
    assert.match(statement, /e\.embeddingJinaCodeVec IS NOT NULL/);
    assert.match(statement, /e\.model IS NULL OR e\.model <> \$model/);
    assert.match(statement, /e\.symbolId IS NULL/);
    assert.match(statement, /e\.embeddingId IS NULL/);
    assert.match(
      statement,
      /e\.embeddingId <> \$model \+ ':' \+ e\.symbolId/,
    );
    assert.match(statement, /RETURN 1 AS invalid\s+LIMIT 1/);
    assert.doesNotMatch(statement, /RETURN e\.repoId AS repoId/);
  });

  it("resets prepared statement caches for every connection at once", async () => {
    const { getPreparedStatement, resetPreparedStatementCaches } =
      await import("../../dist/db/ladybug-core.js");
    let firstPrepareCalls = 0;
    let secondPrepareCalls = 0;
    const makeConnection = (increment: () => void) =>
      ({
        async prepare(statement: string) {
          increment();
          return {
            statement,
            isSuccess() {
              return true;
            },
            getErrorMessage() {
              return "";
            },
          };
        },
      }) as unknown as Connection;
    const first = makeConnection(() => {
      firstPrepareCalls += 1;
    });
    const second = makeConnection(() => {
      secondPrepareCalls += 1;
    });

    await getPreparedStatement(first, "RETURN 1");
    await getPreparedStatement(first, "RETURN 1");
    await getPreparedStatement(second, "RETURN 1");
    await getPreparedStatement(second, "RETURN 1");
    assert.deepStrictEqual([firstPrepareCalls, secondPrepareCalls], [1, 1]);

    resetPreparedStatementCaches();

    await getPreparedStatement(first, "RETURN 1");
    await getPreparedStatement(second, "RETURN 1");
    assert.deepStrictEqual([firstPrepareCalls, secondPrepareCalls], [2, 2]);
  });
});
