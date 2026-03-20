/**
 * Tests for src/db/ladybug-core.ts — shared LadybugDB helper functions
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
  queryAll,
  querySingle,
  exec,
  withTransaction,
  getPreparedStatement,
  isConnectionPoisoned,
} from "../../src/db/ladybug-core.js";

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

  it("throws for bigint values outside the safe integer range", () => {
    assert.throws(() => toNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n), {
      name: "DatabaseError",
    });
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

  it("queryAll/querySingle return rows and close the QueryResult", async () => {
    const qr = makeQueryResult([{ id: "row-1" }, { id: "row-2" }]);

    const conn = {
      prepare: async (_statement: string) => "prepared",
      execute: async () => qr.result,
    };

    const rows = await queryAll<{ id: string }>(
      conn as unknown as import("kuzu").Connection,
      "RETURN 1",
    );
    assert.deepEqual(rows, [{ id: "row-1" }, { id: "row-2" }]);
    assert.equal(qr.getClosedCount(), 1);

    const qr2 = makeQueryResult([{ id: "row-1" }, { id: "row-2" }]);
    const conn2 = {
      prepare: async (_statement: string) => "prepared",
      execute: async () => qr2.result,
    };

    const single = await querySingle<{ id: string }>(
      conn2 as unknown as import("kuzu").Connection,
      "RETURN 1",
    );
    assert.deepEqual(single, { id: "row-1" });
    assert.equal(qr2.getClosedCount(), 1);
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

  it("withTransaction surfaces rollback failure and marks the connection for recycle", async () => {
    const statements: string[] = [];
    const conn = {
      prepare: async (statement: string) => statement,
      execute: async (prepared: unknown) => {
        const statement = String(prepared);
        statements.push(statement);
        if (statement === "ROLLBACK") {
          throw new Error("rollback exploded");
        }
        const qr = makeQueryResult<Record<string, unknown>>([]);
        return qr.result;
      },
    };

    await assert.rejects(
      withTransaction(
        conn as unknown as import("kuzu").Connection,
        async () => {
          throw new Error("boom");
        },
      ),
      /rollback exploded/i,
    );

    assert.equal(
      isConnectionPoisoned(conn as unknown as import("kuzu").Connection),
      true,
    );

    await assert.rejects(
      withTransaction(
        conn as unknown as import("kuzu").Connection,
        async () => null,
      ),
      /unusable after a rollback failure/i,
    );

    assert.deepEqual(statements, [
      "BEGIN TRANSACTION",
      "ROLLBACK",
    ]);
  });

  it("rejects concurrent transactions on the same connection", async () => {
    const statements: string[] = [];
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let allowFinish: (() => void) | undefined;
    const canFinish = new Promise<void>((resolve) => {
      allowFinish = resolve;
    });
    const conn = {
      prepare: async (statement: string) => statement,
      execute: async (prepared: unknown) => {
        statements.push(String(prepared));
        const qr = makeQueryResult<Record<string, unknown>>([]);
        return qr.result;
      },
    };

    const outer = withTransaction(
      conn as unknown as import("kuzu").Connection,
      async () => {
        markStarted?.();
        await canFinish;
        return "outer";
      },
    );

    await started;

    await assert.rejects(
      withTransaction(
        conn as unknown as import("kuzu").Connection,
        async () => "inner",
      ),
      /Concurrent withTransaction\(\)|serialize access/i,
    );

    allowFinish?.();
    await assert.doesNotReject(outer);
    assert.deepEqual(statements, [
      "BEGIN TRANSACTION",
      "COMMIT",
    ]);
  });
});
