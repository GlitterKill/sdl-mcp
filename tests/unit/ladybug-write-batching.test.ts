import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type {
  EdgeRow,
  MetricsRow,
  SymbolRow,
  SymbolReferenceRow,
} from "../../dist/db/ladybug-queries.js";
import {
  createSecondaryIndexes,
} from "../../dist/db/ladybug-schema.js";
import {
  getExportedSymbolsByRepo,
  getFileSummarySymbolFactsByRepo,
  getSymbolsByRepoForSnapshotPage,
  copyClusterMembersAfterDeleteBatch,
  copyProcessStepsAfterDeleteBatch,
  ensureDependencyTargetsForKnownSourceEdges,
  insertClusterMembersAfterDeleteBatch,
  insertNewFileSummaryBatch,
  insertProcessStepsAfterDeleteBatch,
  insertEdges,
  insertKnownSymbolEdges,
  insertSymbolReferences,
  replaceMetricsForRepoCopy,
  upsertMetricsBatch,
  upsertKnownFileSymbols,
  withTransaction,
} from "../../dist/db/ladybug-queries.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

class FakeQueryResult {
  close(): void {}

  async getAll(): Promise<unknown[]> {
    return [];
  }
}

function createFakeConnection(
  statements: string[],
  paramsLog?: Record<string, unknown>[],
): import("kuzu").Connection {
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
    async execute(
      preparedStatement: { statement: string },
      params?: Record<string, unknown>,
    ) {
      statements.push(preparedStatement.statement);
      paramsLog?.push(params ?? {});
      return new FakeQueryResult();
    },
    async query(statement: string) {
      statements.push(statement);
      return new FakeQueryResult();
    },
  } as unknown as import("kuzu").Connection;
}

function countStatements(statements: string[], statement: string): number {
  return statements.filter((entry) => entry === statement).length;
}

function countStatementsContaining(
  statements: string[],
  text: string,
): number {
  return statements.filter((entry) => entry.includes(text)).length;
}

describe("LadybugDB write batching", () => {
  it("does not open nested transactions on the same connection", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);

    await withTransaction(conn, async (txConn) => {
      await withTransaction(txConn, async () => {
        return undefined;
      });
    });

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.strictEqual(countStatements(statements, "ROLLBACK"), 0);
  });

  it("wraps edge insertion in a single transaction", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const edges: EdgeRow[] = [
      {
        repoId: "repo",
        fromSymbolId: "a",
        toSymbolId: "b",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "test",
        createdAt: "2026-03-05T00:00:00.000Z",
      },
      {
        repoId: "repo",
        fromSymbolId: "a",
        toSymbolId: "c",
        edgeType: "import",
        weight: 0.6,
        confidence: 1,
        resolution: "exact",
        provenance: "test",
        createdAt: "2026-03-05T00:00:00.000Z",
      },
    ];

    await insertEdges(conn, edges);

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.strictEqual(countStatements(statements, "ROLLBACK"), 0);
  });

  it("wraps symbol reference insertion in a single transaction", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const references: SymbolReferenceRow[] = [
      {
        refId: "ref1",
        repoId: "repo",
        symbolName: "alpha",
        fileId: "file",
        lineNumber: null,
        createdAt: "2026-03-05T00:00:00.000Z",
      },
      {
        refId: "ref2",
        repoId: "repo",
        symbolName: "beta",
        fileId: "file",
        lineNumber: null,
        createdAt: "2026-03-05T00:00:00.000Z",
      },
    ];

    await insertSymbolReferences(conn, references);

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.strictEqual(countStatements(statements, "ROLLBACK"), 0);
  });

  it("uses the larger default symbol-reference write chunk", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const references: SymbolReferenceRow[] = Array.from(
      { length: 4097 },
      (_, index) => ({
        refId: `ref${index}`,
        repoId: "repo",
        symbolName: `symbol${index}`,
        fileId: "file",
        lineNumber: null,
        createdAt: "2026-03-05T00:00:00.000Z",
      }),
    );

    await insertSymbolReferences(conn, references);

    assert.strictEqual(
      countStatementsContaining(statements, "MERGE (sr:SymbolReference"),
      2,
      "4097 refs should use two UNWIND statements at the default chunk size",
    );
  });

  it("allows symbol-reference callers to override write chunk size", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const references: SymbolReferenceRow[] = Array.from(
      { length: 5 },
      (_, index) => ({
        refId: `ref${index}`,
        repoId: "repo",
        symbolName: `symbol${index}`,
        fileId: "file",
        lineNumber: null,
        createdAt: "2026-03-05T00:00:00.000Z",
      }),
    );

    await insertSymbolReferences(conn, references, { chunkSize: 2 });

    assert.strictEqual(
      countStatementsContaining(statements, "MERGE (sr:SymbolReference"),
      3,
      "chunkSize=2 should split five refs into three UNWIND statements",
    );
  });

  it("uses the larger default edge write chunk", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const edges: EdgeRow[] = Array.from({ length: 4097 }, (_, index) => ({
      repoId: "repo",
      fromSymbolId: `from${index}`,
      toSymbolId: `to${index}`,
      edgeType: "call",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: "test",
      createdAt: "2026-03-05T00:00:00.000Z",
    }));

    await insertEdges(conn, edges, {
      skipSourceRepoLink: true,
      skipExistingRelationshipUpdate: true,
    });

    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      2,
      "4097 edges should use two DEPENDS_ON create statements by default",
    );
  });

  it("keeps non-real target metadata off the file-backed cleanup path", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const edges: EdgeRow[] = [
      {
        repoId: "repo",
        fromSymbolId: "from-real",
        toSymbolId: "to-real",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "test",
        createdAt: "2026-03-05T00:00:00.000Z",
      },
      {
        repoId: "repo",
        fromSymbolId: "from-unresolved",
        toSymbolId: "unresolved:call:target",
        edgeType: "call",
        weight: 0.5,
        confidence: 0.5,
        resolution: "unresolved",
        provenance: "test",
        createdAt: "2026-03-05T00:00:00.000Z",
      },
    ];

    await insertEdges(conn, edges, {
      skipSourceRepoLink: true,
      skipExistingRelationshipUpdate: true,
    });

    assert.strictEqual(
      countStatementsContaining(
        statements,
        "OPTIONAL MATCH (b)-[:SYMBOL_IN_FILE]",
      ),
      1,
      "only real targets should need file-backed metadata cleanup",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "b.symbolStatus = row.targetStatus"),
      1,
      "non-real target rows should use the direct placeholder metadata update",
    );
  });

  it("uses larger bounded reads for fresh version snapshot pages", async () => {
    const statements: string[] = [];
    const paramsLog: Record<string, unknown>[] = [];

    await getSymbolsByRepoForSnapshotPage(
      createFakeConnection(statements, paramsLog),
      "repo",
    );

    assert.strictEqual(paramsLog[0]?.limit, 32768);
  });

  it("writes version snapshot pages through bounded MERGE batches", () => {
    const indexerSource = readFileSync(
      join(__dirname, "../../src/indexer/indexer-version.ts"),
      "utf8",
    );
    const versionsSource = readFileSync(
      join(__dirname, "../../src/db/ladybug-versions.ts"),
      "utf8",
    );

    assert.match(indexerSource, /snapshotSymbolVersionsBatch\(wConn, rows\)/);
    assert.match(
      versionsSource,
      /resolveLadybugWriteChunkSize\(\s*"symbolVersions"/,
    );
  });

  it("keeps keyed Metrics upserts on bounded typed MERGE batches", () => {
    const source = readFileSync(
      join(__dirname, "../../src/db/ladybug-metrics.ts"),
      "utf8",
    );
    const start = source.indexOf("export async function upsertMetricsBatch");
    const end = source.indexOf("function dedupeMetricsRows", start);

    assert.ok(start >= 0 && end > start);
    const keyedUpsert = source.slice(start, end);
    assert.doesNotMatch(keyedUpsert, /COPY Metrics/);
    assert.doesNotMatch(keyedUpsert, /getExistingMetricSymbolIds/);
    assert.match(
      keyedUpsert,
      /for \(let i = 0; i < dedupedRows\.length; i \+= CHUNK\)/,
    );
    assert.match(keyedUpsert, /const rowsByNullShape: Array<typeof chunk>/);
    assert.match(
      keyedUpsert,
      /\(row\.testRefsJsonIsNull \? 2 : 0\) \|\s*\(row\.canonicalTestJsonIsNull \? 1 : 0\)/,
    );
    assert.match(keyedUpsert, /METRICS_MERGE_QUERIES\[nullShape\]/);
    assert.doesNotMatch(keyedUpsert, /CASE|coalesce/i);
    assert.strictEqual(
      (source.match(/CAST\(row\.pageRankValue AS DOUBLE\)/g) ?? []).length,
      4,
    );
  });

  it("binds Metrics batches with one concrete type per member", async () => {
    const statements: string[] = [];
    const paramsLog: Record<string, unknown>[] = [];
    const rows: MetricsRow[] = Array.from({ length: 512 }, (_, index) => ({
      symbolId: `metric-${index}`,
      fanIn: index,
      fanOut: index + 1,
      churn30d: index + 2,
      testRefsJson: null,
      canonicalTestJson: null,
      pageRank: index % 2 === 0 ? index : index + 0.5,
      kCore: index % 7,
      updatedAt: "2026-07-18T00:00:00.000Z",
    }));

    await upsertMetricsBatch(createFakeConnection(statements, paramsLog), rows);

    const mergeParams = paramsLog.filter((params) => Array.isArray(params.rows));
    assert.deepStrictEqual(
      mergeParams.map((params) => (params.rows as unknown[]).length),
      [256, 256],
    );
    const boundRows = mergeParams.flatMap(
      (params) => params.rows as Array<Record<string, unknown>>,
    );
    assert.strictEqual(boundRows.length, rows.length);
    for (const [index, row] of boundRows.entries()) {
      assert.strictEqual(row.testRefsJsonValue, "null");
      assert.strictEqual(row.testRefsJsonIsNull, true);
      assert.strictEqual(row.canonicalTestJsonValue, "null");
      assert.strictEqual(row.canonicalTestJsonIsNull, true);
      assert.strictEqual(row.pageRankValue, String(rows[index]!.pageRank));
      assert.strictEqual(typeof row.pageRankValue, "string");
      assert.strictEqual(row.kCore, rows[index]!.kCore);
      assert.ok(!("testRefsJson" in row));
      assert.ok(!("canonicalTestJson" in row));
      assert.ok(!("pageRank" in row));
    }

    const mergeStatements = statements.filter((statement) =>
      statement.includes("MERGE (m:Metrics"),
    );
    assert.strictEqual(mergeStatements.length, 2);
    for (const statement of mergeStatements) {
      assert.match(statement, /m\.testRefsJson = null/);
      assert.match(statement, /m\.canonicalTestJson = null/);
      assert.match(
        statement,
        /m\.pageRank = CAST\(row\.pageRankValue AS DOUBLE\)/,
      );
      assert.doesNotMatch(statement, /CASE|coalesce/i);
    }
  });

  it("selects fixed Metrics queries for all nullable JSON shapes", async () => {
    const rows: MetricsRow[] = [
      {
        symbolId: "empty-json",
        fanIn: 1,
        fanOut: 2,
        churn30d: 3,
        testRefsJson: "",
        canonicalTestJson: "",
        pageRank: 0,
        kCore: 1,
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
      {
        symbolId: "literal-null-json",
        fanIn: 2,
        fanOut: 3,
        churn30d: 4,
        testRefsJson: "null",
        canonicalTestJson: "null",
        pageRank: 1.5,
        kCore: 2,
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
      {
        symbolId: "test-null-only",
        fanIn: 3,
        fanOut: 4,
        churn30d: 5,
        testRefsJson: null,
        canonicalTestJson: "{}",
        pageRank: 2,
        kCore: 3,
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
      {
        symbolId: "canonical-null-only",
        fanIn: 4,
        fanOut: 5,
        churn30d: 6,
        testRefsJson: "[]",
        canonicalTestJson: null,
        pageRank: 3.5,
        kCore: 4,
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
      {
        symbolId: "both-null",
        fanIn: 5,
        fanOut: 6,
        churn30d: 7,
        testRefsJson: null,
        canonicalTestJson: null,
        pageRank: 4,
        kCore: 5,
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    ];
    const statements: string[] = [];
    const paramsLog: Record<string, unknown>[] = [];

    await upsertMetricsBatch(createFakeConnection(statements, paramsLog), rows);

    const boundGroups = paramsLog.filter((params) => Array.isArray(params.rows));
    assert.strictEqual(boundGroups.length, 4);
    for (const params of boundGroups) {
      for (const row of params.rows as Array<Record<string, unknown>>) {
        assert.strictEqual(typeof row.testRefsJsonValue, "string");
        assert.strictEqual(typeof row.testRefsJsonIsNull, "boolean");
        assert.strictEqual(typeof row.canonicalTestJsonValue, "string");
        assert.strictEqual(typeof row.canonicalTestJsonIsNull, "boolean");
        assert.strictEqual(typeof row.pageRankValue, "string");
        assert.ok(!("testRefsJson" in row));
        assert.ok(!("canonicalTestJson" in row));
        assert.ok(!("pageRank" in row));
      }
    }

    const valueRows = boundGroups
      .flatMap((params) => params.rows as Array<Record<string, unknown>>)
      .filter((row) => row.testRefsJsonIsNull === false)
      .filter((row) => row.canonicalTestJsonIsNull === false);
    assert.deepStrictEqual(
      valueRows.map((row) => [
        row.testRefsJsonValue,
        row.testRefsJsonIsNull,
        row.canonicalTestJsonValue,
        row.canonicalTestJsonIsNull,
      ]),
      [
        ["", false, "", false],
        ["null", false, "null", false],
      ],
    );

    const mergeStatements = statements.filter((statement) =>
      statement.includes("MERGE (m:Metrics"),
    );
    assert.strictEqual(new Set(mergeStatements).size, 4);
    for (const statement of mergeStatements) {
      assert.match(
        statement,
        /m\.pageRank = CAST\(row\.pageRankValue AS DOUBLE\)/,
      );
      assert.doesNotMatch(statement, /CASE|coalesce/i);
    }
    assert.ok(
      mergeStatements.some(
        (statement) =>
          statement.includes("m.testRefsJson = row.testRefsJsonValue") &&
          statement.includes(
            "m.canonicalTestJson = row.canonicalTestJsonValue",
          ),
      ),
    );
    assert.ok(
      mergeStatements.some(
        (statement) =>
          statement.includes("m.testRefsJson = row.testRefsJsonValue") &&
          statement.includes("m.canonicalTestJson = null"),
      ),
    );
    assert.ok(
      mergeStatements.some(
        (statement) =>
          statement.includes("m.testRefsJson = null") &&
          statement.includes(
            "m.canonicalTestJson = row.canonicalTestJsonValue",
          ),
      ),
    );
    assert.ok(
      mergeStatements.some(
        (statement) =>
          statement.includes("m.testRefsJson = null") &&
          statement.includes("m.canonicalTestJson = null"),
      ),
    );
  });

  it("keeps typed Metrics replay isolated from native process aborts", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "sdl-metrics-batch-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(
            __dirname,
            "../fixtures/ladybug/metrics-batch-idempotence-child.mjs",
          ),
          join(fixtureRoot, "graph.lbug"),
        ],
        {
          cwd: join(__dirname, "../.."),
          encoding: "utf8",
          env: process.env,
          timeout: 60_000,
        },
      );

      assert.ifError(result.error);
      assert.strictEqual(result.signal, null, result.stderr);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.deepStrictEqual(JSON.parse(result.stdout.trim()), {
        ok: true,
        count: 640,
        fullBatchChunks: [256, 256, 128],
        statementCounts: [1, 3, 3, 2],
        updated: 64,
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("buffers full-repo Metrics COPY rows before writing to disk", () => {
    const source = readFileSync(
      join(__dirname, "../../src/db/ladybug-metrics.ts"),
      "utf8",
    );

    assert.match(source, /METRICS_CSV_WRITE_BATCH_SIZE/);
    assert.match(source, /buffer\.join\(""\)/);
    assert.doesNotMatch(
      source,
      /for \(const row of rows\) \{\s*await writeCsvLine\(stream,/s,
    );
  });

  it("keeps existing-edge refresh on by default and skips it only when requested", async () => {
    const edges: EdgeRow[] = [
      {
        repoId: "repo",
        fromSymbolId: "a",
        toSymbolId: "b",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "test",
        createdAt: "2026-03-05T00:00:00.000Z",
      },
    ];

    const defaultStatements: string[] = [];
    await insertEdges(createFakeConnection(defaultStatements), edges, {
      skipSourceRepoLink: true,
    });

    const pass1Statements: string[] = [];
    await insertEdges(createFakeConnection(pass1Statements), edges, {
      skipSourceRepoLink: true,
      skipExistingRelationshipUpdate: true,
    });

    assert.strictEqual(
      countStatementsContaining(defaultStatements, "SET d.weight = row.weight"),
      1,
      "default insertEdges semantics must still refresh existing DEPENDS_ON props",
    );
    assert.strictEqual(
      countStatementsContaining(pass1Statements, "SET d.weight = row.weight"),
      0,
      "pass-1 fresh-edge mode should skip the existing DEPENDS_ON refresh",
    );
  });

  it("inserts known-symbol edges without generic endpoint repair statements", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const edges: EdgeRow[] = Array.from({ length: 4097 }, (_, index) => ({
      repoId: "repo",
      fromSymbolId: `from${index}`,
      toSymbolId: `to${index}`,
      edgeType: "call",
      weight: 1,
      confidence: 0.95,
      resolution: "exact",
      resolverId: "provider-first:scip",
      resolutionPhase: "provider-first",
      provenance: "test",
      createdAt: "2026-03-05T00:00:00.000Z",
    }));

    await insertKnownSymbolEdges(conn, edges);

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.strictEqual(
      countStatementsContaining(statements, "COPY DEPENDS_ON FROM"),
      1,
      "known-symbol edges should use one relationship COPY load",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "MERGE (a:Symbol"),
      0,
      "known-symbol edges should not repair endpoint nodes",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (a)-[:DEPENDS_ON"),
      0,
      "known-symbol edges should not use per-row relationship create statements",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "OPTIONAL MATCH"),
      0,
      "known-symbol edges should not probe for existing relationships after source-symbol replacement",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "row.targetStatus"),
      0,
      "known-symbol edges should not run placeholder metadata repair",
    );
  });

  it("probes copied placeholder-like targets before merge-fallback creates missing symbols", async () => {
    const existingTarget = "unresolved:packages/bench/benchUtil.ts:makeData";
    const missingTarget = "unresolved:packages/bench/other.ts:other";
    const calls: Array<{
      statement: string;
      params: Record<string, unknown>;
    }> = [];
    const conn = {
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
      async execute(
        preparedStatement: { statement: string },
        params?: Record<string, unknown>,
      ) {
        calls.push({
          statement: preparedStatement.statement,
          params: params ?? {},
        });
        return {
          close(): void {},
          async getAll(): Promise<unknown[]> {
            return preparedStatement.statement.includes("RETURN s.symbolId AS symbolId") &&
              params?.symbolId === existingTarget
              ? [{ symbolId: existingTarget }]
              : [];
          },
        };
      },
      async query(statement: string) {
        calls.push({ statement, params: {} });
        return new FakeQueryResult();
      },
    } as unknown as import("kuzu").Connection;
    const targetEdge = (
      toSymbolId: string,
      placeholderTarget: string,
    ): EdgeRow => ({
      repoId: "repo",
      fromSymbolId: `from-${toSymbolId}`,
      toSymbolId,
      edgeType: "call",
      weight: 1,
      confidence: 0.95,
      resolution: "unresolved",
      resolverId: "test",
      resolutionPhase: "pass1",
      provenance: "test",
      createdAt: "2026-07-15T00:00:00.000Z",
      targetMeta: {
        symbolStatus: "unresolved",
        placeholderKind: "import",
        placeholderTarget,
      },
    });

    await ensureDependencyTargetsForKnownSourceEdges(conn, [
      targetEdge(existingTarget, "packages/bench/benchUtil.ts:makeData"),
      targetEdge(missingTarget, "packages/bench/other.ts:other"),
    ]);

    const mergeCalls = calls.filter((call) =>
      call.statement.includes("MERGE (b:Symbol {symbolId: row.toSymbolId})"),
    );
    const updateCalls = calls.filter((call) =>
      call.statement.includes("OPTIONAL MATCH (b)-[:SYMBOL_IN_FILE]->(:File)"),
    );
    assert.strictEqual(mergeCalls.length, 1);
    assert.deepStrictEqual(
      (mergeCalls[0]!.params.rows as Array<{ toSymbolId: string }>).map(
        (row) => row.toSymbolId,
      ),
      [missingTarget],
      "existing placeholder-like symbols copied as file-backed rows must not be sent through MERGE",
    );
    assert.strictEqual(updateCalls.length, 1);
    assert.deepStrictEqual(
      (updateCalls[0]!.params.rows as Array<{ toSymbolId: string }>).map(
        (row) => row.toSymbolId,
      ),
      [existingTarget],
      "existing placeholder-like symbols should take the MATCH-update path",
    );
  });

  it("loads known fresh file symbols with node and relationship COPY artifacts", async () => {
    const statements: string[] = [];
    const phases: string[] = [];
    const conn = createFakeConnection(statements);
    const symbols: SymbolRow[] = Array.from({ length: 4097 }, (_, index) => ({
      symbolId: `symbol-${index}`,
      repoId: "repo",
      fileId: "file",
      kind: "function",
      name: `symbol${index}`,
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: index,
      rangeStartCol: 0,
      rangeEndLine: index,
      rangeEndCol: 10,
      astFingerprint: `fp-${index}`,
      signatureJson: "{}",
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      summaryQuality: 0.6,
      summarySource: "provider:scip",
      roleTagsJson: "",
      searchText: `symbol${index}`,
      external: false,
      source: "scip",
      packageName: null,
      packageVersion: null,
      scipSymbol: `scip npm pkg 1.0.0 src/index.ts/symbol${index}().`,
      symbolStatus: "real",
      placeholderKind: "",
      placeholderTarget: "",
      updatedAt: "2026-03-05T00:00:00.000Z",
    }));

    await upsertKnownFileSymbols(conn, symbols, {
      measurePhase: async (phaseName, fn) => {
        phases.push(phaseName);
        return await fn();
      },
    });

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.deepEqual(phases, ["nodeAndRelCreate"]);
    assert.strictEqual(
      countStatementsContaining(
        statements,
        "COPY Symbol FROM",
      ),
      1,
      "known symbols should use one bulk Symbol COPY load",
    );
    assert.strictEqual(
      countStatementsContaining(
        statements,
        "MERGE (s:Symbol {symbolId: row.symbolId})",
      ),
      0,
      "known fresh symbols should not probe or merge replaced symbol nodes",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "COPY SYMBOL_IN_FILE FROM"),
      1,
      "known symbols should use one bulk SYMBOL_IN_FILE relationship COPY load",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "COPY SYMBOL_IN_REPO FROM"),
      1,
      "known symbols should use one bulk SYMBOL_IN_REPO relationship COPY load",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (s)-[:SYMBOL_IN_FILE]"),
      0,
      "known symbols should not use per-row SYMBOL_IN_FILE create statements",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "OPTIONAL MATCH"),
      0,
      "known fresh symbols should not probe for pre-existing relationships",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "preserveOptionalSymbolField"),
      0,
      "known fresh symbols should not preserve stale optional metadata",
    );
  });

  it("loads new file summaries with node and relationship COPY artifacts", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);

    await insertNewFileSummaryBatch(conn, [
      {
        fileId: "file-1",
        repoId: "repo",
        summary: "summary with \"quote\", comma and\nnewline",
        searchText: "file: src/example.ts exports: example",
        updatedAt: "2026-05-30T00:00:00.000Z",
      },
      {
        fileId: "file-2",
        repoId: "repo",
        summary: null,
        searchText: null,
        updatedAt: "2026-05-30T00:00:00.000Z",
      },
    ]);

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.strictEqual(
      countStatementsContaining(statements, "COPY FileSummary FROM"),
      1,
      "new file summaries should use one bulk FileSummary COPY load",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "COPY FILE_SUMMARY_IN_REPO FROM"),
      1,
      "new file summaries should bulk-load repo relationships",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "COPY SUMMARY_OF_FILE FROM"),
      1,
      "new file summaries should bulk-load file relationships",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "MERGE (fs:FileSummary"),
      0,
      "known-new file summaries should not use merge-safe node upserts",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "OPTIONAL MATCH"),
      0,
      "known-new file summaries should not probe relationships",
    );
  });

  it("reroutes already-existing file summaries to the merge-safe upsert before COPY", async () => {
    const statements: string[] = [];
    const conn = {
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
      async execute(
        preparedStatement: { statement: string },
        params?: Record<string, unknown>,
      ) {
        void params;
        statements.push(preparedStatement.statement);
        return {
          close(): void {},
          async getAll(): Promise<unknown[]> {
            // Absence probe reports file-1 as already present.
            return preparedStatement.statement.includes("RETURN fs.fileId")
              ? [{ fileId: "file-1" }]
              : [];
          },
        };
      },
      async query(statement: string) {
        statements.push(statement);
        return new FakeQueryResult();
      },
    } as unknown as import("kuzu").Connection;

    await insertNewFileSummaryBatch(conn, [
      {
        fileId: "file-1",
        repoId: "repo",
        summary: "row that already exists in the node table",
        searchText: "file: src/existing.ts",
        updatedAt: "2026-07-07T00:00:00.000Z",
      },
      {
        fileId: "file-2",
        repoId: "repo",
        summary: "provably new row",
        searchText: "file: src/new.ts",
        updatedAt: "2026-07-07T00:00:00.000Z",
      },
    ]);

    assert.strictEqual(
      countStatementsContaining(statements, "MERGE (fs:FileSummary"),
      1,
      "already-existing rows should take the merge-safe upsert lane",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "COPY FileSummary FROM"),
      1,
      "provably-new rows should still use the COPY lane",
    );
    // One transaction for the merge-safe reroute chunk, one for the COPY lane.
    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 2);
    assert.strictEqual(countStatements(statements, "COMMIT"), 2);
  });

  it("directly creates replacement cluster members after delete", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);

    await insertClusterMembersAfterDeleteBatch(conn, [
      { symbolId: "sym-1", clusterId: "cluster-1", membershipScore: 1 },
      { symbolId: "sym-1", clusterId: "cluster-1", membershipScore: 1 },
      { symbolId: "sym-2", clusterId: "cluster-1", membershipScore: 0.5 },
    ]);

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (s)-[:BELONGS_TO_CLUSTER"),
      1,
      "replacement cluster members should use one direct CREATE pass",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "OPTIONAL MATCH"),
      0,
      "replacement cluster members should not probe deleted relationships",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "MATCH (s)-[m:BELONGS_TO_CLUSTER"),
      0,
      "replacement cluster members should not run a second update pass",
    );
  });

  it("bulk-copies safe replacement cluster members after delete", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);

    await copyClusterMembersAfterDeleteBatch(conn, [
      { symbolId: "sym-1", clusterId: "cluster-1", membershipScore: 1 },
      { symbolId: "sym-1", clusterId: "cluster-1", membershipScore: 1 },
      { symbolId: "sym-2", clusterId: "cluster-1", membershipScore: 0.5 },
    ]);

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.strictEqual(
      countStatementsContaining(statements, "COPY BELONGS_TO_CLUSTER FROM"),
      1,
      "safe replacement cluster members should use one relationship COPY load",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (s)-[:BELONGS_TO_CLUSTER"),
      0,
      "safe replacement cluster members should not use UNWIND direct CREATE",
    );
  });

  it("falls back from cluster member COPY for unsafe endpoint ids", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);

    await copyClusterMembersAfterDeleteBatch(conn, [
      { symbolId: "sym-1", clusterId: "cluster-1", membershipScore: 1 },
      { symbolId: "sym,2", clusterId: "cluster-1", membershipScore: 0.5 },
    ]);

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.strictEqual(
      countStatementsContaining(statements, "COPY BELONGS_TO_CLUSTER FROM"),
      1,
      "safe cluster member rows should still use COPY",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (s)-[:BELONGS_TO_CLUSTER"),
      1,
      "unsafe cluster member endpoint ids should fall back to direct CREATE",
    );
  });

  it("directly creates replacement process steps after delete", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);

    await insertProcessStepsAfterDeleteBatch(conn, [
      { processId: "process-1", symbolId: "sym-1", stepOrder: 0, role: "entry" },
      { processId: "process-1", symbolId: "sym-1", stepOrder: 0, role: "entry" },
      {
        processId: "process-1",
        symbolId: "sym-2",
        stepOrder: 1,
        role: "exit",
      },
    ]);

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (s)-[:PARTICIPATES_IN"),
      1,
      "replacement process steps should use one direct CREATE pass",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "OPTIONAL MATCH"),
      0,
      "replacement process steps should not probe deleted relationships",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "MATCH (s)-[r:PARTICIPATES_IN"),
      0,
      "replacement process steps should not run a second update pass",
    );
  });

  it("bulk-copies safe replacement process steps after delete", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);

    await copyProcessStepsAfterDeleteBatch(conn, [
      { processId: "process-1", symbolId: "sym-1", stepOrder: 0, role: "entry" },
      { processId: "process-1", symbolId: "sym-1", stepOrder: 0, role: "entry" },
      {
        processId: "process-1",
        symbolId: "sym-2",
        stepOrder: 1,
        role: "exit",
      },
    ]);

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.strictEqual(
      countStatementsContaining(statements, "COPY PARTICIPATES_IN FROM"),
      1,
      "safe replacement process steps should use one relationship COPY load",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (s)-[:PARTICIPATES_IN"),
      0,
      "safe replacement process steps should not use UNWIND direct CREATE",
    );
  });

  it("falls back from process step COPY for unsafe endpoint ids", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);

    await copyProcessStepsAfterDeleteBatch(conn, [
      { processId: "process-1", symbolId: "sym-1", stepOrder: 0, role: "entry" },
      { processId: "process\n2", symbolId: "sym-2", stepOrder: 1, role: "exit" },
    ]);

    assert.strictEqual(countStatements(statements, "BEGIN TRANSACTION"), 1);
    assert.strictEqual(countStatements(statements, "COMMIT"), 1);
    assert.strictEqual(
      countStatementsContaining(statements, "COPY PARTICIPATES_IN FROM"),
      1,
      "safe process step rows should still use COPY",
    );
    assert.strictEqual(
      countStatementsContaining(statements, "CREATE (s)-[:PARTICIPATES_IN"),
      1,
      "unsafe process step endpoint ids should fall back to direct CREATE",
    );
  });

  it("uses Symbol.repoId for full-repo FileSummary reads", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);

    await getExportedSymbolsByRepo(conn, "repo");
    await getFileSummarySymbolFactsByRepo(conn, "repo");

    const readStatements = statements.filter((statement) =>
      statement.includes("MATCH (s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)"),
    );
    assert.strictEqual(readStatements.length, 2);
    for (const statement of readStatements) {
      assert.match(statement, /s\.repoId = \$repoId/);
      assert.doesNotMatch(statement, /SYMBOL_IN_REPO/);
    }
  });

  it("uses Symbol.repoId for version snapshot page reads", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);

    await getSymbolsByRepoForSnapshotPage(conn, "repo");

    const snapshotRead = statements.find((statement) =>
      statement.includes("RETURN s.symbolId AS symbolId"),
    );
    assert.ok(snapshotRead);
    assert.match(snapshotRead, /s\.repoId = \$repoId/);
    assert.doesNotMatch(snapshotRead, /SYMBOL_IN_REPO/);
  });

  it("uses Symbol.repoId for full-repo Metrics replacement deletes", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);

    await replaceMetricsForRepoCopy(conn, "repo", []);

    const deleteStatement = statements.find((statement) =>
      statement.includes("DELETE m"),
    );
    assert.ok(deleteStatement);
    assert.match(deleteStatement, /s\.repoId = \$repoId/);
    assert.doesNotMatch(deleteStatement, /SYMBOL_IN_REPO/);
  });

  it("measures full-repo Metrics replacement COPY phases", async () => {
    const statements: string[] = [];
    const conn = createFakeConnection(statements);
    const phases: string[] = [];
    const rows: MetricsRow[] = [
      {
        symbolId: "sym-a",
        fanIn: 1,
        fanOut: 2,
        churn30d: 3,
        testRefsJson: "[]",
        canonicalTestJson: null,
        pageRank: 0,
        kCore: 0,
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ];

    await replaceMetricsForRepoCopy(conn, "repo", rows, {
      measurePhase: async (phaseName, fn) => {
        phases.push(phaseName);
        return await fn();
      },
    });

    assert.deepStrictEqual(phases, [
      "csvMaterialize",
      "deleteExisting",
      "copyFrom",
    ]);
    assert.ok(
      statements.some((statement) => statement.startsWith("COPY Metrics FROM")),
    );
  });

  it("stops secondary index DDL after CREATE INDEX is unsupported", async () => {
    const statements: string[] = [];
    const unsupportedError =
      "Parser exception: Invalid input <CREATE INDEX>: expected rule oC_SingleQuery";
    const conn = {
      async query(statement: string) {
        statements.push(statement);
        throw new Error(unsupportedError);
      },
    } as unknown as import("kuzu").Connection;

    const result = await createSecondaryIndexes(conn);

    assert.strictEqual(result.attempted, result.failures.length);
    assert.strictEqual(
      statements.filter((statement) => statement.startsWith("CREATE INDEX"))
        .length,
      1,
      "unsupported CREATE INDEX runtimes should not pay one failed DDL per index",
    );
    assert.ok(
      result.failures.every((failure) => failure.error === unsupportedError),
    );
  });
});
