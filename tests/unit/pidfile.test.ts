import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  findExistingProcess,
  isProcessAlive,
  readPidfile,
  removePidfile,
  resolvePidfilePath,
  writePidfile,
} from "../../dist/util/pidfile.js";
import { PIDFILE_NAME } from "../../dist/config/constants.js";

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("pidfile", () => {
  let tempDir: string;
  let fakeDbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sdl-pidfile-"));
    fakeDbPath = join(tempDir, "sdl-mcp-graph.lbug");
    // Create a placeholder so dirname works
    writeFileSync(fakeDbPath, "");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("resolvePidfilePath", () => {
    it("places pidfile alongside graph DB file", () => {
      const pidPath = resolvePidfilePath(fakeDbPath);
      assert.strictEqual(pidPath, join(tempDir, PIDFILE_NAME));
    });
  });

  describe("isProcessAlive", () => {
    it("returns true for the current process", () => {
      assert.strictEqual(isProcessAlive(process.pid), true);
    });

    it("returns false for a non-existent PID", () => {
      // PID 999999 is extremely unlikely to exist
      assert.strictEqual(isProcessAlive(999999), false);
    });
  });

  describe("writePidfile / readPidfile", () => {
    it("writes and reads a stdio pidfile", () => {
      const path = writePidfile(fakeDbPath, "stdio");
      assert.ok(existsSync(path));

      const data = readPidfile(path);
      assert.ok(data);
      assert.strictEqual(data.pid, process.pid);
      assert.strictEqual(data.transport, "stdio");
      assert.strictEqual(data.port, undefined);
      assert.ok(data.startedAt);
    });

    it("writes and reads an http pidfile with port", () => {
      const path = writePidfile(fakeDbPath, "http", 3000);

      const data = readPidfile(path);
      assert.ok(data);
      assert.strictEqual(data.pid, process.pid);
      assert.strictEqual(data.transport, "http");
      assert.strictEqual(data.port, 3000);
    });

    it("returns null for non-existent pidfile", () => {
      const data = readPidfile(join(tempDir, "does-not-exist.pid"));
      assert.strictEqual(data, null);
    });

    it("returns null for malformed pidfile", () => {
      const pidPath = join(tempDir, PIDFILE_NAME);
      writeFileSync(pidPath, "not json");
      assert.strictEqual(readPidfile(pidPath), null);
    });

    it("returns null for pidfile missing required fields", () => {
      const pidPath = join(tempDir, PIDFILE_NAME);
      writeFileSync(pidPath, JSON.stringify({ pid: 123 }));
      assert.strictEqual(readPidfile(pidPath), null);
    });
  });

  describe("removePidfile", () => {
    it("removes an existing pidfile", () => {
      const path = writePidfile(fakeDbPath, "stdio");
      assert.ok(existsSync(path));
      removePidfile(path);
      assert.ok(!existsSync(path));
    });

    it("does not throw for non-existent file", () => {
      assert.doesNotThrow(() => removePidfile(join(tempDir, "nope.pid")));
    });
  });

  describe("findExistingProcess", () => {
    it("returns data for a live process", () => {
      writePidfile(fakeDbPath, "stdio");
      const result = findExistingProcess(fakeDbPath);
      assert.ok(result);
      assert.strictEqual(result.pid, process.pid);
    });

    it("returns null and cleans up stale pidfile", () => {
      // Write a pidfile with a dead PID
      const pidPath = resolvePidfilePath(fakeDbPath);
      writeFileSync(
        pidPath,
        JSON.stringify({
          pid: 999999,
          transport: "stdio",
          startedAt: new Date().toISOString(),
        }),
      );

      const result = findExistingProcess(fakeDbPath);
      assert.strictEqual(result, null);
      // Stale file should be cleaned up
      assert.ok(!existsSync(pidPath));
    });

    it("returns null when no pidfile exists", () => {
      const result = findExistingProcess(fakeDbPath);
      assert.strictEqual(result, null);
    });
  });

  describe("writePidfile conflict detection", () => {
    it("throws when another live process holds the pidfile", () => {
      // Find a PID that is definitely alive and is not our own process.
      // process.ppid (parent PID) is guaranteed to be alive while we run.
      const alivePid = process.ppid;
      const pidPath = resolvePidfilePath(fakeDbPath);
      writeFileSync(
        pidPath,
        JSON.stringify({
          pid: alivePid,
          transport: "stdio",
          startedAt: new Date().toISOString(),
        }),
      );

      assert.throws(
        () => writePidfile(fakeDbPath, "stdio"),
        /Another SDL-MCP server/,
      );
    });

    it("explains that conflicts are scoped to the database directory", () => {
      const alivePid = process.ppid;
      const pidPath = resolvePidfilePath(fakeDbPath);
      writeFileSync(
        pidPath,
        JSON.stringify({
          pid: alivePid,
          transport: "stdio",
          startedAt: new Date().toISOString(),
        }),
      );

      assert.throws(() => writePidfile(fakeDbPath, "stdio"), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /different directory/i);
        assert.match(error.message, /PID file/i);
        assert.match(error.message, new RegExp(escapeForRegex(pidPath)));
        return true;
      });
    });

    it("replaces stale pidfile from dead process", () => {
      const pidPath = resolvePidfilePath(fakeDbPath);
      writeFileSync(
        pidPath,
        JSON.stringify({
          pid: 999999,
          transport: "stdio",
          startedAt: new Date().toISOString(),
        }),
      );

      // Should not throw — dead process gets replaced
      assert.doesNotThrow(() => writePidfile(fakeDbPath, "stdio"));
      const data = readPidfile(pidPath);
      assert.ok(data);
      assert.strictEqual(data.pid, process.pid);
    });
  });

  describe("writePidfile EEXIST race (issue #19)", () => {
    it("two concurrent processes claiming the same pidfile: exactly one wins", async () => {
      const { spawn } = await import("node:child_process");
      const distPidfile = new URL("../../dist/util/pidfile.js", import.meta.url).pathname;
      // On Windows the URL.pathname has a leading slash before the drive letter.
      const pidfileModule = process.platform === "win32" && distPidfile.startsWith("/")
        ? distPidfile.slice(1)
        : distPidfile;

      const goFile = join(tempDir, "go");
      const readyA = join(tempDir, "ready-a");
      const readyB = join(tempDir, "ready-b");

      // Children write their ready-file, then poll for the parent's go-file.
      // The parent fires the go signal only after both children are ready, so
      // both processes hit writePidfile within the same scheduler tick — the
      // actual race we want to exercise.
      const driverFor = (readyFile: string) => `
        import { existsSync, writeFileSync } from "node:fs";
        import { writePidfile } from ${JSON.stringify("file:///" + pidfileModule.replace(/\\\\/g, "/"))};
        writeFileSync(${JSON.stringify(readyFile)}, String(process.pid), "utf8");
        const deadline = Date.now() + 10000;
        while (!existsSync(${JSON.stringify(goFile)})) {
          if (Date.now() > deadline) { console.error("go-file timeout"); process.exit(3); }
          await new Promise((r) => setTimeout(r, 1));
        }
        try {
          writePidfile(${JSON.stringify(fakeDbPath)}, "stdio");
          // Hold long enough that the loser cannot mistake us for stale.
          await new Promise((r) => setTimeout(r, 1500));
          process.exit(0);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(2);
        }
      `;

      const runOne = (readyFile: string) => new Promise<number>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", driverFor(readyFile)],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        child.on("exit", (code) => resolve(code ?? -1));
      });

      const childA = runOne(readyA);
      const childB = runOne(readyB);

      // Wait for both children to be ready, then release the barrier.
      const waitFor = async (path: string) => {
        const deadline = Date.now() + 10000;
        while (!existsSync(path)) {
          if (Date.now() > deadline) throw new Error(`child not ready: ${path}`);
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      await Promise.all([waitFor(readyA), waitFor(readyB)]);
      writeFileSync(goFile, "go", "utf8");

      const [a, b] = await Promise.all([childA, childB]);
      const codes = [a, b];
      const winners = codes.filter((c) => c === 0).length;
      const losers = codes.filter((c) => c === 2).length;
      assert.strictEqual(
        winners + losers,
        2,
        `unexpected exit codes (winners=${winners}, losers=${losers}): ${codes.join(",")}`,
      );
      assert.strictEqual(
        winners,
        1,
        `expected exactly one winner; got winners=${winners}, losers=${losers}, codes=${codes.join(",")}`,
      );
    });
  });
});
