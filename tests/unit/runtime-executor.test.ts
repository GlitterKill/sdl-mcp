import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  buildScrubbedEnv,
  createConcurrencyTracker,
  execute,
} from "../../dist/runtime/executor.js";
import type { ExecutionRequest } from "../../dist/runtime/types.js";

// ============================================================================
// buildScrubbedEnv
// ============================================================================

describe("buildScrubbedEnv", () => {
  it("should include PATH", () => {
    const env = buildScrubbedEnv([]);
    if (process.env.PATH) {
      assert.strictEqual(env.PATH, process.env.PATH);
    }
  });

  it("should include platform-specific home and temp vars", () => {
    const env = buildScrubbedEnv([]);
    if (process.platform === "win32") {
      if (process.env.USERPROFILE) {
        assert.strictEqual(env.USERPROFILE, process.env.USERPROFILE);
      }
      if (process.env.TEMP) {
        assert.strictEqual(env.TEMP, process.env.TEMP);
      }
    } else {
      if (process.env.HOME) {
        assert.strictEqual(env.HOME, process.env.HOME);
      }
      if (process.env.TMPDIR) {
        assert.strictEqual(env.TMPDIR, process.env.TMPDIR);
      }
    }
  });

  it("should pass through allowlisted keys", () => {
    // Set a test env var then allowlist it
    process.env.__SDL_TEST_ALLOWED_KEY = "hello";
    try {
      const env = buildScrubbedEnv(["__SDL_TEST_ALLOWED_KEY"]);
      assert.strictEqual(env.__SDL_TEST_ALLOWED_KEY, "hello");
    } finally {
      delete process.env.__SDL_TEST_ALLOWED_KEY;
    }
  });

  it("should NOT leak non-allowlisted keys", () => {
    process.env.__SDL_TEST_SECRET = "should-not-appear";
    try {
      const env = buildScrubbedEnv([]);
      assert.strictEqual(env.__SDL_TEST_SECRET, undefined);
    } finally {
      delete process.env.__SDL_TEST_SECRET;
    }
  });
});

// ============================================================================
// createConcurrencyTracker
// ============================================================================

describe("createConcurrencyTracker", () => {
  it("should start at 0 active count", () => {
    const tracker = createConcurrencyTracker(3);
    assert.strictEqual(tracker.activeCount, 0);
  });

  it("should increment on acquire and return true", () => {
    const tracker = createConcurrencyTracker(3);
    const acquired = tracker.acquire();
    assert.strictEqual(acquired, true);
    assert.strictEqual(tracker.activeCount, 1);
  });

  it("should return false when at max capacity", () => {
    const tracker = createConcurrencyTracker(2);
    tracker.acquire();
    tracker.acquire();
    const acquired = tracker.acquire();
    assert.strictEqual(acquired, false);
    assert.strictEqual(tracker.activeCount, 2);
  });

  it("should decrement on release", () => {
    const tracker = createConcurrencyTracker(3);
    tracker.acquire();
    tracker.acquire();
    tracker.release();
    assert.strictEqual(tracker.activeCount, 1);
  });

  it("should not go below 0 on extra release", () => {
    const tracker = createConcurrencyTracker(3);
    tracker.release();
    assert.strictEqual(tracker.activeCount, 0);
  });
});

// ============================================================================
// execute
// ============================================================================

describe("execute", () => {
  function makeRequest(
    overrides: Partial<ExecutionRequest> = {},
  ): ExecutionRequest {
    return {
      repoId: "test-repo",
      runtime: "node",
      executable: "node",
      args: ["-e", 'console.log("hello")'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
      ...overrides,
    };
  }

  it("should capture stdout from node process", async () => {
    const result = await execute(
      makeRequest({
        args: ["-e", 'console.log("hello-sdl")'],
      }),
    );

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.toString("utf-8").includes("hello-sdl"));
    assert.strictEqual(result.stdoutTruncated, false);
  });

  it("should capture stderr from node process", async () => {
    const result = await execute(
      makeRequest({
        args: ["-e", 'console.error("oops-sdl")'],
      }),
    );

    assert.strictEqual(result.status, "success");
    assert.ok(result.stderr.toString("utf-8").includes("oops-sdl"));
  });

  it("should return failure status for non-zero exit code", async () => {
    const result = await execute(
      makeRequest({
        args: ["-e", "process.exit(42)"],
      }),
    );

    assert.strictEqual(result.status, "failure");
    assert.strictEqual(result.exitCode, 42);
  });

  it("should return timeout status when process exceeds timeoutMs", async () => {
    const result = await execute(
      makeRequest({
        args: ["-e", "setTimeout(() => {}, 30000)"],
        timeoutMs: 200,
      }),
    );

    assert.strictEqual(result.status, "timeout");
    assert.ok(
      result.durationMs >= 100,
      `Expected at least 100ms, got ${result.durationMs}`,
    );
  });

  it("should truncate stdout when exceeding maxStdoutBytes", async () => {
    // Generate 10KB of output but limit to 100 bytes
    const result = await execute(
      makeRequest({
        args: ["-e", 'process.stdout.write("A".repeat(10000))'],
        maxStdoutBytes: 100,
      }),
    );

    assert.ok(result.stdoutTruncated, "Expected stdout to be truncated");
    assert.ok(
      result.stdout.length <= 100,
      `Expected <= 100 bytes, got ${result.stdout.length}`,
    );
    assert.ok(
      result.totalStdoutBytes >= 10000,
      `Expected totalStdoutBytes >= 10000, got ${result.totalStdoutBytes}`,
    );
  });

  it("should truncate stderr when exceeding maxStderrBytes", async () => {
    const result = await execute(
      makeRequest({
        args: ["-e", 'process.stderr.write("B".repeat(10000))'],
        maxStderrBytes: 100,
      }),
    );

    assert.ok(result.stderrTruncated, "Expected stderr to be truncated");
    assert.ok(
      result.stderr.length <= 100,
      `Expected <= 100 bytes, got ${result.stderr.length}`,
    );
  });

  it("should report durationMs", async () => {
    const result = await execute(
      makeRequest({
        args: ["-e", 'console.log("fast")'],
      }),
    );

    assert.strictEqual(result.status, "success");
    assert.ok(typeof result.durationMs === "number");
    assert.ok(result.durationMs >= 0);
  });

  it("should handle cancelled execution via AbortSignal", async () => {
    const controller = new AbortController();

    // Abort after 100ms
    setTimeout(() => controller.abort(), 100);

    const result = await execute(
      makeRequest({
        args: ["-e", "setTimeout(() => {}, 30000)"],
        timeoutMs: 30_000,
        signal: controller.signal,
      }),
    );

    assert.strictEqual(result.status, "cancelled");
  });
});
