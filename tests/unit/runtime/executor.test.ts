import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildScrubbedEnv,
  createConcurrencyTracker,
  execute,
  killProcessTree,
  resolveAndValidateCwd,
} from "../../../src/runtime/executor.js";
import type { ExecutionRequest } from "../../../src/runtime/types.js";

function makeRequest(
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return {
    repoId: "repo-1",
    runtime: "node",
    executable: process.execPath,
    args: ["-e", "console.log('ok')"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 5000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
    ...overrides,
  };
}

describe("runtime executor", () => {
  it("executes command and captures stdout/stderr", async () => {
    const result = await execute(
      makeRequest({
        args: ["-e", "console.log('hello'); console.error('warn')"],
      }),
    );

    assert.equal(result.status, "success");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.toString("utf8"), /hello/);
    assert.match(result.stderr.toString("utf8"), /warn/);
    assert.equal(result.stdoutTruncated, false);
    assert.equal(result.stderrTruncated, false);
  });

  it("returns timeout status when process exceeds timeout", async () => {
    const result = await execute(
      makeRequest({
        args: ["-e", "setTimeout(() => {}, 30000)"],
        timeoutMs: 100,
      }),
    );

    assert.equal(result.status, "timeout");
    // Exit code after timeout is platform-dependent:
    // - null or 1 on Unix (SIGTERM/SIGKILL)
    // - 0 if taskkill is unavailable and the process completes naturally
    // The status field is the authoritative indicator for timeout.
    assert.ok(
      result.exitCode === null || result.exitCode === 0 || result.exitCode === 1,
      `Expected exitCode null, 0, or 1 after timeout, got ${result.exitCode}`,
    );
  });

  it("applies output limits and reports truncation", async () => {
    const result = await execute(
      makeRequest({
        args: [
          "-e",
          "process.stdout.write('A'.repeat(4000)); process.stderr.write('B'.repeat(3000));",
        ],
        maxStdoutBytes: 100,
        maxStderrBytes: 80,
      }),
    );

    assert.equal(result.status, "success");
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.ok(result.stdout.length <= 100);
    assert.ok(result.stderr.length <= 80);
    assert.ok(result.totalStdoutBytes >= 4000);
    assert.ok(result.totalStderrBytes >= 3000);
  });

  it("builds scrubbed env with only allowlisted values", () => {
    process.env.SDL_TEST_ALLOWED = "allowed";
    process.env.SDL_TEST_SECRET = "secret";

    try {
      const env = buildScrubbedEnv(["SDL_TEST_ALLOWED"]);
      assert.equal(env.SDL_TEST_ALLOWED, "allowed");
      assert.equal(env.SDL_TEST_SECRET, undefined);
      if (process.env.PATH) {
        assert.equal(env.PATH, process.env.PATH);
      }
    } finally {
      delete process.env.SDL_TEST_ALLOWED;
      delete process.env.SDL_TEST_SECRET;
    }
  });

  it("propagates spawn failures as failure results", async () => {
    const result = await execute(
      makeRequest({
        executable: "this-executable-does-not-exist",
        args: [],
      }),
    );

    assert.equal(result.status, "failure");
    assert.equal(result.exitCode, 1);
  });

  it("enforces cwd scope checks for runtime policy boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdl-runtime-root-"));
    const inside = join(root, "inside");
    await mkdir(inside, { recursive: true });

    try {
      const valid = await resolveAndValidateCwd(root, "inside");
      assert.equal(valid, await realpath(inside));

      await assert.rejects(() => resolveAndValidateCwd(root, ".."));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("accepts a cwd resolved from a symlinked repo root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sdl-runtime-root-"));
    const alias = join(await mkdtemp(join(tmpdir(), "sdl-runtime-alias-")), "repo-link");
    const inside = join(root, "inside");

    await mkdir(inside, { recursive: true });
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");

    try {
      const valid = await resolveAndValidateCwd(alias, "inside");
      assert.equal(valid, await realpath(inside));
    } finally {
      await rm(alias, { force: true, recursive: true });
      await rm(root, { force: true, recursive: true });
    }
  });

  it("killProcessTree is safe as best-effort cleanup", () => {
    assert.doesNotThrow(() => killProcessTree(999999));
  });

  it("tracks concurrency for policy checks", () => {
    const tracker = createConcurrencyTracker(2);

    assert.equal(tracker.activeCount, 0);
    assert.equal(tracker.acquire(), true);
    assert.equal(tracker.acquire(), true);
    assert.equal(tracker.acquire(), false);
    assert.equal(tracker.activeCount, 2);
    tracker.release();
    tracker.release();
    tracker.release();
    assert.equal(tracker.activeCount, 0);
  });
});
