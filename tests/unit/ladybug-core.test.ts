/**
 * Tests for src/db/ladybug-core.ts — shared LadybugDB helper functions
 * These are unit tests for the pure utility functions (toNumber, toBoolean, assertSafeInt).
 * The async DB functions (exec, queryAll, querySingle, withTransaction) are tested
 * indirectly through the existing integration tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as core from "../../dist/db/ladybug-core.js";
import {
  toNumber,
  toBoolean,
  assertSafeInt,
  queryAll,
  querySingle,
  exec,
  execDdl,
  execStoredProc,
  queryStoredProcAll,
  execCheckpoint,
  withTransaction,
  getPreparedStatement,
  isConnectionPoisoned,
  isConnStuck,
  drainConnMutex,
  _configureVectorQueryGuardForTesting,
} from "../../dist/db/ladybug-core.js";
import { withExclusiveLadybugOperation } from "../../dist/db/ladybug-operation-gate.js";

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

  type Connection = import("kuzu").Connection;
  const genericStringHelpers: Array<{
    name: string;
    run: (conn: Connection, statement: string) => Promise<unknown>;
  }> = [
    { name: "execDdl", run: (conn, statement) => execDdl(conn, statement) },
    {
      name: "queryStoredProcAll",
      run: (conn, statement) => queryStoredProcAll(conn, statement),
    },
    {
      name: "execStoredProc",
      run: (conn, statement) => execStoredProc(conn, statement),
    },
    {
      name: "getPreparedStatement",
      run: (conn, statement) => getPreparedStatement(conn, statement),
    },
    { name: "queryAll", run: (conn, statement) => queryAll(conn, statement) },
    {
      name: "querySingle",
      run: (conn, statement) => querySingle(conn, statement),
    },
    { name: "exec", run: (conn, statement) => exec(conn, statement) },
  ];

  function makeGenericConnection(onNativeCall: () => void): Connection {
    const result = makeQueryResult([]).result;
    return {
      query: async () => {
        onNativeCall();
        return result;
      },
      prepare: async () => {
        onNativeCall();
        return "prepared";
      },
      execute: async () => {
        onNativeCall();
        return result;
      },
    } as unknown as Connection;
  }

  it("rejects raw CHECKPOINT at every public generic string entry point", async () => {
    const rejectedStatements = [
      "  CHECKPOINT;  ",
      ";; CHECKPOINT;",
      "/* leading block comment */ CHECKPOINT;",
      "; /* block */ // line\n CHECKPOINT; RETURN 1",
      "MATCH (a)--(b); CHECKPOINT",
      "CHECKPOINT; MATCH (n) RETURN n",
      "RETURN 1 AS value; CHECKPOINT",
      "RETURN 1 AS `a\\`; CHECKPOINT; // scanner-close `",
      "RETURN 1; /* comment ; CHECKPOINT */ CHECKPOINT",
      "RETURN 1; // comment ; CHECKPOINT\r\n CHECKPOINT",
      "// leading line comment\nCHECKPOINT",
      "// leading line comment\r\nCHECKPOINT",
      "// leading line comment\rCHECKPOINT",
      "/* unterminated leading block comment\nCHECKPOINT",
      "RETURN 1; /* unterminated comment ; CHECKPOINT",
      "RETURN 'unterminated; CHECKPOINT",
      'RETURN "unterminated; CHECKPOINT',
      "RETURN `unterminated; CHECKPOINT",
    ];

    for (const helper of genericStringHelpers) {
      for (const statement of rejectedStatements) {
        let nativeCalls = 0;
        const conn = makeGenericConnection(() => {
          nativeCalls += 1;
        });

        await assert.rejects(
          helper.run(conn, statement),
          /CHECKPOINT|unterminated/i,
          `${helper.name} should reject ${JSON.stringify(statement)}`,
        );
        assert.equal(
          nativeCalls,
          0,
          `${helper.name} must reject before calling the native driver`,
        );
      }
    }
  });

  it("allows quoted and commented CHECKPOINT text at every public entry point", async () => {
    const allowedStatements = [
      "RETURN '; CHECKPOINT' AS value",
      'RETURN "; CHECKPOINT" AS value',
      "RETURN `; CHECKPOINT`",
      "RETURN 1 AS `a\\b; CHECKPOINT`",
      "RETURN 1 AS `a``; CHECKPOINT`",
      "RETURN 'escaped '' ; CHECKPOINT' AS value",
      "RETURN '// ; CHECKPOINT' AS value; RETURN 2",
      "RETURN 1; /* ; CHECKPOINT */ RETURN 2",
      "RETURN 1; // ; CHECKPOINT\r\n RETURN 2",
      "// ; CHECKPOINT at EOF",
    ];

    for (const helper of genericStringHelpers) {
      for (const statement of allowedStatements) {
        let nativeCalls = 0;
        const conn = makeGenericConnection(() => {
          nativeCalls += 1;
        });

        await helper.run(conn, statement);
        assert.ok(
          nativeCalls > 0,
          `${helper.name} should admit ${JSON.stringify(statement)}`,
        );
      }
    }
  });

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

  it("reports false when draining a stuck connection mutex times out", async () => {
    let releaseNative!: () => void;
    const nativeGate = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    const conn = {
      prepare: async (_statement: string) => "prepared",
      execute: async () => {
        await nativeGate;
        return makeQueryResult([]).result;
      },
    };

    const pending = queryAll(
      conn as unknown as import("kuzu").Connection,
      "RETURN 1",
    ).catch(() => undefined);

    try {
      await new Promise((resolve) => setTimeout(resolve, 0));

      const drained = await drainConnMutex(
        conn as unknown as import("kuzu").Connection,
        5,
        new Error("shutdown"),
      );

      assert.equal(drained, false);
    } finally {
      // Settle native work so its shared admission cannot leak into later tests.
      releaseNative();
      await pending;
    }
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

describe("vector stored-procedure liveness", { concurrency: false }, () => {
  type Connection = import("kuzu").Connection;
  type ExactVectorQuery = <T>(
    conn: Connection,
    statement: string,
    params?: Record<string, unknown>,
  ) => Promise<T[]>;
  type ConfigureExactGuard = (options?: {
    deadlineMs: number;
    cooldownMs: number;
  }) => void;

  function getExactVectorGuard(): {
    query: ExactVectorQuery;
    configure: ConfigureExactGuard;
  } {
    const exactVectorQuery = Reflect.get(core, "queryExactVectorAll");
    const configureExactGuard = Reflect.get(
      core,
      "_configureExactVectorQueryGuardForTesting",
    );
    assert.equal(typeof exactVectorQuery, "function");
    assert.equal(typeof configureExactGuard, "function");
    return {
      query: exactVectorQuery as ExactVectorQuery,
      configure: configureExactGuard as ConfigureExactGuard,
    };
  }

  it("single-flights vector work and quarantines a timed-out connection immediately", async () => {
    const previousWatchdog = process.env.SDL_STUCK_TASK_WARN_MS;
    process.env.SDL_STUCK_TASK_WARN_MS = "1000";
    _configureVectorQueryGuardForTesting({
      deadlineMs: 20,
      cooldownMs: 20,
    });

    let releaseNative!: () => void;
    let markNativeStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => {
      markNativeStarted = resolve;
    });
    const nativeGate = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    const emptyResult = {
      getAll: async () => [],
      close: () => {},
    };
    let firstCalls = 0;
    let otherCalls = 0;
    const firstConn = {
      query: async () => {
        firstCalls += 1;
        markNativeStarted();
        await nativeGate;
        return emptyResult;
      },
    } as unknown as Connection;
    const otherConn = {
      query: async () => {
        otherCalls += 1;
        return emptyResult;
      },
    } as unknown as Connection;
    const vectorCall =
      "CALL QUERY_VECTOR_INDEX('Symbol', 'symbol_vec', [0.1], 1) RETURN node, distance";

    try {
      const timeoutAssertion = assert.rejects(
        queryStoredProcAll(firstConn, vectorCall),
        /deadline exceeded/i,
      );
      await nativeStarted;

      const busyStartedAt = performance.now();
      await assert.rejects(
        queryStoredProcAll(otherConn, vectorCall),
        /already in progress/i,
      );
      assert.ok(performance.now() - busyStartedAt < 100);
      assert.equal(otherCalls, 0);

      await timeoutAssertion;
      assert.equal(firstCalls, 1);
      assert.equal(isConnStuck(firstConn), true);

      await assert.rejects(
        queryStoredProcAll(otherConn, vectorCall),
        /circuit is open/i,
      );
      assert.equal(otherCalls, 0);

      await queryStoredProcAll(
        otherConn,
        "CALL QUERY_FTS_INDEX('Symbol', 'symbol_fts', 'target') RETURN node, score",
      );
      assert.equal(otherCalls, 1);

      releaseNative();
      for (let attempt = 0; attempt < 20 && isConnStuck(firstConn); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 25));
      await queryStoredProcAll(otherConn, vectorCall);
      assert.equal(otherCalls, 2);
    } finally {
      releaseNative();
      for (let attempt = 0; attempt < 20 && isConnStuck(firstConn); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      _configureVectorQueryGuardForTesting();
      if (previousWatchdog === undefined) {
        delete process.env.SDL_STUCK_TASK_WARN_MS;
      } else {
        process.env.SDL_STUCK_TASK_WARN_MS = previousWatchdog;
      }
    }

    assert.equal(isConnStuck(firstConn), false);
  });

  it("runs an exact scan on a healthy connection while the ANN circuit is open", async () => {
    const exact = getExactVectorGuard();
    _configureVectorQueryGuardForTesting({ deadlineMs: 20, cooldownMs: 1_000 });
    exact.configure({ deadlineMs: 100, cooldownMs: 100 });

    let releaseAnn!: () => void;
    let markAnnStarted!: () => void;
    const annStarted = new Promise<void>((resolve) => {
      markAnnStarted = resolve;
    });
    const annGate = new Promise<void>((resolve) => {
      releaseAnn = resolve;
    });
    const emptyResult = { getAll: async () => [], close: () => {} };
    const annConn = {
      query: async () => {
        markAnnStarted();
        await annGate;
        return emptyResult;
      },
    } as unknown as Connection;
    let exactCalls = 0;
    const exactConn = {
      prepare: async (statement: string) => statement,
      execute: async () => {
        exactCalls += 1;
        return { getAll: async () => [{ symbolId: "owned" }], close: () => {} };
      },
    } as unknown as Connection;
    const vectorCall =
      "CALL QUERY_VECTOR_INDEX('Symbol', 'symbol_vec', [0.1], 1) RETURN node, distance";

    try {
      const annTimeout = assert.rejects(
        queryStoredProcAll(annConn, vectorCall),
        /deadline exceeded/i,
      );
      await annStarted;
      await annTimeout;
      await assert.rejects(queryStoredProcAll(exactConn, vectorCall), /circuit is open/i);

      const rows = await exact.query<{ symbolId: string }>(
        exactConn,
        "MATCH (s:Symbol) RETURN s.symbolId AS symbolId",
      );
      assert.deepEqual(rows, [{ symbolId: "owned" }]);
      assert.equal(exactCalls, 1);
    } finally {
      releaseAnn();
      for (let attempt = 0; attempt < 20 && isConnStuck(annConn); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      _configureVectorQueryGuardForTesting();
      exact.configure();
    }
  });

  it("queues concurrent exact scans and returns every result", async () => {
    const exact = getExactVectorGuard();
    exact.configure({ deadlineMs: 500, cooldownMs: 100 });

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executionOrder: number[] = [];
    const makeConn = (index: number): Connection =>
      ({
        prepare: async (statement: string) => statement,
        execute: async () => {
          executionOrder.push(index);
          if (index === 0) {
            markFirstStarted();
            await firstGate;
          }
          return {
            getAll: async () => [{ index }],
            close: () => {},
          };
        },
      }) as unknown as Connection;
    const statement = "MATCH (e:SymbolVectorEmbedding) RETURN e.symbolId";
    const calls: Array<Promise<Array<{ index: number }>>> = [];

    try {
      calls.push(exact.query(makeConn(0), statement));
      await firstStarted;
      calls.push(
        exact.query(makeConn(1), statement),
        exact.query(makeConn(2), statement),
        exact.query(makeConn(3), statement),
      );
      const allRows = Promise.all(calls);

      releaseFirst();

      assert.deepEqual(await allRows, [
        [{ index: 0 }],
        [{ index: 1 }],
        [{ index: 2 }],
        [{ index: 3 }],
      ]);
      assert.deepEqual(executionOrder, [0, 1, 2, 3]);
    } finally {
      releaseFirst();
      await Promise.allSettled(calls);
      exact.configure();
    }
  });

  it("quarantines a timed-out exact scan until native work settles", async () => {
    const exact = getExactVectorGuard();
    exact.configure({ deadlineMs: 20, cooldownMs: 1_000 });

    let releaseNative!: () => void;
    let markNativeStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => {
      markNativeStarted = resolve;
    });
    const nativeGate = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    const emptyResult = { getAll: async () => [], close: () => {} };
    let firstCalls = 0;
    const firstConn = {
      prepare: async (statement: string) => statement,
      execute: async () => {
        firstCalls += 1;
        markNativeStarted();
        await nativeGate;
        return emptyResult;
      },
    } as unknown as Connection;
    let otherCalls = 0;
    const otherConn = {
      prepare: async (statement: string) => {
        otherCalls += 1;
        return statement;
      },
      execute: async () => {
        otherCalls += 1;
        return emptyResult;
      },
    } as unknown as Connection;
    const statement = "MATCH (e:SymbolVectorEmbedding) RETURN e.symbolId";

    try {
      const timeoutAssertion = assert.rejects(
        exact.query(firstConn, statement),
        /deadline exceeded/i,
      );
      await nativeStarted;

      await timeoutAssertion;
      assert.equal(firstCalls, 1);
      assert.equal(isConnStuck(firstConn), true);

      await assert.rejects(exact.query(otherConn, statement), /circuit is open/i);
      assert.equal(otherCalls, 0);
      assert.equal(isConnStuck(firstConn), true);

      releaseNative();
      for (let attempt = 0; attempt < 20 && isConnStuck(firstConn); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(isConnStuck(firstConn), false);
    } finally {
      releaseNative();
      for (let attempt = 0; attempt < 20 && isConnStuck(firstConn); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      exact.configure();
    }
  });

  it("keeps overlapping watchdog and exact quarantine owners isolated", async () => {
    const exact = getExactVectorGuard();
    const previousWatchdog = process.env.SDL_STUCK_TASK_WARN_MS;
    process.env.SDL_STUCK_TASK_WARN_MS = "50";
    exact.configure({ deadlineMs: 10, cooldownMs: 1_000 });

    let releaseOrdinary!: () => void;
    let markOrdinaryStarted!: () => void;
    const ordinaryStarted = new Promise<void>((resolve) => {
      markOrdinaryStarted = resolve;
    });
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    let releaseExact!: () => void;
    let markExactStarted!: () => void;
    let exactExecutionStarted = false;
    let exactExecutionSettled = false;
    const exactStarted = new Promise<void>((resolve) => {
      markExactStarted = resolve;
    });
    let markExactSettled!: () => void;
    const exactSettled = new Promise<void>((resolve) => {
      markExactSettled = resolve;
    });
    const exactGate = new Promise<void>((resolve) => {
      releaseExact = resolve;
    });
    const emptyResult = { getAll: async () => [], close: () => {} };
    const conn = {
      query: async () => {
        markOrdinaryStarted();
        await ordinaryGate;
        return emptyResult;
      },
      prepare: async (statement: string) => statement,
      execute: async () => {
        exactExecutionStarted = true;
        markExactStarted();
        await exactGate;
        exactExecutionSettled = true;
        markExactSettled();
        return emptyResult;
      },
    } as unknown as Connection;

    try {
      const ordinaryQuery = queryStoredProcAll(
        conn,
        "CALL QUERY_FTS_INDEX('Symbol', 'symbol_fts', 'target') RETURN node, score",
      );
      await ordinaryStarted;
      for (let attempt = 0; attempt < 20 && !isConnStuck(conn); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(isConnStuck(conn), true);

      await assert.rejects(
        exact.query(
          conn,
          "MATCH (e:SymbolVectorEmbedding) RETURN e.symbolId",
        ),
        /deadline exceeded/i,
      );

      releaseOrdinary();
      await ordinaryQuery;
      await exactStarted;
      assert.equal(
        isConnStuck(conn),
        true,
        "the exact owner must survive the ordinary watchdog release",
      );

      releaseExact();
      for (let attempt = 0; attempt < 20 && isConnStuck(conn); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(isConnStuck(conn), false);
    } finally {
      releaseOrdinary();
      releaseExact();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (exactExecutionStarted && !exactExecutionSettled) {
        await Promise.race([
          exactSettled,
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
        ]);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      exact.configure();
      if (previousWatchdog === undefined) {
        delete process.env.SDL_STUCK_TASK_WARN_MS;
      } else {
        process.env.SDL_STUCK_TASK_WARN_MS = previousWatchdog;
      }
    }
  });

  it("applies the exact query deadline while waiting for shared admission", async () => {
    const exact = getExactVectorGuard();
    exact.configure({ deadlineMs: 20, cooldownMs: 100 });

    let releaseExclusive!: () => void;
    let markExclusiveStarted!: () => void;
    const exclusiveStarted = new Promise<void>((resolve) => {
      markExclusiveStarted = resolve;
    });
    const exclusiveGate = new Promise<void>((resolve) => {
      releaseExclusive = resolve;
    });
    const exclusiveOperation = withExclusiveLadybugOperation(async () => {
      markExclusiveStarted();
      await exclusiveGate;
    });
    let nativeCalls = 0;
    const conn = {
      prepare: async (statement: string) => {
        nativeCalls += 1;
        return statement;
      },
      execute: async () => {
        nativeCalls += 1;
        return {
          getAll: async () => [{ symbolId: "owned" }],
          close: () => {},
        };
      },
    } as unknown as Connection;
    let exactQuery: Promise<unknown> | undefined;
    let safetyTimer: NodeJS.Timeout | undefined;

    try {
      await exclusiveStarted;
      exactQuery = exact.query(
        conn,
        "MATCH (e:SymbolVectorEmbedding) RETURN e.symbolId",
      );
      const safetyDeadline = new Promise<never>((_, reject) => {
        safetyTimer = setTimeout(
          () => reject(new Error("exact gate-wait test safety deadline exceeded")),
          200,
        );
      });

      await assert.rejects(
        Promise.race([exactQuery, safetyDeadline]),
        /Timed out after 20ms waiting for shared Ladybug operation admission/i,
      );
      assert.equal(nativeCalls, 0);

      releaseExclusive();
      await exclusiveOperation;
      assert.deepEqual(
        await exact.query<{ symbolId: string }>(
          conn,
          "MATCH (e:SymbolVectorEmbedding) RETURN e.symbolId",
        ),
        [{ symbolId: "owned" }],
      );
      assert.equal(nativeCalls, 2);
    } finally {
      if (safetyTimer) clearTimeout(safetyTimer);
      releaseExclusive();
      await exclusiveOperation;
      if (exactQuery) await Promise.allSettled([exactQuery]);
      exact.configure();
    }
  });

  it("retains shared admission until timed-out exact native work drains", async () => {
    const exact = getExactVectorGuard();
    exact.configure({ deadlineMs: 20, cooldownMs: 1_000 });

    let releaseNative!: () => void;
    let markNativeStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => {
      markNativeStarted = resolve;
    });
    const nativeGate = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    const exactConn = {
      prepare: async (statement: string) => statement,
      execute: async () => {
        markNativeStarted();
        await nativeGate;
        return { getAll: async () => [], close: () => {} };
      },
    } as unknown as Connection;
    let checkpointNativeCalls = 0;
    const checkpointConn = {
      query: async () => {
        checkpointNativeCalls += 1;
        return { close: () => {} };
      },
    } as unknown as Connection;
    let exactQuery: Promise<unknown> | undefined;
    let checkpoint: Promise<void> | undefined;

    try {
      exactQuery = exact.query(
        exactConn,
        "MATCH (e:SymbolVectorEmbedding) RETURN e.symbolId",
      );
      const timeoutAssertion = assert.rejects(exactQuery, /deadline exceeded/i);
      await nativeStarted;
      await timeoutAssertion;

      checkpoint = execCheckpoint(checkpointConn);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(checkpointNativeCalls, 0);

      releaseNative();
      await checkpoint;
      assert.equal(checkpointNativeCalls, 1);
    } finally {
      releaseNative();
      if (exactQuery) await Promise.allSettled([exactQuery]);
      if (checkpoint) await Promise.allSettled([checkpoint]);
      for (let attempt = 0; attempt < 20 && isConnStuck(exactConn); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(isConnStuck(exactConn), false);
      exact.configure();
    }
  });

  it("rejects CHECKPOINT before an exact scan enters the native driver", async () => {
    const exact = getExactVectorGuard();
    exact.configure({ deadlineMs: 100, cooldownMs: 100 });
    let nativeCalls = 0;
    const conn = {
      prepare: async () => {
        nativeCalls += 1;
        return "prepared";
      },
      execute: async () => {
        nativeCalls += 1;
        return { getAll: async () => [], close: () => {} };
      },
    } as unknown as Connection;

    try {
      await assert.rejects(
        exact.query(conn, "RETURN 1; CHECKPOINT"),
        /CHECKPOINT/i,
      );
      assert.equal(nativeCalls, 0);
    } finally {
      exact.configure();
    }
  });
});
