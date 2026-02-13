import { describe, it } from "node:test";
import assert from "node:assert";
import {
  BENCHMARK_SCOPE_IGNORE_PATTERNS,
  mergeBenchmarkIgnorePatterns,
} from "../../src/cli/commands/benchmark.ts";

describe("benchmark scope ignore patterns", () => {
  it("adds required benchmark scope excludes and keeps order stable", () => {
    const merged = mergeBenchmarkIgnorePatterns(["**/node_modules/**"]);

    assert.deepStrictEqual(merged, [
      "**/node_modules/**",
      ...BENCHMARK_SCOPE_IGNORE_PATTERNS,
    ]);
  });

  it("deduplicates required patterns when already present", () => {
    const merged = mergeBenchmarkIgnorePatterns([
      "**/node_modules/**",
      "**/tests/**",
      "**/*.test.ts",
    ]);

    assert.strictEqual(
      merged.filter((pattern) => pattern === "**/tests/**").length,
      1,
    );
    assert.strictEqual(
      merged.filter((pattern) => pattern === "**/*.test.ts").length,
      1,
    );
    assert.ok(merged.includes("**/dist-tests/**"));
    assert.ok(merged.includes("**/*.spec.ts"));
  });
});
