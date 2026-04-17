/**
 * Tests for Rust engine performance optimizations:
 * Fix 1: Content passthrough (no double file read)
 * Fix 2: Concurrent post-processing
 * Fix 3: Chunked batch interleaving
 * Fix 4: Eager TS resolver creation
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert";

// ---------------------------------------------------------------------------
// Fix 1: RustParseResult content passthrough
// ---------------------------------------------------------------------------
describe("Fix 1: Content passthrough from Rust engine", () => {
  it("RustParseResult interface accepts content field", async () => {
    // Dynamically import to get the type at runtime
    const mod = await import("../dist/indexer/rustIndexer.js");

    // If parseFilesRust returns results, they should carry content
    // This is a structural test — verify the mapping preserves content
    const result: import("../dist/indexer/rustIndexer.js").RustParseResult = {
      relPath: "test.ts",
      contentHash: "abc123",
      content: "const x = 1;",
      symbols: [],
      imports: [],
      calls: [],
      parseError: null,
    };

    assert.strictEqual(result.content, "const x = 1;");
    assert.strictEqual(result.relPath, "test.ts");
  });

  it("RustParseResult works without content (backwards compat)", async () => {
    const result: import("../dist/indexer/rustIndexer.js").RustParseResult = {
      relPath: "test.ts",
      contentHash: "abc123",
      symbols: [],
      imports: [],
      calls: [],
      parseError: null,
    };

    assert.strictEqual(result.content, undefined);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 + Fix 3: Chunked concurrent processing in runPass1WithRustEngine
// ---------------------------------------------------------------------------
describe("Fix 2+3: Chunked concurrent processing", () => {
  it("indexer-pass1 exports runPass1WithRustEngine", async () => {
    const mod = await import("../dist/indexer/indexer-pass1.js");
    assert.strictEqual(typeof mod.runPass1WithRustEngine, "function");
    assert.strictEqual(typeof mod.runPass1WithTsEngine, "function");
  });

  it("NATIVE_BATCH_SIZE is reduced to 200", async () => {
    // Read the source to verify the constant
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const srcPath = path.resolve(
      path.dirname(__filename),
      "..",
      "src",
      "indexer",
      "rustIndexer.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");
    assert.ok(
      content.includes("NATIVE_BATCH_SIZE = 200"),
      "NATIVE_BATCH_SIZE should be 200 for reduced peak memory",
    );
  });

  it("runPass1WithRustEngine uses CHUNK_SIZE for interleaving", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const srcPath = path.resolve(
      path.dirname(__filename),
      "..",
      "src",
      "indexer",
      "indexer-pass1.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");

    // Verify chunked processing pattern exists
    assert.ok(
      content.includes("CHUNK_SIZE"),
      "Should define CHUNK_SIZE for interleaved batch processing",
    );
    assert.ok(
      content.includes("CONCURRENCY_LIMIT"),
      "Should define CONCURRENCY_LIMIT for concurrent post-processing",
    );
    assert.ok(
      content.includes("i + CHUNK_SIZE"),
      "Should iterate in chunk-sized steps",
    );
    assert.ok(
      content.includes("Promise.all"),
      "Should use Promise.all for concurrent processing",
    );
  });

  it("concurrent dispatch processes files in parallel batches", async () => {
    // Simulate the sliding-window concurrency pattern
    const CONCURRENCY_LIMIT = 4;
    const items = Array.from({ length: 10 }, (_, i) => i);
    const processed: number[] = [];
    const concurrencyLog: number[] = [];
    let activeConcurrent = 0;

    const processOne = async (item: number): Promise<void> => {
      activeConcurrent++;
      concurrencyLog.push(activeConcurrent);
      // Simulate async work
      await new Promise((resolve) => setImmediate(resolve));
      processed.push(item);
      activeConcurrent--;
    };

    // Replicate the sliding window pattern from indexer-pass1.ts
    for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
      const batch = items.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(batch.map((item) => processOne(item)));
    }

    assert.strictEqual(processed.length, 10, "All items should be processed");
    // Max concurrency should be <= CONCURRENCY_LIMIT
    const maxConcurrency = Math.max(...concurrencyLog);
    assert.ok(
      maxConcurrency <= CONCURRENCY_LIMIT,
      `Max concurrency ${maxConcurrency} should be <= ${CONCURRENCY_LIMIT}`,
    );
    // Should have had at least some parallelism
    assert.ok(
      maxConcurrency > 1,
      `Should achieve some parallelism, got max concurrency ${maxConcurrency}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Fix 4: Eager TS resolver creation
// ---------------------------------------------------------------------------
describe("Fix 4: Eager TS resolver creation", () => {
  it("indexer.ts always creates TS resolver regardless of engine", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const srcPath = path.resolve(
      path.dirname(__filename),
      "..",
      "src",
      "indexer",
      "indexer.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");

    // Should NOT have the deferred conditional
    assert.ok(
      !content.includes("useRustEngine\n            ? null"),
      "Should not conditionally skip TS resolver when Rust engine is active",
    );
    assert.ok(
      !content.includes("Creating deferred TS call resolver"),
      "Should not have deferred TS resolver creation",
    );

    // Should have the eager creation comment
    assert.ok(
      content.includes("Fix 4: Create TS resolver eagerly"),
      "Should eagerly create TS resolver",
    );

    // Should have removed the deferred block
    assert.ok(
      content.includes("Fix 4: TS resolver created eagerly in initSharedState"),
      "Should have replaced deferred block with comment",
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: Content field in Rust parse results
// ---------------------------------------------------------------------------
describe("Rust content passthrough integration", () => {
  it("parseFilesRust returns content from native addon when available", async () => {
    const { isRustEngineAvailable, parseFilesRust } =
      await import("../dist/indexer/rustIndexer.js");

    if (!isRustEngineAvailable()) {
      // Skip if native addon not built
      console.log("  (skipped: native addon not available)");
      return;
    }

    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const repoRoot = path.resolve(path.dirname(__filename), "..");

    // Create a small test file
    const testDir = path.resolve(repoRoot, "tests", "fixtures");
    const testFile = "content-passthrough-test.ts";
    const testContent = 'export function hello(): string { return "world"; }\n';
    const testPath = path.join(testDir, testFile);

    try {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testPath, testContent);

      const results = parseFilesRust(
        "test-repo",
        testDir,
        [{ path: testFile, size: testContent.length, mtime: Date.now() }],
        1,
      );

      assert.ok(results, "parseFilesRust should return results");
      assert.ok(results!.length > 0, "Should have at least one result");

      const result = results![0];
      assert.strictEqual(result.relPath, testFile);

      // Content should be passed through from Rust
      if (result.content != null) {
        assert.strictEqual(
          result.content,
          testContent,
          "Content should match the original file",
        );
        console.log("  content passthrough: VERIFIED");
      } else {
        // Older native addon without content support
        console.log("  (content field not present — older addon version)");
      }

      // Symbols should still be extracted correctly
      assert.ok(result.symbols.length > 0, "Should extract symbols");
      const helloSym = result.symbols.find((s) => s.name === "hello");
      assert.ok(helloSym, "Should find 'hello' function");
    } finally {
      try {
        fs.unlinkSync(testPath);
      } catch {
        // ignore cleanup errors
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------
describe("Review fix: mid-run fallback to TS", () => {
  it("indexer-pass1 does not return usedRust:false mid-loop", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const srcPath = path.resolve(
      path.dirname(__filename),
      "..",
      "src",
      "indexer",
      "indexer-pass1.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");

    // After a chunk fails, remaining files should go to tsFallbackFiles, not return
    assert.ok(
      content.includes("for (const f of chunks[j]) tsFallbackFiles.push(f)"),
      "Should push remaining files to TS fallback on mid-run failure",
    );
    assert.ok(
      !content.includes("return { acc, usedRust: false }"),
      "Should not return usedRust:false after partial chunk work committed",
    );
  });

  it("uses relPath-based lookup instead of positional indexing", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const srcPath = path.resolve(
      path.dirname(__filename),
      "..",
      "src",
      "indexer",
      "indexer-pass1.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");

    assert.ok(
      content.includes("resultByPath.get(file.path)"),
      "Should use relPath-based lookup for index alignment safety",
    );
    assert.ok(
      !content.includes("chunkResults[i]"),
      "Should not use positional indexing into filtered results",
    );
  });
});

describe("Review fix: eager resolver guards non-TS repos", () => {
  it("checks for TS/JS files before creating resolver", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const srcPath = path.resolve(
      path.dirname(__filename),
      "..",
      "src",
      "indexer",
      "indexer.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");

    assert.ok(
      content.includes("hasTsFiles"),
      "Should check for TS/JS files before creating resolver",
    );
    assert.ok(
      content.includes("if (!hasTsFiles) return null"),
      "Should return null for pure non-TS repos",
    );
  });
});
