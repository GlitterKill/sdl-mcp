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
});
