import assert from "node:assert";
import { readFileSync } from "node:fs";
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
  insertClusterMembersAfterDeleteBatch,
  insertNewFileSummaryBatch,
  insertProcessStepsAfterDeleteBatch,
  insertEdges,
  insertKnownSymbolEdges,
  insertSymbolReferences,
  replaceMetricsForRepoCopy,
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

  it("buffers fresh SymbolVersion COPY rows before writing to disk", () => {
    const source = readFileSync(
      join(__dirname, "../../src/db/ladybug-versions.ts"),
      "utf8",
    );

    assert.match(source, /SYMBOL_VERSION_CSV_WRITE_BATCH_SIZE/);
    assert.match(source, /buffer\.join\(""\)/);
    assert.doesNotMatch(
      source,
      /for \(const row of rows\) \{\s*await writeCsvLine\(stream,/s,
    );
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
