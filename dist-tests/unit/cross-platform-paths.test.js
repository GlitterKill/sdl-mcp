import { describe, it } from "node:test";
import assert from "node:assert";
import { normalizePath, getRelativePath, safeJoin, getAbsolutePathFromRepoRoot, } from "../../dist/util/paths.js";
describe("Cross-Platform Path Utilities", () => {
    describe("normalizePath", () => {
        it("should convert Windows backslashes to forward slashes", () => {
            const windowsPath = "src\\indexer\\adapter\\c.js";
            const normalized = normalizePath(windowsPath);
            assert.strictEqual(normalized, "src/indexer/adapter/c.js");
        });
        it("should keep forward slashes unchanged", () => {
            const unixPath = "src/indexer/adapter/c.js";
            const normalized = normalizePath(unixPath);
            assert.strictEqual(normalized, "src/indexer/adapter/c.js");
        });
        it("should handle mixed path separators", () => {
            const mixedPath = "src\\indexer/adapter\\c.js";
            const normalized = normalizePath(mixedPath);
            assert.strictEqual(normalized, "src/indexer/adapter/c.js");
        });
        it("should handle empty string", () => {
            // path.normalize returns "." for empty string
            assert.strictEqual(normalizePath(""), ".");
        });
        it("should handle single-component paths", () => {
            assert.strictEqual(normalizePath("file.js"), "file.js");
        });
    });
    describe("getRelativePath", () => {
        it("should calculate relative path on Unix-style paths", () => {
            const from = "/home/user/project/src";
            const to = "/home/user/project/tests/fixtures";
            const result = getRelativePath(from, to);
            assert.strictEqual(result, "../tests/fixtures");
        });
        it("should normalize result to use forward slashes", () => {
            const from = "C:\\Users\\user\\project\\src";
            const to = "C:\\Users\\user\\project\\tests\\fixtures";
            const result = getRelativePath(from, to);
            assert.ok(!result.includes("\\"), "Result should not contain backslashes");
            assert.strictEqual(result, "../tests/fixtures");
        });
        it("should handle same directory", () => {
            const from = "/home/user/project/src";
            const to = "/home/user/project/src";
            const result = getRelativePath(from, to);
            assert.ok(result === "." || result === "", "Same directory should return '.' or empty string");
        });
        it("should handle parent directory", () => {
            const from = "/home/user/project/src/indexer";
            const to = "/home/user/project";
            const result = getRelativePath(from, to);
            assert.strictEqual(result, "../..");
        });
    });
    describe("safeJoin", () => {
        it("should join path components and normalize separators", () => {
            const result = safeJoin("src", "indexer", "adapter");
            assert.strictEqual(result, "src/indexer/adapter");
        });
        it("should handle mixed separators in components", () => {
            const result = safeJoin("src\\indexer", "adapter/c.js");
            assert.strictEqual(result, "src/indexer/adapter/c.js");
        });
        it("should handle absolute paths (keep them absolute)", () => {
            const result = safeJoin("/home/user/project", "src");
            assert.ok(result.startsWith("/"), "Absolute path should remain absolute");
        });
        it("should handle Windows absolute paths", () => {
            const result = safeJoin("C:\\Users\\user\\project", "src");
            assert.ok(result.match(/^[A-Za-z]:/), "Windows drive letter preserved");
            assert.ok(!result.includes("\\"), "Path should use forward slashes");
        });
        it("should normalize dot segments", () => {
            const result = safeJoin("src", "..", "tests");
            assert.strictEqual(result, "tests");
        });
    });
    describe("getAbsolutePathFromRepoRoot", () => {
        it("should join repo root with relative path", () => {
            const repoRoot = "/home/user/project";
            const relPath = "src/indexer/adapter/c.js";
            const result = getAbsolutePathFromRepoRoot(repoRoot, relPath);
            // On Windows, path.resolve prepends current drive to Unix-style absolute paths
            const isWindows = process.platform === "win32";
            if (isWindows) {
                assert.ok(result.endsWith("/home/user/project/src/indexer/adapter/c.js"));
            }
            else {
                assert.strictEqual(result, "/home/user/project/src/indexer/adapter/c.js");
            }
        });
        it("should normalize Windows paths", () => {
            const repoRoot = "C:\\Users\\user\\project";
            const relPath = "src\\indexer\\adapter\\c.js";
            const result = getAbsolutePathFromRepoRoot(repoRoot, relPath);
            assert.ok(result.match(/^[A-Za-z]:/), "Windows drive letter preserved");
            assert.ok(!result.includes("\\"), "Path should use forward slashes");
        });
        it("should handle mixed separators", () => {
            const repoRoot = "/home/user/project";
            const relPath = "src\\indexer/adapter\\c.js";
            const result = getAbsolutePathFromRepoRoot(repoRoot, relPath);
            assert.ok(!result.includes("\\"), "Path should use forward slashes");
        });
    });
    describe("Real-world Path Scenarios", () => {
        it("should handle file paths with Windows backslashes", () => {
            const filePath = "tests\\fixtures\\c\\symbols.c";
            const normalized = normalizePath(filePath);
            assert.strictEqual(normalized, "tests/fixtures/c/symbols.c");
        });
        it("should handle relative import paths with backslashes", () => {
            const importPath = "..\\..\\utils\\helpers.js";
            const normalized = normalizePath(importPath);
            assert.strictEqual(normalized, "../../utils/helpers.js");
        });
        it("should handle Windows network paths", () => {
            const networkPath = "\\\\server\\share\\project\\src\\index.ts";
            const normalized = normalizePath(networkPath);
            assert.strictEqual(normalized, "//server/share/project/src/index.ts");
        });
        it("should calculate path between two files on Windows", () => {
            const from = "C:\\project\\src\\indexer\\adapter\\c.js";
            const to = "C:\\project\\tests\\fixtures\\c\\symbols.c";
            const result = getRelativePath(from, to);
            assert.ok(!result.includes("\\"), "Result should use forward slashes");
            assert.ok(result.startsWith("../"));
        });
        it("should handle deeply nested paths", () => {
            const path = "src\\indexer\\adapter\\treesitter\\extractors\\symbol-extractor.js";
            const normalized = normalizePath(path);
            assert.strictEqual(normalized, "src/indexer/adapter/treesitter/extractors/symbol-extractor.js");
        });
        it("should handle paths with spaces", () => {
            const path = "src\\my folder\\file.js";
            const normalized = normalizePath(path);
            assert.strictEqual(normalized, "src/my folder/file.js");
        });
    });
    describe("Cross-Platform Consistency", () => {
        it("should produce same normalized path from different OS inputs", () => {
            const windowsPath = "src\\indexer\\adapter\\c.js";
            const unixPath = "src/indexer/adapter/c.js";
            const windowsNormalized = normalizePath(windowsPath);
            const unixNormalized = normalizePath(unixPath);
            assert.strictEqual(windowsNormalized, unixNormalized, "Normalization should be OS-agnostic");
        });
        it("should produce same relative path regardless of input format", () => {
            const from = "src/indexer";
            const to = "tests/fixtures";
            const result1 = getRelativePath(from, to);
            const result2 = getRelativePath(from.replace(/\//g, "\\"), to.replace(/\//g, "\\"));
            assert.strictEqual(result1, result2, "Relative path calculation should be OS-agnostic");
        });
        it("should handle empty relative path correctly", () => {
            const result = safeJoin();
            assert.strictEqual(result, ".");
        });
    });
    describe("Edge Cases", () => {
        it("should handle trailing slashes", () => {
            const path = "src/indexer/";
            const normalized = normalizePath(path);
            assert.ok(normalized === "src/indexer" || normalized === "src/indexer/");
        });
        it("should handle leading slashes in relative paths", () => {
            const path = "/src/indexer/adapter";
            const normalized = normalizePath(path);
            assert.strictEqual(normalized, "/src/indexer/adapter");
        });
        it("should handle multiple consecutive slashes", () => {
            const p = "src//indexer///adapter";
            const normalized = normalizePath(p);
            // path.normalize collapses multiple slashes
            assert.strictEqual(normalized, "src/indexer/adapter");
        });
        it("should handle current directory references", () => {
            const p = "./src/indexer/adapter";
            const normalized = normalizePath(p);
            // path.normalize resolves ./ references
            assert.strictEqual(normalized, "src/indexer/adapter");
        });
        it("should handle parent directory references in middle of path", () => {
            const p = "src/../indexer/adapter";
            const normalized = normalizePath(p);
            // path.normalize resolves ../ references
            assert.strictEqual(normalized, "indexer/adapter");
        });
    });
});
//# sourceMappingURL=cross-platform-paths.test.js.map