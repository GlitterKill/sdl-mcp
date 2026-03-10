import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const testDir = dirname(fileURLToPath(import.meta.url));
const testDbBase = join(testDir, "..", "..", ".test-kuzu-db");

let getLadybugDb: (dbPath?: string) => Promise<unknown>;
let getLadybugConn: () => Promise<unknown>;
let closeLadybugDb: () => Promise<void>;
let initLadybugDb: (dbPath: string) => Promise<void>;
let isLadybugAvailable: () => boolean;
let getLadybugDbPath: () => string | null;
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
