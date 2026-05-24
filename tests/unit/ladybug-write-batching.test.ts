import assert from "node:assert";
import { describe, it } from "node:test";

import type {
  EdgeRow,
  SymbolReferenceRow,
} from "../../dist/db/ladybug-queries.js";
import {
  insertEdges,
  insertSymbolReferences,
  withTransaction,
} from "../../dist/db/ladybug-queries.js";

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
});
