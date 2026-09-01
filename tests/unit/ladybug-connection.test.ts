import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "node:os";
import type { Connection } from "kuzu";

import { withLadybugInitialization } from "../../dist/db/ladybug-operation-gate.js";

const testDbBase = join(tmpdir(), ".test-kuzu-db");

let getLadybugDb: (dbPath?: string) => Promise<unknown>;
let getLadybugConn: () => Promise<unknown>;
let closeLadybugDb: (options?: {
  preserveCloseHooks?: boolean;
  strict?: boolean;
}) => Promise<void>;
let registerDbCloseHook: (fn: () => void) => void;
let initLadybugDb: (dbPath: string) => Promise<void>;
let isLadybugAvailable: () => boolean;
let getLadybugDbPath: () => string | null;
let getReadPool: () => readonly Connection[];
let recycleReadConnection: (conn: Connection) => Promise<void>;
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
let runExclusive: <T>(conn: Connection, fn: () => Promise<T>) => Promise<T>;
let isConnStuck: (conn: Connection) => boolean;
let queryStoredProcAll: <T>(
  conn: Connection,
  statement: string,
) => Promise<T[]>;
let configureVectorQueryGuardForTesting: (options?: {
  deadlineMs: number;
  cooldownMs: number;
}) => void;
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
let DatabaseErrorClass: new (message: string) => Error;
let normalizePath: (p: string) => string;
let ladybugAvailable = false;

await import("../../dist/db/ladybug.js")
  .then((kuzu) => {
    getLadybugDb = kuzu.getLadybugDb;
    getLadybugConn = kuzu.getLadybugConn;
    closeLadybugDb = kuzu.closeLadybugDb;
    registerDbCloseHook = kuzu.registerDbCloseHook;
    initLadybugDb = kuzu.initLadybugDb;
    isLadybugAvailable = kuzu.isLadybugAvailable;
    getLadybugDbPath = kuzu.getLadybugDbPath;
    getReadPool = kuzu.getReadPool;
    recycleReadConnection = kuzu.recycleReadConnection;
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
    registerDbCloseHook = () => {};
    initLadybugDb = async () => {
      throw new Error("Module not built");
    };
    isLadybugAvailable = () => false;
    getLadybugDbPath = () => null;
    getReadPool = () => [];
    recycleReadConnection = async () => {};
    withExclusiveReadConnection = async () => {
      throw new Error("Module not built");
    };
  });

await import("../../dist/db/ladybug-core.js")
  .then((core) => {
    withReadOnlyTransaction = core.withReadOnlyTransaction;
    queryAll = core.queryAll;
    runExclusive = core.runExclusive;
    isConnStuck = core.isConnStuck;
    queryStoredProcAll = core.queryStoredProcAll;
    configureVectorQueryGuardForTesting =
      core._configureVectorQueryGuardForTesting;
  })
  .catch(() => {
    withReadOnlyTransaction = async () => {
      throw new Error("Module not built");
    };
    queryAll = async () => {
      throw new Error("Module not built");
    };
    runExclusive = async () => {
      throw new Error("Module not built");
    };
    isConnStuck = () => false;
    queryStoredProcAll = async () => {
      throw new Error("Module not built");
    };
    configureVectorQueryGuardForTesting = () => {};
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
  rmSync(dbPath + ".sdl-lineage.json", { recursive: true, force: true });
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
    it("waits for lazy native initialization before reporting the database open", async (t) => {
      const testPath = getTestDbPath("lazy-init-order");
      cleanupTestDb("lazy-init-order");

      const kuzu = await import("kuzu");
      const { logger } = await import("../../dist/util/logger.js");
      const initGate = deferred();
      const initMock = t.mock.method(
        kuzu.Database.prototype,
        "init",
        async () => {
          await initGate.promise;
        },
      );
      t.mock.method(kuzu.Database.prototype, "close", async () => {});
      const infoMock = t.mock.method(logger, "info");

      let settled = false;
      const opening = getLadybugDb(testPath).then((db) => {
        settled = true;
        return db;
      });

      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.strictEqual(initMock.mock.callCount(), 1);
        assert.strictEqual(settled, false);
        assert.strictEqual(infoMock.mock.callCount(), 0);

        initGate.resolve();
        await opening;

        assert.strictEqual(settled, true);
        assert.strictEqual(infoMock.mock.callCount(), 1);
        assert.strictEqual(
          infoMock.mock.calls[0]?.arguments[0],
          "LadybugDB database opened",
        );
      } finally {
        initGate.resolve();
        await opening.catch(() => {});
        await closeLadybugDb();
        cleanupTestDb("lazy-init-order");
      }
    });

    it("fences later opens while close waits for lazy initialization", async (t) => {
      const testPath = getTestDbPath("lazy-init-close-fence");
      const competingPath = getTestDbPath("lazy-init-close-fence-competing");
      cleanupTestDb("lazy-init-close-fence");
      cleanupTestDb("lazy-init-close-fence-competing");

      const kuzu = await import("kuzu");
      const initEntered = deferred();
      const releaseInit = deferred();
      t.mock.method(kuzu.Database.prototype, "init", async () => {
        initEntered.resolve();
        await releaseInit.promise;
      });
      t.mock.method(kuzu.Database.prototype, "close", async () => {});

      const opening = getLadybugDb(testPath);
      await initEntered.promise;
      let closeSettled = false;
      const close = closeLadybugDb().then(() => {
        closeSettled = true;
      });

      const competingOpen = getLadybugDb(competingPath);
      const competingInit = initLadybugDb(competingPath);
      const observe = (operation: Promise<unknown>): Promise<string> =>
        Promise.race([
          operation.then(
            () => "fulfilled",
            (error: unknown) =>
              error instanceof Error && /LadybugDB is closing/.test(error.message)
                ? "rejected-closing"
                : "rejected-other",
          ),
          new Promise<string>((resolve) =>
            setImmediate(() => resolve("pending")),
          ),
        ]);

      try {
        assert.deepStrictEqual(
          await Promise.all([observe(competingOpen), observe(competingInit)]),
          ["rejected-closing", "rejected-closing"],
        );
        assert.strictEqual(closeSettled, false);

        releaseInit.resolve();
        await Promise.all([opening, close]);
        assert.strictEqual(closeSettled, true);
        await assert.rejects(getLadybugDb(), /LadybugDB is closed/);
      } finally {
        releaseInit.resolve();
        await Promise.allSettled([
          opening,
          close,
          competingOpen,
          competingInit,
        ]);
        await closeLadybugDb();
        cleanupTestDb("lazy-init-close-fence");
        cleanupTestDb("lazy-init-close-fence-competing");
      }
    });

    it("fails closed without an open log when lazy native initialization rejects", async (t) => {
      const testPath = getTestDbPath("lazy-init-failure");
      cleanupTestDb("lazy-init-failure");

      const kuzu = await import("kuzu");
      const { logger } = await import("../../dist/util/logger.js");
      const initFailure = new Error("WAL corrupted sentinel");
      t.mock.method(kuzu.Database.prototype, "init", async () => {
        throw initFailure;
      });
      t.mock.method(kuzu.Database.prototype, "close", async () => {});
      const infoMock = t.mock.method(logger, "info");

      try {
        await assert.rejects(
          getLadybugDb(testPath),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /preserve/i);
            assert.match(error.message, /--safe-rebuild/u);
            assert.doesNotMatch(error.message, /delete the database/i);
            return true;
          },
        );
        assert.strictEqual(infoMock.mock.callCount(), 0);
        assert.strictEqual(getLadybugDbPath(), null);
      } finally {
        await closeLadybugDb();
        cleanupTestDb("lazy-init-failure");
      }
    });


    it("retains family ownership when failed initialization cannot close its native handle", async (t) => {
      const testPath = getTestDbPath("lazy-init-close-failure");
      const competingPath = getTestDbPath("lazy-init-close-failure-competing");
      cleanupTestDb("lazy-init-close-failure");
      cleanupTestDb("lazy-init-close-failure-competing");

      const kuzu = await import("kuzu");
      const initFailure = new Error("init-failure-sentinel");
      const closeFailure = new Error("init-close-failure-sentinel");
      t.mock.method(kuzu.Database.prototype, "init", async () => {
        throw initFailure;
      });
      let closeCalls = 0;
      t.mock.method(kuzu.Database.prototype, "close", async () => {
        closeCalls += 1;
        if (closeCalls === 1) throw closeFailure;
      });

      try {
        await assert.rejects(getLadybugDb(testPath), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /init-failure-sentinel/);
          assert.match(error.message, /init-close-failure-sentinel/);
          return true;
        });
        await assert.rejects(
          getLadybugDb(competingPath),
          /LadybugDB is closing|native ownership|close retry|family lease/iu,
        );
        assert.strictEqual(closeCalls, 1);

        await closeLadybugDb({ strict: true });
        assert.strictEqual(closeCalls, 2);
        assert.strictEqual(getLadybugDbPath(), null);
      } finally {
        await closeLadybugDb().catch(() => {});
        cleanupTestDb("lazy-init-close-failure");
        cleanupTestDb("lazy-init-close-failure-competing");
      }
    });

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

    it("fails fast instead of reusing a pool whose connections are all stuck", async () => {
      const testPath = getTestDbPath("all-read-connections-stuck");
      cleanupTestDb("all-read-connections-stuck");
      await initLadybugDb(testPath);
      await getLadybugConn();

      const previousWatchdog = process.env.SDL_STUCK_TASK_WARN_MS;
      process.env.SDL_STUCK_TASK_WARN_MS = "20";
      const release = deferred();
      const pending = getReadPool().map((conn) =>
        runExclusive(conn, () => release.promise),
      );

      try {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (getReadPool().every(isConnStuck)) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(getReadPool().every(isConnStuck));
        await assert.rejects(getLadybugConn(), /all read connections are stuck/i);
      } finally {
        release.resolve();
        await Promise.all(pending);
        if (previousWatchdog === undefined) {
          delete process.env.SDL_STUCK_TASK_WARN_MS;
        } else {
          process.env.SDL_STUCK_TASK_WARN_MS = previousWatchdog;
        }
        await closeLadybugDb();
        cleanupTestDb("all-read-connections-stuck");
      }
    });

    it("routes checkout around a vector connection as soon as its deadline expires", async (t) => {
      const testPath = getTestDbPath("vector-timeout-read-routing");
      cleanupTestDb("vector-timeout-read-routing");
      await initLadybugDb(testPath);
      await getLadybugConn();

      const pool = getReadPool();
      const timedOutConn = pool[0];
      const started = deferred();
      const release = deferred();
      configureVectorQueryGuardForTesting({
        deadlineMs: 20,
        cooldownMs: 1_000,
      });
      t.mock.method(timedOutConn, "query", async () => {
        started.resolve();
        await release.promise;
        return {
          getAll: async () => [],
          close: () => {},
        };
      });

      try {
        const timeoutAssertion = assert.rejects(
          queryStoredProcAll(
            timedOutConn,
            "CALL QUERY_VECTOR_INDEX('Symbol', 'symbol_vec', [0.1], 1) RETURN node, distance",
          ),
          /deadline exceeded/i,
        );
        await started.promise;
        await timeoutAssertion;
        assert.equal(isConnStuck(timedOutConn), true);

        for (let attempt = 0; attempt < pool.length * 2; attempt += 1) {
          assert.notStrictEqual(await getLadybugConn(), timedOutConn);
        }
      } finally {
        release.resolve();
        for (
          let attempt = 0;
          attempt < 20 && isConnStuck(timedOutConn);
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        configureVectorQueryGuardForTesting();
        await closeLadybugDb();
        cleanupTestDb("vector-timeout-read-routing");
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

    it("retains unpublished pool handles when initialization cleanup fails", async (t) => {
      const testPath = getTestDbPath("pool-init-close-retry");
      cleanupTestDb("pool-init-close-retry");
      await getLadybugDb(testPath);

      const kuzu = await import("kuzu");
      const prototype = kuzu.Connection.prototype;
      const originalSetThreads = prototype.setMaxNumThreadForExec;
      const originalClose = prototype.close;
      const constructed: Connection[] = [];
      const closeAttempts = new Map<Connection, number>();
      const setupFailure = new Error("pool-setup-failure-sentinel");

      t.mock.method(
        prototype,
        "setMaxNumThreadForExec",
        async function (this: Connection, threads: number) {
          constructed.push(this);
          if (constructed.length === 3) throw setupFailure;
          await originalSetThreads.call(this, threads);
        },
      );
      t.mock.method(prototype, "close", async function (this: Connection) {
        const attempts = (closeAttempts.get(this) ?? 0) + 1;
        closeAttempts.set(this, attempts);
        if (this === constructed[0] && attempts === 1) {
          throw new Error("pool-cleanup-close-failure-sentinel");
        }
        await originalClose.call(this);
      });

      try {
        await assert.rejects(getLadybugConn(), /pool-setup-failure-sentinel/);
        assert.strictEqual(closeAttempts.get(constructed[0]), 1);

        await closeLadybugDb({ strict: true });
        assert.strictEqual(closeAttempts.get(constructed[0]), 2);
        assert.strictEqual(getLadybugDbPath(), null);
      } finally {
        await closeLadybugDb().catch(() => {});
        cleanupTestDb("pool-init-close-retry");
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

    it("does not consume a round-robin pool slot while an exclusive lease is active", async () => {
      const testPath = getTestDbPath("exclusive-read-concurrent-pool");
      cleanupTestDb("exclusive-read-concurrent-pool");
      await initLadybugDb(testPath);

      const entered = deferred();
      const release = deferred();
      let leased: Connection | undefined;
      const lease = withExclusiveReadConnection(async (conn) => {
        leased = conn;
        entered.resolve();
        await release.promise;
      });

      try {
        await Promise.race([entered.promise, lease]);
        const pooled = (await getLadybugConn()) as Connection;
        assert.ok(getReadPool().includes(pooled));
        assert.notStrictEqual(pooled, leased);
      } finally {
        release.resolve();
        await lease;
        await closeLadybugDb();
        cleanupTestDb("exclusive-read-concurrent-pool");
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

    it("rejects a successful callback when its exclusive connection fails to close", async () => {
      const testPath = getTestDbPath("exclusive-read-close-failure");
      cleanupTestDb("exclusive-read-close-failure");
      await initLadybugDb(testPath);

      const closeFailure = new Error("exclusive close failed");
      const kuzu = await import("kuzu");
      const prototype = kuzu.Connection.prototype;
      const originalClose = prototype.close;
      prototype.close = async function () {
        throw closeFailure;
      };

      try {
        await assert.rejects(
          withExclusiveReadConnection(async () => "complete"),
          (error) => error === closeFailure,
        );
      } finally {
        prototype.close = originalClose;
        await closeLadybugDb();
        cleanupTestDb("exclusive-read-close-failure");
      }
    });

    it("preserves callback failure and blocks publication on strict close", async () => {
      const testPath = getTestDbPath("exclusive-read-dual-failure");
      cleanupTestDb("exclusive-read-dual-failure");
      await initLadybugDb(testPath);

      const callbackFailure = new Error("context read failed");
      const closeFailure = new Error("exclusive close failed");
      const kuzu = await import("kuzu");
      const prototype = kuzu.Connection.prototype;
      const originalClose = prototype.close;
      let leased: Connection | undefined;
      let leasedCloseCalls = 0;
      let failLeasedClose = true;
      prototype.close = async function () {
        if (this === leased) {
          leasedCloseCalls += 1;
          if (failLeasedClose) throw closeFailure;
        }
        await originalClose.call(this);
      };

      try {
        await assert.rejects(
          withExclusiveReadConnection(async (conn) => {
            leased = conn;
            throw callbackFailure;
          }),
          (error) => error === callbackFailure,
        );
        assert.equal(leasedCloseCalls, 1);
        failLeasedClose = false;

        let artifactPublished = false;
        await assert.rejects(
          closeLadybugDb({ strict: true }).then(() => {
            artifactPublished = true;
          }),
          (error) => {
            assert.ok(error instanceof AggregateError);
            assert.ok(error.errors.includes(closeFailure));
            return true;
          },
        );
        assert.strictEqual(artifactPublished, false);
        assert.equal(leasedCloseCalls, 2);
      } finally {
        prototype.close = originalClose;
        await closeLadybugDb();
        cleanupTestDb("exclusive-read-dual-failure");
      }
    });

    it("closes a constructed connection when thread setup fails", async () => {
      const testPath = getTestDbPath("exclusive-read-thread-setup-failure");
      cleanupTestDb("exclusive-read-thread-setup-failure");
      await initLadybugDb(testPath);

      const setupFailure = new Error("thread setup failed");
      const kuzu = await import("kuzu");
      const prototype = kuzu.Connection.prototype;
      const originalThreadSetter = prototype.setMaxNumThreadForExec;
      const originalClose = prototype.close;
      let constructed: Connection | undefined;
      const closed = new Set<Connection>();
      const closeAttempts = new Map<Connection, number>();
      let closeShouldFail = false;
      prototype.setMaxNumThreadForExec = async function () {
        constructed = this;
        throw setupFailure;
      };
      prototype.close = async function () {
        closed.add(this);
        closeAttempts.set(this, (closeAttempts.get(this) ?? 0) + 1);
        if (closeShouldFail) throw new Error("close failed");
        await originalClose.call(this);
      };

      try {
        await assert.rejects(
          withExclusiveReadConnection(async () => {
            assert.fail("callback must not run after connection setup fails");
          }),
          (err) => err === setupFailure,
        );
        assert.ok(constructed);
        assert.ok(closed.has(constructed));

        closeShouldFail = true;
        constructed = undefined;
        await assert.rejects(
          withExclusiveReadConnection(async () => {
            assert.fail("callback must not run after connection setup fails");
          }),
          (err) => err === setupFailure,
        );
        assert.ok(constructed);
        assert.ok(closed.has(constructed));
        assert.equal(closeAttempts.get(constructed), 1);

        closeShouldFail = false;
        await closeLadybugDb({ strict: true });
        assert.equal(closeAttempts.get(constructed), 2);
      } finally {
        prototype.setMaxNumThreadForExec = originalThreadSetter;
        prototype.close = originalClose;
        if (constructed && closeAttempts.get(constructed) === 1) {
          await originalClose.call(constructed);
        }
        await closeLadybugDb();
        cleanupTestDb("exclusive-read-thread-setup-failure");
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
      let closeCompleted = false;
      let closeRequest: Promise<void> | undefined;
      let closeObserved: Promise<void> | undefined;

      try {
        await Promise.race([entered.promise, lease]);
        closeRequest = closeLadybugDb();
        closeObserved = closeRequest.then(() => {
          closeCompleted = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.strictEqual(closeCompleted, false);
        await assert.rejects(
          withExclusiveReadConnection(async () => {}),
          /LadybugDB is closing/,
        );

        release.resolve();
        await Promise.all([lease, closeRequest, closeObserved]);
        assert.strictEqual(getLadybugDbPath(), null);
      } finally {
        release.resolve();
        const pending = [lease];
        if (closeRequest) pending.push(closeRequest);
        if (closeObserved) pending.push(closeObserved);
        await Promise.allSettled(pending);
        await closeLadybugDb();
        cleanupTestDb("exclusive-read-close");
      }
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


    it("retains family ownership until a failed native database close is retried successfully", async (t) => {
      const testPath = getTestDbPath("native-close-retry");
      const competingPath = getTestDbPath("native-close-retry-competing");
      cleanupTestDb("native-close-retry");
      cleanupTestDb("native-close-retry-competing");
      await initLadybugDb(testPath);

      const ownedPath = getLadybugDbPath();

      const kuzu = await import("kuzu");
      const originalClose = kuzu.Database.prototype.close;
      const closeFailure = new Error("native-database-close-failure-sentinel");
      let closeCalls = 0;
      t.mock.method(kuzu.Database.prototype, "close", async function () {
        closeCalls += 1;
        if (closeCalls === 1) throw closeFailure;
        return originalClose.call(this);
      });

      try {
        await closeLadybugDb();
        assert.strictEqual(getLadybugDbPath(), ownedPath);
        await assert.rejects(
          getLadybugDb(competingPath),
          /LadybugDB is closing|native ownership|close retry|family lease/iu,
        );
        assert.strictEqual(closeCalls, 1);

        await closeLadybugDb({ strict: true });
        assert.strictEqual(closeCalls, 2);
        assert.strictEqual(getLadybugDbPath(), null);
      } finally {
        await closeLadybugDb().catch(() => {});
        cleanupTestDb("native-close-retry");
        cleanupTestDb("native-close-retry-competing");
      }
    });

    it("requires callers to await close before switching database paths", async () => {
      const sourcePath = getTestDbPath("path-switch-source");
      const targetPath = getTestDbPath("path-switch-target");
      cleanupTestDb("path-switch-source");
      cleanupTestDb("path-switch-target");
      await initLadybugDb(sourcePath);
      const sourceOwnedPath = getLadybugDbPath();

      try {
        await assert.rejects(
          getLadybugDb(targetPath),
          /await closeLadybugDb/u,
        );
        assert.strictEqual(getLadybugDbPath(), sourceOwnedPath);
        assert.equal(existsSync(targetPath), false);
        assert.equal(existsSync(targetPath + ".sdl-family.lock"), false);

        await closeLadybugDb({ strict: true });
        await getLadybugDb(targetPath);
        assert.notStrictEqual(getLadybugDbPath(), sourceOwnedPath);
      } finally {
        await closeLadybugDb().catch(() => {});
        cleanupTestDb("path-switch-source");
        cleanupTestDb("path-switch-target");
      }
    });

    it("retains an unhealthy read handle until strict close retries it", async (t) => {
      const sourcePath = getTestDbPath("read-recovery-close-retry");
      const targetPath = getTestDbPath("read-recovery-close-retry-target");
      cleanupTestDb("read-recovery-close-retry");
      cleanupTestDb("read-recovery-close-retry-target");
      await initLadybugDb(sourcePath);
      const unhealthy = (await getLadybugConn()) as Connection;

      const kuzu = await import("kuzu");
      const originalClose = kuzu.Connection.prototype.close;
      let unhealthyCloseCalls = 0;
      t.mock.method(kuzu.Connection.prototype, "close", async function () {
        if (this === unhealthy) {
          unhealthyCloseCalls += 1;
          if (unhealthyCloseCalls === 1) {
            throw new Error("unhealthy-read-close-failure");
          }
        }
        return originalClose.call(this);
      });

      try {
        await recycleReadConnection(unhealthy);
        assert.equal(unhealthyCloseCalls, 1);
        await assert.rejects(
          getLadybugDb(targetPath),
          /native ownership|close retry/iu,
        );
        await closeLadybugDb({ strict: true });
        assert.equal(unhealthyCloseCalls, 2);
      } finally {
        await closeLadybugDb().catch(() => {});
        cleanupTestDb("read-recovery-close-retry");
        cleanupTestDb("read-recovery-close-retry-target");
      }
    });

    it("strict close-hook failure resets state and leaves the family stale", async () => {
      const testPath = getTestDbPath("strict-close-hook-failure");
      cleanupTestDb("strict-close-hook-failure");
      await initLadybugDb(testPath);
      const hookFailure = new Error("strict-close-hook-failure");
      registerDbCloseHook(() => {
        throw hookFailure;
      });

      try {
        await assert.rejects(
          closeLadybugDb({ strict: true }),
          (error: unknown) =>
            error instanceof AggregateError &&
            error.errors.includes(hookFailure),
        );
        assert.strictEqual(getLadybugDbPath(), null);

        await assert.rejects(
          initLadybugDb(testPath),
          /lineage marker is missing[\s\S]*--safe-rebuild/iu,
        );
      } finally {
        await closeLadybugDb();
        cleanupTestDb("strict-close-hook-failure");
      }
    });

    it("clears close hooks when either concurrent caller requests it", async () => {
      for (const [firstPreserves, secondPreserves] of [
        [true, false],
        [false, true],
      ] as const) {
        const name = `concurrent-close-${String(firstPreserves)}-${String(secondPreserves)}`;
        const testPath = getTestDbPath(name);
        cleanupTestDb(name);
        await initLadybugDb(testPath);

        let hookCalls = 0;
        registerDbCloseHook(() => {
          hookCalls += 1;
        });
        const entered = deferred();
        const release = deferred();
        const lease = withExclusiveReadConnection(async () => {
          entered.resolve();
          await release.promise;
        });
        let closeCompleted = false;
        let firstClose: Promise<void> | undefined;
        let firstCloseObserved: Promise<void> | undefined;
        let secondClose: Promise<void> | undefined;

        try {
          await Promise.race([entered.promise, lease]);
          firstClose = closeLadybugDb({
            preserveCloseHooks: firstPreserves,
          });
          firstCloseObserved = firstClose.then(() => {
            closeCompleted = true;
          });
          secondClose = closeLadybugDb({
            preserveCloseHooks: secondPreserves,
          });

          assert.strictEqual(firstClose, secondClose);
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.strictEqual(closeCompleted, false);

          release.resolve();
          await Promise.all([
            lease,
            firstClose,
            firstCloseObserved,
            secondClose,
          ]);
          assert.strictEqual(hookCalls, 1);

          await initLadybugDb(testPath);
          await closeLadybugDb();
          assert.strictEqual(hookCalls, 1);
        } finally {
          release.resolve();
          const pending = [lease];
          if (firstClose) pending.push(firstClose);
          if (firstCloseObserved) pending.push(firstCloseObserved);
          if (secondClose) pending.push(secondClose);
          await Promise.allSettled(pending);
          await closeLadybugDb();
          cleanupTestDb(name);
        }
      }
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
  beforeEach(async () => {
    await withLadybugInitialization(async () => {});
  });

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

  it("propagates begin failure without invoking the callback or cleanup statements", async () => {
    const beginFailure = new Error("begin failed");
    const { conn, statements } = recordingConnection({
      fail: new Map([["BEGIN TRANSACTION READ ONLY", beginFailure]]),
    });
    let callbackCalled = false;

    await assert.rejects(
      withReadOnlyTransaction(conn, async () => {
        callbackCalled = true;
      }),
      /Query execution failed: begin failed/,
    );
    assert.strictEqual(callbackCalled, false);
    assert.deepStrictEqual(statements, ["BEGIN TRANSACTION READ ONLY"]);
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
