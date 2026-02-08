/**
 * Tests for test reference collection caching
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { collectTestRefs, clearTestRefCache } from "../dist/graph/metrics.js";
import type { RepoConfig } from "../dist/config/types.js";

describe("collectTestRefs Caching", () => {
  const testRepoRoot = join(tmpdir(), "test-collectTestRefs");
  const config: RepoConfig = {
    repoId: "test-repo",
    rootPath: testRepoRoot,
    languages: ["ts", "js"],
    ignore: ["node_modules"],
    maxFileBytes: 1024 * 1024,
  };

  const symbols = [
    { symbol_id: "sym1", name: "calculateFanMetrics" },
    { symbol_id: "sym2", name: "updateMetricsForRepo" },
    { symbol_id: "sym3", name: "nonexistentSymbol" },
  ];

  before(() => {
    mkdirSync(join(testRepoRoot, "tests"), { recursive: true });
  });

  after(() => {
    rmSync(testRepoRoot, { recursive: true, force: true });
    clearTestRefCache();
  });

  describe("Basic functionality", () => {
    it("should collect test references on first run", () => {
      writeFileSync(
        join(testRepoRoot, "tests", "test1.test.ts"),
        `
import { calculateFanMetrics } from "../src/graph/metrics";
import { updateMetricsForRepo } from "../src/graph/metrics";

describe("test1", () => {
  it("should work", () => {
    calculateFanMetrics([], new Set());
  });
});
`,
      );

      const result = collectTestRefs(testRepoRoot, symbols, config);

      assert.strictEqual(result.size, 2);
      assert(result.has("sym1"));
      assert(result.has("sym2"));
      assert(!result.has("sym3"));
    });

    it("should return empty map when no test files exist", () => {
      const emptyRepo = join(tmpdir(), "test-empty-repo");
      mkdirSync(emptyRepo, { recursive: true });
      try {
        const result = collectTestRefs(emptyRepo, symbols, config);
        assert.strictEqual(result.size, 0);
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });
  });

  describe("Cache invalidation", () => {
    it("should use cached results for unchanged files", () => {
      writeFileSync(
        join(testRepoRoot, "tests", "cache-test.test.ts"),
        `calculateFanMetrics([], new Set());`,
      );

      const result1 = collectTestRefs(testRepoRoot, symbols, config);
      const result2 = collectTestRefs(testRepoRoot, symbols, config);

      assert.deepStrictEqual(
        Array.from(result1.get("sym1") || []),
        Array.from(result2.get("sym1") || []),
      );
    });

    it("should re-scan modified files", () => {
      const testFile = join(testRepoRoot, "tests", "modified.test.ts");

      writeFileSync(testFile, `calculateFanMetrics([], new Set());`);

      const result1 = collectTestRefs(testRepoRoot, symbols, config);
      assert(result1.get("sym1")?.has("tests/modified.test.ts"));

      writeFileSync(testFile, `updateMetricsForRepo("repo-id");`);

      const result2 = collectTestRefs(testRepoRoot, symbols, config);
      assert(!result2.get("sym1")?.has("tests/modified.test.ts"));
      assert(result2.get("sym2")?.has("tests/modified.test.ts"));
    });

    it("should handle new files added between runs", () => {
      writeFileSync(
        join(testRepoRoot, "tests", "existing.test.ts"),
        `calculateFanMetrics([], new Set());`,
      );

      const result1 = collectTestRefs(testRepoRoot, symbols, config);
      assert(result1.get("sym1")?.has("tests/existing.test.ts"));

      writeFileSync(
        join(testRepoRoot, "tests", "new.test.ts"),
        `updateMetricsForRepo("repo");`,
      );

      const result2 = collectTestRefs(testRepoRoot, symbols, config);
      assert(result2.get("sym1")?.has("tests/existing.test.ts"));
      assert(result2.get("sym2")?.has("tests/new.test.ts"));
    });
  });

  describe("Cache clearing", () => {
    it("should clear cache for specific repo", () => {
      writeFileSync(
        join(testRepoRoot, "tests", "clear-specific.test.ts"),
        `calculateFanMetrics([], new Set());`,
      );

      collectTestRefs(testRepoRoot, symbols, config);
      clearTestRefCache(testRepoRoot);

      const result = collectTestRefs(testRepoRoot, symbols, config);
      assert(result.get("sym1")?.has("tests/clear-specific.test.ts"));
    });
  });

  describe("Multiple symbols per file", () => {
    it("should track all symbols referenced in a file", () => {
      writeFileSync(
        join(testRepoRoot, "tests", "multiple-symbols.test.ts"),
        `
calculateFanMetrics([], new Set());
updateMetricsForRepo("repo-id");
`,
      );

      const result = collectTestRefs(testRepoRoot, symbols, config);

      assert(result.get("sym1")?.has("tests/multiple-symbols.test.ts"));
      assert(result.get("sym2")?.has("tests/multiple-symbols.test.ts"));
    });
  });

  describe("File pattern matching", () => {
    it("should match *.test.ts files", () => {
      mkdirSync(join(testRepoRoot, "src"), { recursive: true });
      writeFileSync(
        join(testRepoRoot, "src", "component.test.ts"),
        `calculateFanMetrics([], new Set());`,
      );

      const result = collectTestRefs(testRepoRoot, symbols, config);
      assert(result.get("sym1")?.has("src/component.test.ts"));
    });

    it("should match *.spec.ts files", () => {
      mkdirSync(join(testRepoRoot, "src"), { recursive: true });
      writeFileSync(
        join(testRepoRoot, "src", "component.spec.ts"),
        `updateMetricsForRepo("repo");`,
      );

      const result = collectTestRefs(testRepoRoot, symbols, config);
      assert(result.get("sym2")?.has("src/component.spec.ts"));
    });
  });

  describe("Error handling", () => {
    it("should handle file read errors gracefully", () => {
      writeFileSync(
        join(testRepoRoot, "tests", "readable.test.ts"),
        `calculateFanMetrics([], new Set());`,
      );

      const result = collectTestRefs(testRepoRoot, symbols, config);
      assert(result.get("sym1")?.has("tests/readable.test.ts"));
    });
  });
});
