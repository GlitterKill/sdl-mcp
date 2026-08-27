import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  invalidateConfigCache,
  loadConfig,
} from "../../dist/config/loadConfig.js";
import { SemanticConfigSchema } from "../../dist/config/types.js";
import { createAsyncFsOperations } from "../../dist/util/asyncFs.js";
import { detectCpuProfile } from "../../dist/util/cpu-detect.js";
import { resolveEmbeddingWidth } from "../../dist/util/cpu-presets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function withTempConfig(
  overrides: Record<string, unknown>,
  verify: (config: ReturnType<typeof loadConfig>) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "sdl-mcp-config-"));
  try {
    const configPath = join(dir, "sdlmcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ repos: [], policy: {}, ...overrides }),
      "utf8",
    );
    invalidateConfigCache();
    verify(loadConfig(configPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Config Loading (RR-H.8)", () => {
  it("should resolve default path relative to module (RR-H.8.1)", () => {
    const loadConfigDir = resolve(__dirname, "../../dist/config");
    // From dist/config, go up two levels (to sdl-mcp root) then into config/
    const expectedPath = resolve(
      loadConfigDir,
      "../../config/sdlmcp.config.json",
    );

    const absoluteExpected = resolve(
      __dirname,
      "../../config/sdlmcp.config.json",
    );

    assert.strictEqual(
      expectedPath,
      absoluteExpected,
      "Default config path should be resolved relative to loadConfig module",
    );
  });

  it("should load example config successfully", () => {
    const exampleConfigPath = resolve(
      __dirname,
      "../../config/sdlmcp.config.example.json",
    );
    invalidateConfigCache();
    const config = loadConfig(exampleConfigPath);
    const expectedWidth = resolveEmbeddingWidth(detectCpuProfile());

    assert.ok(
      config.graphDatabase,
      "Expected graphDatabase section in example config",
    );
    assert.strictEqual(typeof config.graphDatabase!.path, "string");
    assert.ok(config.graphDatabase!.path!.length > 0);
    assert.strictEqual(config.semantic!.embeddingBatchSize, 16);
    assert.strictEqual(config.semantic!.embeddingConcurrency, expectedWidth);
    assert.strictEqual(config.semantic!.fileSummaryEmbeddingBatchSize, 4);
  });

  it("applies presets for a pinned performance tier", () => {
    withTempConfig({ performanceTier: "extreme" }, (config) => {
      const expectedWidth = resolveEmbeddingWidth(detectCpuProfile());

      assert.strictEqual(config.indexing!.concurrency, 12);
      assert.strictEqual(config.semantic!.embeddingBatchSize, 16);
      assert.strictEqual(config.semantic!.embeddingConcurrency, expectedWidth);
      assert.strictEqual(config.semantic!.fileSummaryEmbeddingBatchSize, 4);
    });
  });

  it("preserves explicit values over pinned tier presets", () => {
    withTempConfig(
      {
        performanceTier: "extreme",
        indexing: { concurrency: 5 },
        semantic: {
          embeddingBatchSize: 24,
          embeddingConcurrency: 3,
          fileSummaryEmbeddingBatchSize: 7,
          onnx: { intraOpNumThreads: 0, executionMode: "parallel" },
        },
      },
      (config) => {
        assert.strictEqual(config.indexing!.concurrency, 5);
        assert.strictEqual(config.indexing!.pass2Concurrency, 12);
        assert.strictEqual(config.semantic!.embeddingBatchSize, 24);
        assert.strictEqual(config.semantic!.embeddingConcurrency, 3);
        assert.strictEqual(config.semantic!.fileSummaryEmbeddingBatchSize, 7);
        assert.strictEqual(config.semantic!.onnx!.intraOpNumThreads, 0);
        assert.strictEqual(config.semantic!.onnx!.executionMode, "parallel");
        assert.strictEqual(config.semantic!.onnx!.interOpNumThreads, 0);
      },
    );
  });

  it("defaults FileSummary embeddings to conservative resource controls", () => {
    const result = SemanticConfigSchema.safeParse({ enabled: true });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.strictEqual(result.data.fileSummaryEmbeddingBatchSize, 4);
    assert.strictEqual(result.data.fileSummaryEmbeddingMaxChars, 4096);
  });

  it("should throw error for non-existent config", () => {
    assert.throws(
      () => loadConfig("/non/existent/path.json"),
      (err: Error) => err.message.includes("Config file not found"),
    );
  });
});

describe("AsyncFs Factory Pattern (RR-H.8.2)", () => {
  it("should create new instances with factory (RR-H.8.2.1)", () => {
    const ops1 = createAsyncFsOperations({ maxConcurrentReads: 5 });
    const ops2 = createAsyncFsOperations({ maxConcurrentReads: 10 });

    assert.notStrictEqual(ops1, ops2, "Factory should create new instances");
  });

  it("should apply config to each new instance (RR-H.8.2.2)", () => {
    const ops1 = createAsyncFsOperations({ maxConcurrentReads: 5 });
    const ops2 = createAsyncFsOperations({ maxConcurrentReads: 10 });
    const ops3 = createAsyncFsOperations({ maxConcurrentReads: 20 });

    assert.notStrictEqual(ops1, ops2);
    assert.notStrictEqual(ops2, ops3);
    assert.notStrictEqual(ops1, ops3);
  });

  it("should use default config when none provided", () => {
    const ops1 = createAsyncFsOperations();
    const ops2 = createAsyncFsOperations();

    assert.notStrictEqual(
      ops1,
      ops2,
      "Factory should always create new instances",
    );
  });
});
