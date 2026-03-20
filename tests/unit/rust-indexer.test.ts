import { describe, it, before, after } from "node:test";
import assert from "node:assert";

import {
  isRustEngineAvailable,
  parseFilesRust,
  hashContentRust,
  generateSymbolIdRust,
  computeClustersRust,
  traceProcessesRust,
} from "../../dist/indexer/rustIndexer.js";

describe("rustIndexer — native addon disabled", () => {
  let originalEnv: string | undefined;

  before(() => {
    originalEnv = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
  });

  after(() => {
    if (originalEnv === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = originalEnv;
    }
  });

  it("isRustEngineAvailable returns false when addon is disabled", () => {
    const available = isRustEngineAvailable();
    assert.strictEqual(available, false);
  });

  it("parseFilesRust returns null when addon is disabled", () => {
    const result = parseFilesRust("test-repo", "/tmp/repo", [
      { path: "src/index.ts", size: 100, mtime: Date.now() },
    ]);
    assert.strictEqual(result, null);
  });

  it("hashContentRust returns null when addon is disabled", () => {
    const result = hashContentRust("console.log('hello')");
    assert.strictEqual(result, null);
  });

  it("generateSymbolIdRust returns null when addon is disabled", () => {
    const result = generateSymbolIdRust(
      "repo1",
      "src/foo.ts",
      "function",
      "bar",
      "fp1",
    );
    assert.strictEqual(result, null);
  });

  it("computeClustersRust returns null when addon is disabled", () => {
    const result = computeClustersRust(
      [{ symbolId: "A" }, { symbolId: "B" }],
      [{ fromSymbolId: "A", toSymbolId: "B" }],
      2,
    );
    assert.strictEqual(result, null);
  });

  it("traceProcessesRust returns null when addon is disabled", () => {
    const result = traceProcessesRust(
      [{ symbolId: "A", name: "main" }],
      [{ callerId: "A", calleeId: "B" }],
      10,
      [],
    );
    assert.strictEqual(result, null);
  });
});

describe("rustIndexer — parseFilesRust with unsupported languages", () => {
  it("returns results with parse errors for unsupported language files when addon is available", () => {
    // When addon is unavailable this is a no-op; when available it exercises
    // the unsupported-language fallback path.
    if (!isRustEngineAvailable()) return;

    const files = [
      { path: "src/main.kt", size: 50, mtime: Date.now() },
    ];
    const result = parseFilesRust("test-repo", "/tmp/repo", files);
    // Kotlin is unsupported in native extraction — should get a parse error result
    assert.ok(result !== null, "Should return results array");
    assert.strictEqual(result.length, 1);
    assert.ok(
      result[0].parseError !== null,
      "Unsupported language should have parse error",
    );
    assert.ok(
      result[0].parseError!.includes("Unsupported language"),
      "Parse error should mention unsupported language",
    );
  });
});

describe("rustIndexer — parseFilesRust with empty input", () => {
  it("returns empty array for empty file list when addon is available", () => {
    if (!isRustEngineAvailable()) return;

    const result = parseFilesRust("test-repo", "/tmp/repo", []);
    assert.ok(result !== null);
    assert.strictEqual(result.length, 0);
  });
});

describe("rustIndexer — env var parsing", () => {
  let originalEnv: string | undefined;

  after(() => {
    if (originalEnv === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = originalEnv;
    }
  });

  it("recognizes 'true' (case-insensitive) as disable flag", () => {
    originalEnv = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "TRUE";

    // Force fresh evaluation — isRustEngineAvailable calls loadNativeAddon
    // which checks the env var on every call when disabled.
    const available = isRustEngineAvailable();
    assert.strictEqual(available, false);
  });
});
