import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readFileAsync,
  statAsync,
  existsAsync,
  createAsyncFsOperations,
} from "../../dist/util/asyncFs.js";

const TEST_DIR = join(tmpdir(), `sdl-mcp-async-fs-test-${Date.now()}`);
const TEST_FILE = join(TEST_DIR, "test-file.txt");
const TEST_CONTENT = "hello world\nline two\n";
const MISSING_FILE = join(TEST_DIR, "does-not-exist.txt");

describe("asyncFs utilities", () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(TEST_FILE, TEST_CONTENT, "utf-8");
  });

  after(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe("readFileAsync", () => {
    it("reads an existing file with default encoding", async () => {
      const content = await readFileAsync(TEST_FILE);
      assert.strictEqual(content, TEST_CONTENT);
    });

    it("reads with explicit utf-8 encoding", async () => {
      const content = await readFileAsync(TEST_FILE, "utf-8");
      assert.strictEqual(content, TEST_CONTENT);
    });

    it("rejects for a missing file", async () => {
      await assert.rejects(
        () => readFileAsync(MISSING_FILE),
        (err: NodeJS.ErrnoException) => {
          assert.strictEqual(err.code, "ENOENT");
          return true;
        },
      );
    });
  });

  describe("statAsync", () => {
    it("returns stats for an existing file", async () => {
      const stats = await statAsync(TEST_FILE);
      assert.ok(stats.isFile(), "should identify as a file");
      assert.ok(stats.size > 0, "file size should be positive");
    });

    it("returns correct file size", async () => {
      const stats = await statAsync(TEST_FILE);
      assert.strictEqual(stats.size, Buffer.byteLength(TEST_CONTENT, "utf-8"));
    });

    it("rejects for a missing file", async () => {
      await assert.rejects(
        () => statAsync(MISSING_FILE),
        (err: NodeJS.ErrnoException) => {
          assert.strictEqual(err.code, "ENOENT");
          return true;
        },
      );
    });
  });

  describe("existsAsync", () => {
    it("returns true for an existing file", async () => {
      const result = await existsAsync(TEST_FILE);
      assert.strictEqual(result, true);
    });

    it("returns true for an existing directory", async () => {
      const result = await existsAsync(TEST_DIR);
      assert.strictEqual(result, true);
    });

    it("returns false for a missing file", async () => {
      const result = await existsAsync(MISSING_FILE);
      assert.strictEqual(result, false);
    });

    it("returns false for a non-existent directory", async () => {
      const result = await existsAsync(join(TEST_DIR, "no-such-dir"));
      assert.strictEqual(result, false);
    });
  });

  describe("createAsyncFsOperations", () => {
    it("creates an instance with default config", () => {
      const ops = createAsyncFsOperations();
      assert.ok(ops, "should create an instance");
      assert.ok(typeof ops.readFile === "function");
      assert.ok(typeof ops.stat === "function");
      assert.ok(typeof ops.exists === "function");
    });

    it("creates an instance with custom concurrency config", () => {
      const ops = createAsyncFsOperations({
        maxConcurrentReads: 2,
        maxConcurrentStats: 2,
      });
      assert.ok(ops, "should create an instance with custom config");
    });

    it("instance reads files correctly", async () => {
      const ops = createAsyncFsOperations();
      const content = await ops.readFile(TEST_FILE);
      assert.strictEqual(content, TEST_CONTENT);
    });

    it("instance stat works correctly", async () => {
      const ops = createAsyncFsOperations();
      const stats = await ops.stat(TEST_FILE);
      assert.ok(stats.isFile());
    });

    it("instance exists works correctly", async () => {
      const ops = createAsyncFsOperations();
      assert.strictEqual(await ops.exists(TEST_FILE), true);
      assert.strictEqual(await ops.exists(MISSING_FILE), false);
    });
  });
});
