import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for `resolveExecutionProviders` in embeddings-local.ts.
 *
 * The helper filters the user-supplied execution-provider list against
 * the platform's bundled providers in the default `onnxruntime-node`
 * package, drops unsupported entries with a warning, and auto-appends
 * `"cpu"` so session creation always has a viable fallback.
 *
 * Tests use the `platformOverride` parameter to simulate different
 * platforms without spawning a child process.
 */

const WIN32 = ["cpu", "dml", "webgpu"] as const;
const DARWIN = ["cpu", "coreml"] as const;
const LINUX_X64 = ["cpu", "cuda", "tensorrt"] as const;
const LINUX_ARM64 = ["cpu"] as const;

describe("resolveExecutionProviders", () => {
  it("preserves bundled providers in user order", async () => {
    const { resolveExecutionProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const result = resolveExecutionProviders(["dml", "cpu"], WIN32);
    assert.deepStrictEqual(result, ["dml", "cpu"]);
  });

  it("drops unsupported providers on Windows", async () => {
    const { resolveExecutionProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const result = resolveExecutionProviders(
      ["coreml", "cuda", "dml", "cpu"],
      WIN32,
    );
    // coreml + cuda are macOS / Linux providers; dropped on Windows.
    assert.deepStrictEqual(result, ["dml", "cpu"]);
  });

  it("drops unsupported providers on macOS", async () => {
    const { resolveExecutionProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const result = resolveExecutionProviders(
      ["dml", "cuda", "coreml", "cpu"],
      DARWIN,
    );
    assert.deepStrictEqual(result, ["coreml", "cpu"]);
  });

  it("drops unsupported providers on Linux x64", async () => {
    const { resolveExecutionProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const result = resolveExecutionProviders(
      ["dml", "coreml", "cuda", "tensorrt", "cpu"],
      LINUX_X64,
    );
    assert.deepStrictEqual(result, ["cuda", "tensorrt", "cpu"]);
  });

  it("returns just cpu on Linux arm64", async () => {
    const { resolveExecutionProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const result = resolveExecutionProviders(
      ["dml", "cuda", "coreml"],
      LINUX_ARM64,
    );
    // All bundled GPU providers dropped; cpu auto-appended as final fallback.
    assert.deepStrictEqual(result, ["cpu"]);
  });

  it("auto-appends cpu when not in user list", async () => {
    const { resolveExecutionProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const result = resolveExecutionProviders(["dml"], WIN32);
    assert.ok(result.includes("cpu"), "cpu must be auto-appended");
    assert.strictEqual(result[result.length - 1], "cpu", "cpu must be last");
  });

  it("does not duplicate cpu when user already provides it", async () => {
    const { resolveExecutionProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const result = resolveExecutionProviders(["cpu", "dml", "cpu"], WIN32);
    assert.strictEqual(
      result.filter((p) => p === "cpu").length,
      1,
      "cpu should appear exactly once after deduplication",
    );
  });

  it("deduplicates repeated supported providers", async () => {
    const { resolveExecutionProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const result = resolveExecutionProviders(["dml", "dml", "dml"], WIN32);
    assert.strictEqual(
      result.filter((p) => p === "dml").length,
      1,
      "dml should be deduplicated",
    );
  });

  it("lower-cases mixed-case input", async () => {
    const { resolveExecutionProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const result = resolveExecutionProviders(["DML", "CPU"], WIN32);
    assert.deepStrictEqual(result, ["dml", "cpu"]);
  });

  it("undefined input defaults to ['cpu']", async () => {
    const { resolveExecutionProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const result = resolveExecutionProviders(undefined, WIN32);
    assert.deepStrictEqual(result, ["cpu"]);
  });

  it("empty input still yields ['cpu']", async () => {
    const { resolveExecutionProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const result = resolveExecutionProviders([], WIN32);
    assert.deepStrictEqual(result, ["cpu"]);
  });
});

describe("platformAllowedProviders", () => {
  it("returns a non-empty list on every supported platform", async () => {
    const { platformAllowedProviders } =
      await import("../../dist/indexer/embeddings-local.js");
    const list = platformAllowedProviders();
    assert.ok(Array.isArray(list), "must return an array");
    assert.ok(list.length >= 1, "must include at least cpu");
    assert.ok(list.includes("cpu"), "cpu must always be present");
  });
});
