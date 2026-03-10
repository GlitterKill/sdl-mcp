/**
 * Tests for src/db/kuzu-core.ts — shared KuzuDB helper functions
 * These are unit tests for the pure utility functions (toNumber, toBoolean, assertSafeInt).
 * The async DB functions (exec, queryAll, querySingle, withTransaction) are tested
 * indirectly through the existing integration tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toNumber,
  toBoolean,
  assertSafeInt,
  isJoinHintSyntaxUnsupported,
  queryAll,
  querySingle,
  exec,
  withTransaction,
  getPreparedStatement,
} from "../../src/db/kuzu-core.js";

describe("toNumber", () => {
  it("returns number as-is", () => {
    assert.equal(toNumber(42), 42);
    assert.equal(toNumber(0), 0);
    assert.equal(toNumber(-1.5), -1.5);
  });

  it("converts bigint to number", () => {
    assert.equal(toNumber(100n), 100);
    assert.equal(toNumber(0n), 0);
  });

  it("converts numeric string to number", () => {
    assert.equal(toNumber("42"), 42);
    assert.equal(toNumber("3.14"), 3.14);
  });

  it("returns 0 for null", () => {
    assert.equal(toNumber(null), 0);
  });

  it("returns 0 for undefined", () => {
    assert.equal(toNumber(undefined), 0);
  });
});

describe("toBoolean", () => {
  it("returns boolean as-is", () => {
    assert.equal(toBoolean(true), true);
    assert.equal(toBoolean(false), false);
  });

  it("converts number to boolean", () => {
    assert.equal(toBoolean(1), true);
    assert.equal(toBoolean(0), false);
    assert.equal(toBoolean(-1), true);
  });

  it("converts bigint to boolean", () => {
    assert.equal(toBoolean(1n), true);
    assert.equal(toBoolean(0n), false);
  });

  it("converts string 'true' and '1' to true", () => {
    assert.equal(toBoolean("true"), true);
    assert.equal(toBoolean("1"), true);
  });

  it("converts other strings to false", () => {
    assert.equal(toBoolean("false"), false);
    assert.equal(toBoolean("0"), false);
    assert.equal(toBoolean(""), false);
  });

  it("returns false for null/undefined", () => {
    assert.equal(toBoolean(null), false);
    assert.equal(toBoolean(undefined), false);
  });
});

describe("assertSafeInt", () => {
  it("does not throw for safe integers", () => {
    assert.doesNotThrow(() => assertSafeInt(0, "value"));
    assert.doesNotThrow(() => assertSafeInt(Number.MAX_SAFE_INTEGER, "value"));
    assert.doesNotThrow(() => assertSafeInt(Number.MIN_SAFE_INTEGER, "value"));
    assert.doesNotThrow(() => assertSafeInt(42, "value"));
  });

  it("throws DatabaseError for values outside safe integer range", () => {
    assert.throws(() => assertSafeInt(Number.MAX_SAFE_INTEGER + 1, "value"), {
      name: "DatabaseError",
    });
  });

  it("throws DatabaseError for Infinity", () => {
    assert.throws(() => assertSafeInt(Infinity, "value"), {
      name: "DatabaseError",
    });
  });

  it("throws DatabaseError for NaN", () => {
    assert.throws(() => assertSafeInt(NaN, "value"), { name: "DatabaseError" });
  });

  it("throws DatabaseError for floats", () => {
    assert.throws(() => assertSafeInt(1.5, "value"), { name: "DatabaseError" });
  });
});

describe("isJoinHintSyntaxUnsupported", () => {
  it("returns true for HINT-related error messages", () => {
    assert.equal(
      isJoinHintSyntaxUnsupported(new Error("extraneous input 'HINT'")),
      true,
    );
    assert.equal(
      isJoinHintSyntaxUnsupported(new Error('extraneous input "HINT"')),
      true,
    );
  });

  it("returns false for unrelated errors", () => {
    assert.equal(
      isJoinHintSyntaxUnsupported(new Error("connection failed")),
      false,
    );
    assert.equal(isJoinHintSyntaxUnsupported(new Error("syntax error")), false);
  });

  it("handles non-Error values", () => {
    assert.equal(isJoinHintSyntaxUnsupported("extraneous input 'HINT'"), true);
    assert.equal(isJoinHintSyntaxUnsupported("some other error"), false);
    assert.equal(isJoinHintSyntaxUnsupported(null), false);
  });
});

describe("query helpers", () => {
  function makeQueryResult<T>(rows: T[]) {
    let index = 0;
    let closed = 0;
    return {
      result: {
        hasNext: () => index < rows.length,
        getNext: async () => rows[index++] as Record<string, unknown>,
        getAll: async () => rows,
        close: () => {
          closed += 1;
        },
      },
      getClosedCount: () => closed,
    };
  }

  it("prepare + execute round-trip caches statements and binds params", async () => {
    const calls: Array<{ prepared: string; params: Record<string, unknown> }> =
      [];
    const preparedByStatement = new Map<string, string>();
    const conn = {
      prepare: async (statement: string) => {
        const prepared = `prepared:${statement}`;
        preparedByStatement.set(statement, prepared);
        return prepared;
      },
      execute: async (prepared: unknown, params: unknown) => {
        calls.push({
          prepared: String(prepared),
          params: params as Record<string, unknown>,
        });
        const qr = makeQueryResult([{ value: 1 }]);
        return qr.result;
      },
    };

    const statement = "RETURN $value AS value";
    const prepared1 = await getPreparedStatement(
      conn as unknown as import("kuzu").Connection,
      statement,
    );
    const prepared2 = await getPreparedStatement(
      conn as unknown as import("kuzu").Connection,
      statement,
    );

    assert.equal(prepared1, prepared2);

    const rows = await queryAll<{ value: number }>(
      conn as unknown as import("kuzu").Connection,
      statement,
      { value: 1 },
    );

    assert.deepEqual(rows, [{ value: 1 }]);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.prepared,
      String(preparedByStatement.get(statement)),
    );
    assert.deepEqual(calls[0]?.params, { value: 1 });
  });

  it("queryAll/querySingle coerce array results and close all QueryResults", async () => {
    const first = makeQueryResult([{ ignored: true }]);
    const second = makeQueryResult([{ id: "row-1" }, { id: "row-2" }]);

    const conn = {
      prepare: async (_statement: string) => "prepared",
      execute: async () => [first.result, second.result],
    };

    const rows = await queryAll<{ id: string }>(
      conn as unknown as import("kuzu").Connection,
      "RETURN 1",
    );
    assert.deepEqual(rows, [{ id: "row-1" }, { id: "row-2" }]);
    assert.equal(first.getClosedCount(), 1);
    assert.equal(second.getClosedCount(), 1);

    const single = await querySingle<{ id: string }>(
      conn as unknown as import("kuzu").Connection,
      "RETURN 1",
    );
    assert.deepEqual(single, { id: "row-1" });
  });

  it("exec and withTransaction close results and manage begin/commit/rollback", async () => {
    const statements: string[] = [];
    const conn = {
      prepare: async (statement: string) => statement,
      execute: async (prepared: unknown) => {
        statements.push(String(prepared));
        const qr = makeQueryResult<Record<string, unknown>>([]);
        return qr.result;
      },
    };

    await exec(conn as unknown as import("kuzu").Connection, "RETURN 1");

    await withTransaction(
      conn as unknown as import("kuzu").Connection,
      async () => {
        await exec(conn as unknown as import("kuzu").Connection, "RETURN 2");
        return null;
      },
    );

    await assert.rejects(
      withTransaction(
        conn as unknown as import("kuzu").Connection,
        async () => {
          throw new Error("boom");
        },
      ),
      /boom/,
    );

    assert.deepEqual(statements, [
      "RETURN 1",
      "BEGIN TRANSACTION",
      "RETURN 2",
      "COMMIT",
      "BEGIN TRANSACTION",
      "ROLLBACK",
    ]);
  });
});
