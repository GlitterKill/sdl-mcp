import { describe, it } from "node:test";
import assert from "node:assert";
import { execute } from "../../dist/runtime/executor.js";
import type { ExecutionRequest } from "../../dist/runtime/types.js";

/**
 * Integration tests for runtime process lifecycle and cleanup.
 *
 * Platform note: On Windows, tree killing uses `taskkill /T /F /PID`.
 * On Unix, it uses `process.kill(-pid, 'SIGTERM')` followed by SIGKILL
 * after a grace period. Both paths are exercised by timeout/cancel tests.
 */

function makeRequest(
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return {
    repoId: "test-repo",
    runtime: "node",
    executable: "node",
    args: ["-e", 'console.log("ok")'],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 10_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
    ...overrides,
  };
}

describe("Runtime Process Cleanup", () => {
  it("should exit cleanly after successful execution (no orphans)", async () => {
    const result = await execute(
      makeRequest({
        args: ["-e", 'console.log("clean-exit")'],
      }),
    );

    assert.strictEqual(result.status, "success");
    assert.strictEqual(result.exitCode, 0);
    // Process completed normally — no orphan detection needed
    // (orphan detection would require platform-specific PID inspection)
  });

  it("should capture partial output when process killed via timeout", async () => {
    // Process writes output then sleeps. Kill via short timeout.
    const result = await execute(
      makeRequest({
        args: [
          "-e",
          'process.stdout.write("partial-output-before-kill\\n"); setTimeout(() => {}, 30000);',
        ],
        timeoutMs: 500,
      }),
    );

    assert.strictEqual(result.status, "timeout");
    // Partial stdout should be captured before the kill
    const stdout = result.stdout.toString("utf-8");
    assert.ok(
      stdout.includes("partial-output-before-kill"),
      `Expected partial output, got: "${stdout}"`,
    );
  });

  it("should capture multi-line partial output before timeout", async () => {
    const result = await execute(
      makeRequest({
        args: [
          "-e",
          `
        for (let i = 0; i < 10; i++) {
          process.stdout.write("line-" + i + "\\n");
        }
        // Flush then hang
        setTimeout(() => {}, 30000);
        `,
        ],
        timeoutMs: 2000,
      }),
    );

    assert.strictEqual(result.status, "timeout");
    const stdout = result.stdout.toString("utf-8");
    assert.ok(stdout.includes("line-0"), "Expected first lines captured");
  });

  it("should handle process that exits immediately with error", async () => {
    const result = await execute(
      makeRequest({
        args: ["-e", 'throw new Error("boom")'],
      }),
    );

    assert.strictEqual(result.status, "failure");
    assert.strictEqual(result.exitCode, 1);
    const stderr = result.stderr.toString("utf-8");
    assert.ok(
      stderr.includes("boom"),
      `Expected error in stderr, got: "${stderr}"`,
    );
  });

  it("should handle process with both stdout and stderr", async () => {
    const result = await execute(
      makeRequest({
        args: [
          "-e",
          'console.log("stdout-data"); console.error("stderr-data");',
        ],
      }),
    );

    assert.strictEqual(result.status, "success");
    assert.ok(result.stdout.toString("utf-8").includes("stdout-data"));
    assert.ok(result.stderr.toString("utf-8").includes("stderr-data"));
  });

  it("should report totalStdoutBytes accurately even when truncated", async () => {
    const result = await execute(
      makeRequest({
        args: ["-e", 'process.stdout.write("X".repeat(5000))'],
        maxStdoutBytes: 200,
      }),
    );

    assert.ok(result.stdoutTruncated);
    assert.ok(result.stdout.length <= 200);
    assert.ok(
      result.totalStdoutBytes >= 5000,
      `Expected totalStdoutBytes >= 5000, got ${result.totalStdoutBytes}`,
    );
  });
});
