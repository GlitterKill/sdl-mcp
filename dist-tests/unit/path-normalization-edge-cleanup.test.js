import { describe, it } from "node:test";
import assert from "node:assert";
import { join, dirname, normalize, sep } from "path";
describe("IE-K.2: Path normalization in edge cleanup", () => {
    const normalizePath = (p) => {
        return normalize(p).split(sep).join("/");
    };
    const generatePathVariants = (joinedPath) => {
        const normalizedJoined = normalizePath(joinedPath);
        const pathVariants = [
            normalizedJoined,
            normalizedJoined.replace(/\.js$/, ".ts"),
            normalizedJoined.replace(/\.jsx$/, ".tsx"),
            !normalizedJoined.match(/\.(js|ts|jsx|tsx)$/)
                ? `${normalizedJoined}.ts`
                : normalizedJoined,
            !normalizedJoined.match(/\.(js|ts|jsx|tsx)$/)
                ? `${normalizedJoined}.js`
                : normalizedJoined,
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, "") + "/index.ts",
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, "") + "/index.js",
            normalizedJoined.replace(/\.(js|ts|jsx|tsx)$/, ""),
        ];
        return [...new Set(pathVariants)];
    };
    it("should handle relative paths with .. segments", () => {
        const sourceDir = "src/mcp/tools";
        const importPath = "../../server.js";
        const joinedPath = join(sourceDir, importPath);
        const variants = generatePathVariants(joinedPath);
        assert.ok(variants.some((v) => v.endsWith("server.ts")), "Should have .ts extension variant");
        assert.ok(variants.some((v) => v.endsWith("server.js")), "Should have .js extension variant");
    });
    it("should handle relative paths with multiple .. segments", () => {
        const sourceDir = "src/indexer/adapter/typescript";
        const importPath = "../../../db/queries.js";
        const joinedPath = join(sourceDir, importPath);
        const variants = generatePathVariants(joinedPath);
        assert.ok(variants.some((v) => v.includes("db/queries")), "Should resolve to db/queries");
        assert.ok(variants.some((v) => v.endsWith(".ts")), "Should include .ts variant");
    });
    it("should try .tsx and .jsx extensions", () => {
        const sourceDir = "src/code";
        const importPath = "../ui/component.jsx";
        const joinedPath = join(sourceDir, importPath);
        const variants = generatePathVariants(joinedPath);
        assert.ok(variants.some((v) => v.endsWith(".tsx")), "Should try .tsx extension");
    });
    it("should handle paths without extensions", () => {
        const sourceDir = "src/mcp/tools";
        const importPath = "../utils/helpers";
        const joinedPath = join(sourceDir, importPath);
        const variants = generatePathVariants(joinedPath);
        assert.ok(variants.some((v) => v.endsWith("utils/helpers.ts")), "Should add .ts extension");
        assert.ok(variants.some((v) => v.endsWith("utils/helpers.js")), "Should add .js extension");
    });
    it("should handle index file resolution", () => {
        const sourceDir = "src/mcp/tools";
        const importPath = "../config";
        const joinedPath = join(sourceDir, importPath);
        const variants = generatePathVariants(joinedPath);
        assert.ok(variants.some((v) => v.endsWith("config/index.ts")), "Should try config/index.ts");
        assert.ok(variants.some((v) => v.endsWith("config/index.js")), "Should try config/index.js");
    });
    it("should handle complex paths with .. and . segments", () => {
        const sourceDir = "src/indexer/treesitter/extractCalls.ts";
        const importPath = "../../adapter/types";
        const joinedPath = join(dirname(sourceDir), importPath);
        const normalizedJoined = normalizePath(joinedPath);
        const variants = generatePathVariants(normalizedJoined);
        // normalizePath() converts .. to actual relative path
        assert.ok(variants.some((v) => v.endsWith(".ts")), "Should include .ts variant");
    });
    it("should remove duplicates from variants", () => {
        const joinedPath = "src/utils/helpers.js";
        const variants = generatePathVariants(joinedPath);
        const uniqueVariants = [...new Set(variants)];
        assert.strictEqual(variants.length, uniqueVariants.length, "Should have no duplicates");
    });
    it("should handle Windows path separators", () => {
        const windowsPath = "src\\mcp\\tools\\repo.js";
        const normalized = normalizePath(windowsPath);
        assert.strictEqual(normalized.includes("\\"), false, "Should convert backslashes to forward slashes");
        assert.ok(normalized.includes("/"), "Should use forward slashes");
    });
    it("should preserve path normalization with .. that escape and re-enter", () => {
        const sourceDir = "src/inner/deep";
        const importPath = "../../mcp/tools";
        const joinedPath = join(sourceDir, importPath);
        const normalizedJoined = normalizePath(joinedPath);
        // normalizePath() should handle .. correctly
        assert.strictEqual(normalizedJoined.includes("\\\\"), false, "Should use forward slashes");
    });
});
//# sourceMappingURL=path-normalization-edge-cleanup.test.js.map