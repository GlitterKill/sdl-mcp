import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

/**
 * Tests for `maybeCleanupGeneratedScipIndex` and `hasCustomOutputArg` in
 * `src/scip/cleanup.ts`.
 *
 * The cleanup helper is the post-ingest deletion of
 * `<repoRoot>/index.scip` produced by scip-io. It runs when both
 * `generator.enabled` and `generator.cleanupAfterIngest` are true and
 * the user hasn't passed `--output` (custom path → user-managed).
 */

const REPO_ROOT = "/test/repo";
const EXPECTED_PATH = join(REPO_ROOT, "index.scip");

function recordingUnlink(): {
  fn: (path: string) => Promise<void>;
  calls: string[];
  setError: (err: NodeJS.ErrnoException) => void;
} {
  const calls: string[] = [];
  let nextErr: NodeJS.ErrnoException | null = null;
  return {
    calls,
    setError: (err) => {
      nextErr = err;
    },
    fn: async (path: string) => {
      calls.push(path);
      if (nextErr) {
        const e = nextErr;
        nextErr = null;
        throw e;
      }
    },
  };
}

describe("hasCustomOutputArg", () => {
  it("matches the bare --output flag", async () => {
    const { hasCustomOutputArg } = await import("../../dist/scip/cleanup.js");
    assert.strictEqual(hasCustomOutputArg(["--output", "foo.scip"]), true);
  });

  it("matches the short -o flag", async () => {
    const { hasCustomOutputArg } = await import("../../dist/scip/cleanup.js");
    assert.strictEqual(hasCustomOutputArg(["-o", "foo.scip"]), true);
  });

  it("matches --output= equals form", async () => {
    const { hasCustomOutputArg } = await import("../../dist/scip/cleanup.js");
    assert.strictEqual(hasCustomOutputArg(["--output=foo.scip"]), true);
  });

  it("returns false on empty args", async () => {
    const { hasCustomOutputArg } = await import("../../dist/scip/cleanup.js");
    assert.strictEqual(hasCustomOutputArg([]), false);
  });

  it("returns false on unrelated args", async () => {
    const { hasCustomOutputArg } = await import("../../dist/scip/cleanup.js");
    assert.strictEqual(hasCustomOutputArg(["--no-clean", "--verbose"]), false);
  });
});

describe("maybeCleanupGeneratedScipIndex — gating", () => {
  it("skips when generator is disabled", async () => {
    const { maybeCleanupGeneratedScipIndex } =
      await import("../../dist/scip/cleanup.js");
    const recorder = recordingUnlink();
    const result = await maybeCleanupGeneratedScipIndex({
      generatorEnabled: false,
      cleanupAfterIngest: true,
      args: [],
      repoRootPath: REPO_ROOT,
      unlinkFn: recorder.fn,
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "generator-disabled");
    assert.strictEqual(recorder.calls.length, 0);
  });

  it("skips when cleanup is disabled", async () => {
    const { maybeCleanupGeneratedScipIndex } =
      await import("../../dist/scip/cleanup.js");
    const recorder = recordingUnlink();
    const result = await maybeCleanupGeneratedScipIndex({
      generatorEnabled: true,
      cleanupAfterIngest: false,
      args: [],
      repoRootPath: REPO_ROOT,
      unlinkFn: recorder.fn,
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "cleanup-disabled");
    assert.strictEqual(recorder.calls.length, 0);
  });

  it("skips when args contain --output", async () => {
    const { maybeCleanupGeneratedScipIndex } =
      await import("../../dist/scip/cleanup.js");
    const recorder = recordingUnlink();
    const result = await maybeCleanupGeneratedScipIndex({
      generatorEnabled: true,
      cleanupAfterIngest: true,
      args: ["--output", "custom/index.scip"],
      repoRootPath: REPO_ROOT,
      unlinkFn: recorder.fn,
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "custom-output");
    assert.strictEqual(recorder.calls.length, 0);
  });

  it("skips when args contain --output=path", async () => {
    const { maybeCleanupGeneratedScipIndex } =
      await import("../../dist/scip/cleanup.js");
    const recorder = recordingUnlink();
    const result = await maybeCleanupGeneratedScipIndex({
      generatorEnabled: true,
      cleanupAfterIngest: true,
      args: ["--output=custom/index.scip"],
      repoRootPath: REPO_ROOT,
      unlinkFn: recorder.fn,
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, "custom-output");
    assert.strictEqual(recorder.calls.length, 0);
  });
});

describe("maybeCleanupGeneratedScipIndex — happy path", () => {
  it("unlinks <repoRoot>/index.scip when all gates pass", async () => {
    const { maybeCleanupGeneratedScipIndex } =
      await import("../../dist/scip/cleanup.js");
    const recorder = recordingUnlink();
    const result = await maybeCleanupGeneratedScipIndex({
      generatorEnabled: true,
      cleanupAfterIngest: true,
      args: [],
      repoRootPath: REPO_ROOT,
      unlinkFn: recorder.fn,
    });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.unlinked, true);
    assert.strictEqual(recorder.calls.length, 1);
    assert.strictEqual(recorder.calls[0], EXPECTED_PATH);
  });
});

describe("maybeCleanupGeneratedScipIndex — error handling", () => {
  it("treats ENOENT as success without warning", async () => {
    const { maybeCleanupGeneratedScipIndex } =
      await import("../../dist/scip/cleanup.js");
    const recorder = recordingUnlink();
    const enoent: NodeJS.ErrnoException = Object.assign(
      new Error("file not found"),
      { code: "ENOENT" },
    );
    recorder.setError(enoent);
    const result = await maybeCleanupGeneratedScipIndex({
      generatorEnabled: true,
      cleanupAfterIngest: true,
      args: [],
      repoRootPath: REPO_ROOT,
      unlinkFn: recorder.fn,
    });
    // ENOENT is fine — file was already gone.
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.unlinked, false);
  });

  it("logs and swallows EACCES (non-fatal)", async () => {
    const { maybeCleanupGeneratedScipIndex } =
      await import("../../dist/scip/cleanup.js");
    const recorder = recordingUnlink();
    const eacces: NodeJS.ErrnoException = Object.assign(
      new Error("permission denied"),
      { code: "EACCES" },
    );
    recorder.setError(eacces);
    // Must not throw — the cleanup is best-effort.
    await assert.doesNotReject(
      async () =>
        await maybeCleanupGeneratedScipIndex({
          generatorEnabled: true,
          cleanupAfterIngest: true,
          args: [],
          repoRootPath: REPO_ROOT,
          unlinkFn: recorder.fn,
        }),
    );
  });
});
