import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const testDir = dirname(fileURLToPath(import.meta.url));
const testDbBase = join(testDir, "..", "..", ".test-kuzu-db");

let getKuzuDb: (dbPath?: string) => Promise<unknown>;
let getKuzuConn: () => Promise<unknown>;
let closeKuzuDb: () => Promise<void>;
let initKuzuDb: (dbPath: string) => Promise<void>;
let isKuzuAvailable: () => boolean;
let getKuzuDbPath: () => string | null;
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
let DatabaseErrorClass: new (message: string) => Error;
let normalizePath: (p: string) => string;
let kuzuAvailable = false;

await import("../../dist/db/kuzu.js")
  .then((kuzu) => {
    getKuzuDb = kuzu.getKuzuDb;
    getKuzuConn = kuzu.getKuzuConn;
    closeKuzuDb = kuzu.closeKuzuDb;
    initKuzuDb = kuzu.initKuzuDb;
    isKuzuAvailable = kuzu.isKuzuAvailable;
    getKuzuDbPath = kuzu.getKuzuDbPath;
    kuzuAvailable = true;
  })
  .catch(() => {
    getKuzuDb = async () => {
      throw new Error("Module not built");
    };
    getKuzuConn = async () => {
      throw new Error("Module not built");
    };
    closeKuzuDb = async () => {};
    initKuzuDb = async () => {
      throw new Error("Module not built");
    };
    isKuzuAvailable = () => false;
    getKuzuDbPath = () => null;
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

describe("KuzuDB Connection Manager", { skip: !kuzuAvailable }, () => {
  beforeEach(async () => {
    await closeKuzuDb();
  });

  afterEach(async () => {
    await closeKuzuDb();
  });

  describe("getKuzuDb", () => {
    it("should return singleton Database instance", async () => {
      const testPath = getTestDbPath("singleton");
      cleanupTestDb("singleton");

      try {
        const db1 = await getKuzuDb(testPath);
        const db2 = await getKuzuDb(testPath);

        assert.strictEqual(db1, db2, "Should return the same instance");
      } finally {
        await closeKuzuDb();
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

        await getKuzuDb(testPath);

        assert.ok(existsSync(testPath), "Parent directory should be created");
      } finally {
        await closeKuzuDb();
        cleanupTestDb("create-dir");
      }
    });

    it("should normalize Windows paths to forward slashes", async () => {
      const testPath = getTestDbPath("windows-path") + "\\subdir";
      const expected = normalizePath(join(testPath, "sdl-mcp-graph.kuzu"));
      cleanupTestDb("windows-path");

      try {
        await getKuzuDb(testPath);

        const actualPath = getKuzuDbPath();
        assert.strictEqual(actualPath, expected);
      } finally {
        await closeKuzuDb();
        cleanupTestDb("windows-path");
      }
    });
  });

  describe("getKuzuConn", () => {
    it("should return singleton Connection instance", async () => {
      const testPath = getTestDbPath("conn-singleton");
      cleanupTestDb("conn-singleton");

      try {
        await getKuzuDb(testPath);
        const conn1 = await getKuzuConn();
        const conn2 = await getKuzuConn();

        assert.strictEqual(conn1, conn2, "Should return the same connection");
      } finally {
        await closeKuzuDb();
        cleanupTestDb("conn-singleton");
      }
    });
  });

  describe("closeKuzuDb", () => {
    it("should close database and reset state", async () => {
      const testPath = getTestDbPath("close-test");
      cleanupTestDb("close-test");

      try {
        await getKuzuDb(testPath);
        assert.ok(getKuzuDbPath() !== null, "Path should be set");

        await closeKuzuDb();

        assert.strictEqual(
          getKuzuDbPath(),
          null,
          "Path should be null after close",
        );
      } finally {
        await closeKuzuDb();
        cleanupTestDb("close-test");
      }
    });

    it("should be safe to call multiple times", async () => {
      await closeKuzuDb();
      await closeKuzuDb();
      await closeKuzuDb();
    });
  });

  describe("initKuzuDb", () => {
    it("should initialize database with schema", async () => {
      const testPath = getTestDbPath("init-schema");
      cleanupTestDb("init-schema");

      try {
        await initKuzuDb(testPath);

        const actualPath = getKuzuDbPath();
        assert.ok(actualPath, "Database path should be set");
        assert.ok(existsSync(actualPath), "Database file should exist");

        const conn = await getKuzuConn();
        assert.ok(conn, "Connection should be available after init");
      } finally {
        await closeKuzuDb();
        cleanupTestDb("init-schema");
      }
    });
  });

  describe("isKuzuAvailable", () => {
    it("should return boolean", () => {
      const result = isKuzuAvailable();
      assert.strictEqual(typeof result, "boolean");
    });
  });

  describe("getKuzuDbPath", () => {
    it("should return null when not initialized", async () => {
      await closeKuzuDb();
      assert.strictEqual(getKuzuDbPath(), null);
    });
  });

  describe("path normalization", () => {
    it("should handle Windows backslashes", async () => {
      const testPath = getTestDbPath("path-norm") + "\\subdir";
      cleanupTestDb("path-norm");

      try {
        await getKuzuDb(testPath);

        const storedPath = getKuzuDbPath();
        assert.ok(storedPath?.includes("/"), "Path should use forward slashes");
        assert.ok(
          !storedPath?.includes("\\"),
          "Path should not contain backslashes",
        );
      } finally {
        await closeKuzuDb();
        cleanupTestDb("path-norm");
      }
    });
  });
});
