import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "node:os";
import type { Connection } from "kuzu";

const testDbBase = join(tmpdir(), ".test-kuzu-db");

let getLadybugDb: (dbPath?: string) => Promise<unknown>;
let getLadybugConn: () => Promise<unknown>;
let closeLadybugDb: () => Promise<void>;
let initLadybugDb: (dbPath: string) => Promise<void>;
let isLadybugAvailable: () => boolean;
let getLadybugDbPath: () => string | null;
let getReadPool: () => readonly Connection[];
let withExclusiveReadConnection: <T>(
  fn: (conn: Connection) => Promise<T>,
) => Promise<T>;
let withReadOnlyTransaction: <T>(
  conn: Connection,
  fn: () => Promise<T>,
) => Promise<T>;
let queryAll: <T>(
  conn: Connection,
  statement: string,
  params?: Record<string, unknown>,
) => Promise<T[]>;
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
let DatabaseErrorClass: new (message: string) => Error;
let normalizePath: (p: string) => string;
let ladybugAvailable = false;

await import("../../dist/db/ladybug.js")
  .then((kuzu) => {
    getLadybugDb = kuzu.getLadybugDb;
    getLadybugConn = kuzu.getLadybugConn;
    closeLadybugDb = kuzu.closeLadybugDb;
    initLadybugDb = kuzu.initLadybugDb;
    isLadybugAvailable = kuzu.isLadybugAvailable;
    getLadybugDbPath = kuzu.getLadybugDbPath;
    getReadPool = kuzu.getReadPool;
    withExclusiveReadConnection = kuzu.withExclusiveReadConnection;
    ladybugAvailable = true;
  })
  .catch(() => {
    getLadybugDb = async () => {
      throw new Error("Module not built");
    };
    getLadybugConn = async () => {
      throw new Error("Module not built");
    };
    closeLadybugDb = async () => {};
    initLadybugDb = async () => {
      throw new Error("Module not built");
    };
    isLadybugAvailable = () => false;
    getLadybugDbPath = () => null;
    getReadPool = () => [];
    withExclusiveReadConnection = async () => {
      throw new Error("Module not built");
    };
  });

await import("../../dist/db/ladybug-core.js")
  .then((core) => {
    withReadOnlyTransaction = core.withReadOnlyTransaction;
    queryAll = core.queryAll;
  })
  .catch(() => {
    withReadOnlyTransaction = async () => {
      throw new Error("Module not built");
    };
    queryAll = async () => {
      throw new Error("Module not built");
    };
  });

await import("../../dist/mcp/errors.js")
  .then((errors) => {
    DatabaseErrorClass = errors.DatabaseError;
  })
  .catch(() => {
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    DatabaseErrorClass = class DatabaseError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "DatabaseError";
      }
    };
  });

await import("../../dist/util/paths.js")
  .then((paths) => {
    normalizePath = paths.normalizePath;
  })
  .catch(() => {
    normalizePath = (p: string) => p.replace(/\\/g, "/");
  });

function getTestDbPath(name: string): string {
  return normalizePath(join(testDbBase, `kuzu-${name}`));
}

function cleanupTestDb(name: string): void {
  const dbPath = getTestDbPath(name);
  if (existsSync(dbPath)) {
    rmSync(dbPath, { recursive: true, force: true });
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recordingConnection(options?: {
  fail?: ReadonlyMap<string, Error>;
  events?: string[];
}): { conn: Connection; statements: string[] } {
  const statements: string[] = [];
  const conn = {
    prepare: async (statement: string) => ({ statement }),
    execute: async (prepared: unknown) => {
      const statement = (prepared as { statement: string }).statement;
      statements.push(statement);
      options?.events?.push(statement);
      const failure = options?.fail?.get(statement);
      if (failure) throw failure;
      return {
        close: () => {},
        getAll: async () => [],
      };
    },
  } as unknown as Connection;
  return { conn, statements };
}

describe("LadybugDB Connection Manager", { skip: !ladybugAvailable }, () => {
  beforeEach(async () => {
    await closeLadybugDb();
  });

  afterEach(async () => {
    await closeLadybugDb();
  });

  describe("getLadybugDb", () => {
    it("should create database successfully through Ladybug alias", async () => {
      const testPath = getTestDbPath("alias-db-create");
      cleanupTestDb("alias-db-create");

      try {
        const db = await getLadybugDb(testPath);
        assert.ok(db, "Database should be created through alias");
      } finally {
        await closeLadybugDb();
        cleanupTestDb("alias-db-create");
      }
    });

    it("should return singleton Database instance", async () => {
      const testPath = getTestDbPath("singleton");
      cleanupTestDb("singleton");

      try {
        const db1 = await getLadybugDb(testPath);
        const db2 = await getLadybugDb(testPath);

        assert.strictEqual(db1, db2, "Should return the same instance");
      } finally {
        await closeLadybugDb();
        cleanupTestDb("singleton");
      }
    });

    it("should create database parent directory if missing", async () => {
      const testPath = getTestDbPath("create-dir");
      cleanupTestDb("create-dir");

      try {
        assert.ok(
          !existsSync(testPath),
          "Parent directory should not exist initially",
        );

        await getLadybugDb(testPath);

        assert.ok(existsSync(testPath), "Parent directory should be created");
      } finally {
        await closeLadybugDb();
        cleanupTestDb("create-dir");
      }
    });

    it("should normalize Windows paths to forward slashes", async () => {
      const testPath = getTestDbPath("windows-path") + "\\subdir";
      const expected = normalizePath(join(testPath, "sdl-mcp-graph.lbug"));
      cleanupTestDb("windows-path");

      try {
        await getLadybugDb(testPath);

        const actualPath = getLadybugDbPath();
        assert.strictEqual(actualPath, expected);
      } finally {
        await closeLadybugDb();
        cleanupTestDb("windows-path");
      }
    });
  });

  describe("getLadybugConn", () => {
    it("should create connection successfully through Ladybug alias", async () => {
      const testPath = getTestDbPath("alias-conn-create");
      cleanupTestDb("alias-conn-create");

      try {
        await getLadybugDb(testPath);
        const conn = await getLadybugConn();
        assert.ok(conn, "Connection should be created through alias");
      } finally {
        await closeLadybugDb();
        cleanupTestDb("alias-conn-create");
      }
    });

    it("should return valid connections from the read pool", async () => {
      const testPath = getTestDbPath("conn-singleton");
      cleanupTestDb("conn-singleton");

      try {
        await getLadybugDb(testPath);
        const conn1 = await getLadybugConn();
        const conn2 = await getLadybugConn();

        // Read pool uses round-robin, so consecutive calls may return
        // different connection instances. Both must be valid.
        assert.ok(conn1, "First connection should be valid");
        assert.ok(conn2, "Second connection should be valid");
      } finally {
        await closeLadybugDb();
        cleanupTestDb("conn-singleton");
      }
    });

    it("should not throw when setMaxNumThreadForExec is missing", async () => {
      const testPath = getTestDbPath("conn-no-thread-setter");
      cleanupTestDb("conn-no-thread-setter");

      const kuzu = await import("kuzu");
      const connectionPrototype = kuzu.Connection.prototype as {
        setMaxNumThreadForExec?: (n: number) => void | Promise<void>;
      };
      const originalThreadSetter = connectionPrototype.setMaxNumThreadForExec;

      try {
        delete connectionPrototype.setMaxNumThreadForExec;
        await getLadybugDb(testPath);
        await assert.doesNotReject(async () => {
          await getLadybugConn();
        });
      } finally {
        if (originalThreadSetter) {
          connectionPrototype.setMaxNumThreadForExec = originalThreadSetter;
        }
        await closeLadybugDb();
        cleanupTestDb("conn-no-thread-setter");
      }
    });
  });

  describe("withExclusiveReadConnection", () => {
    it("creates and closes a connection outside the round-robin read pool", async () => {
      const testPath = getTestDbPath("exclusive-read");
      cleanupTestDb("exclusive-read");
      await initLadybugDb(testPath);

      const pooled = [...getReadPool()];
      let leased: Connection | undefined;
      const kuzu = await import("kuzu");
      const prototype = kuzu.Connection.prototype;
      const originalClose = prototype.close;
      const closed = new Set<Connection>();
      prototype.close = async function () {
        closed.add(this);
        await originalClose.call(this);
      };

      try {
        await withExclusiveReadConnection(async (conn) => {
          leased = conn;
          assert.ok(!pooled.includes(conn));
        });
        assert.ok(leased);
        assert.ok(closed.has(leased));
      } finally {
        prototype.close = originalClose;
        await closeLadybugDb();
        cleanupTestDb("exclusive-read");
      }
    });

    it("closes and releases a lease when its callback fails", async () => {
      const testPath = getTestDbPath("exclusive-read-failure");
      cleanupTestDb("exclusive-read-failure");
      await initLadybugDb(testPath);

      const expected = new Error("scan failed");
      let leased: Connection | undefined;
      const kuzu = await import("kuzu");
      const prototype = kuzu.Connection.prototype;
      const originalClose = prototype.close;
      const closed = new Set<Connection>();
      prototype.close = async function () {
        closed.add(this);
        await originalClose.call(this);
      };

      try {
        await assert.rejects(
          withExclusiveReadConnection(async (conn) => {
            leased = conn;
            throw expected;
          }),
          (err) => err === expected,
        );
        assert.ok(leased);
        assert.ok(closed.has(leased));
        await closeLadybugDb();
      } finally {
        prototype.close = originalClose;
        await closeLadybugDb();
        cleanupTestDb("exclusive-read-failure");
      }
    });

    it("makes closeLadybugDb wait for an active exclusive lease", async () => {
      const testPath = getTestDbPath("exclusive-read-close");
      cleanupTestDb("exclusive-read-close");
      await initLadybugDb(testPath);

      const entered = deferred();
      const release = deferred();
      const lease = withExclusiveReadConnection(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;

      let closeCompleted = false;
      const close = closeLadybugDb().then(() => {
        closeCompleted = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(closeCompleted, false);
      await assert.rejects(
        withExclusiveReadConnection(async () => {}),
        /LadybugDB is closing/,
      );

      release.resolve();
      await lease;
      await close;
      assert.strictEqual(getLadybugDbPath(), null);
      cleanupTestDb("exclusive-read-close");
    });
  });

  describe("closeLadybugDb", () => {
    it("should close database and reset state", async () => {
      const testPath = getTestDbPath("close-test");
      cleanupTestDb("close-test");

      try {
        await getLadybugDb(testPath);
        assert.ok(getLadybugDbPath() !== null, "Path should be set");

        await closeLadybugDb();

        assert.strictEqual(
          getLadybugDbPath(),
          null,
          "Path should be null after close",
        );
      } finally {
        await closeLadybugDb();
        cleanupTestDb("close-test");
      }
    });

    it("should be safe to call multiple times", async () => {
      await closeLadybugDb();
      await closeLadybugDb();
      await closeLadybugDb();
    });
  });

  describe("initLadybugDb", () => {
    it("should initialize database with schema", async () => {
      const testPath = getTestDbPath("init-schema");
      cleanupTestDb("init-schema");

      try {
        await initLadybugDb(testPath);

        const actualPath = getLadybugDbPath();
        assert.ok(actualPath, "Database path should be set");
        assert.ok(existsSync(actualPath), "Database file should exist");

        const conn = await getLadybugConn();
        assert.ok(conn, "Connection should be available after init");
      } finally {
        await closeLadybugDb();
        cleanupTestDb("init-schema");
      }
    });
  });

  describe("isLadybugAvailable", () => {
    it("should return boolean", () => {
      const result = isLadybugAvailable();
      assert.strictEqual(typeof result, "boolean");
    });

    it("should return true when Ladybug alias is installed", () => {
      assert.strictEqual(isLadybugAvailable(), true);
    });
  });

  describe("getLadybugDbPath", () => {
    it("should return null when not initialized", async () => {
      await closeLadybugDb();
      assert.strictEqual(getLadybugDbPath(), null);
    });
  });

  describe("path normalization", () => {
    it("should handle Windows backslashes", async () => {
      const testPath = getTestDbPath("path-norm") + "\\subdir";
      cleanupTestDb("path-norm");

      try {
        await getLadybugDb(testPath);

        const storedPath = getLadybugDbPath();
        assert.ok(storedPath?.includes("/"), "Path should use forward slashes");
        assert.ok(
          !storedPath?.includes("\\"),
          "Path should not contain backslashes",
        );
      } finally {
        await closeLadybugDb();
        cleanupTestDb("path-norm");
      }
    });
  });
});

describe("withReadOnlyTransaction", () => {
  it("begins read-only and commits only after the callback completes", async () => {
    const events: string[] = [];
    const { conn, statements } = recordingConnection({ events });

    const result = await withReadOnlyTransaction(conn, async () => {
      events.push("callback:start");
      await Promise.resolve();
      events.push("callback:end");
      return "snapshot";
    });

    assert.strictEqual(result, "snapshot");
    assert.deepStrictEqual(statements, [
      "BEGIN TRANSACTION READ ONLY",
      "COMMIT",
    ]);
    assert.deepStrictEqual(events, [
      "BEGIN TRANSACTION READ ONLY",
      "callback:start",
      "callback:end",
      "COMMIT",
    ]);
  });

  it("rolls back callback cancellation and preserves the original error", async () => {
    const { conn, statements } = recordingConnection();
    const cancellation = new Error("cancelled");
    cancellation.name = "AbortError";

    await assert.rejects(
      withReadOnlyTransaction(conn, async () => {
        throw cancellation;
      }),
      (err) => err === cancellation,
    );
    assert.deepStrictEqual(statements, [
      "BEGIN TRANSACTION READ ONLY",
      "ROLLBACK",
    ]);
  });

  it("rolls back a query failure inside the snapshot", async () => {
    const queryFailure = new Error("page failed");
    const { conn, statements } = recordingConnection({
      fail: new Map([["RETURN 1", queryFailure]]),
    });

    await assert.rejects(
      withReadOnlyTransaction(conn, async () => {
        await queryAll(conn, "RETURN 1");
      }),
      /Query execution failed: page failed/,
    );
    assert.deepStrictEqual(statements, [
      "BEGIN TRANSACTION READ ONLY",
      "RETURN 1",
      "ROLLBACK",
    ]);
  });

  it("rolls back a commit failure", async () => {
    const commitFailure = new Error("commit failed");
    const { conn, statements } = recordingConnection({
      fail: new Map([["COMMIT", commitFailure]]),
    });

    await assert.rejects(
      withReadOnlyTransaction(conn, async () => "done"),
      /Query execution failed: commit failed/,
    );
    assert.deepStrictEqual(statements, [
      "BEGIN TRANSACTION READ ONLY",
      "COMMIT",
      "ROLLBACK",
    ]);
  });

  it("preserves the original error when rollback also fails", async () => {
    const original = new Error("scan failed");
    const rollbackFailure = new Error("rollback failed");
    const { conn, statements } = recordingConnection({
      fail: new Map([["ROLLBACK", rollbackFailure]]),
    });

    await assert.rejects(
      withReadOnlyTransaction(conn, async () => {
        throw original;
      }),
      (err) => err === original,
    );
    assert.deepStrictEqual(statements, [
      "BEGIN TRANSACTION READ ONLY",
      "ROLLBACK",
    ]);
  });
});
