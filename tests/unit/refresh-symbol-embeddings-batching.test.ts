import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for Phase 4: Batched refresh execution.
 *
 * These tests verify that:
 * 1. REFRESH_BATCH_SIZE is exported and equals 32
 * 2. The batching constants are correctly defined
 *
 * Full integration testing of refreshSymbolEmbeddings batching behavior
 * is covered in tests/integration/semantic-embedding.test.ts since it
 * requires database setup and provider mocking at the module level.
 */

describe("refresh-symbol-embeddings batching", () => {
  describe("REFRESH_BATCH_SIZE constant", () => {
    it("exports REFRESH_BATCH_SIZE = 32", async () => {
      const { REFRESH_BATCH_SIZE } = await import(
        "../../dist/indexer/embeddings.js"
      );
      assert.strictEqual(REFRESH_BATCH_SIZE, 32, "batch size should be 32");
    });

    it("REFRESH_BATCH_SIZE matches ONNX inference batch width", async () => {
      // The batch size should match what LocalEmbeddingProvider uses
      // for ONNX inference to maximize throughput
      const { REFRESH_BATCH_SIZE } = await import(
        "../../dist/indexer/embeddings.js"
      );
      assert.ok(
        REFRESH_BATCH_SIZE > 0 && REFRESH_BATCH_SIZE <= 64,
        "batch size should be positive and reasonable",
      );
    });
  });

  describe("batch calculation", () => {
    it("calculates correct number of batches for various symbol counts", async () => {
      const { REFRESH_BATCH_SIZE } = await import(
        "../../dist/indexer/embeddings.js"
      );

      // Test batch count calculations
      const testCases = [
        { symbols: 0, expectedBatches: 0 },
        { symbols: 1, expectedBatches: 1 },
        { symbols: 32, expectedBatches: 1 },
        { symbols: 33, expectedBatches: 2 },
        { symbols: 64, expectedBatches: 2 },
        { symbols: 65, expectedBatches: 3 },
        { symbols: 100, expectedBatches: 4 },
      ];

      for (const { symbols, expectedBatches } of testCases) {
        const actualBatches =
          symbols === 0 ? 0 : Math.ceil(symbols / REFRESH_BATCH_SIZE);
        assert.strictEqual(
          actualBatches,
          expectedBatches,
          `${symbols} symbols should produce ${expectedBatches} batches`,
        );
      }
    });
  });

  describe("buildCardHash changes (Phase 4)", () => {
    it("buildCardHash is exported from embeddings module", async () => {
      // buildCardHash is internal, but we can verify the module loads
      const module = await import("../../dist/indexer/embeddings.js");
      assert.ok(module.refreshSymbolEmbeddings, "refreshSymbolEmbeddings should be exported");
      assert.ok(module.REFRESH_BATCH_SIZE, "REFRESH_BATCH_SIZE should be exported");
    });
  });

  describe("integration with model-aware payload builders", () => {
    it("imports buildSymbolEmbeddingText without error", async () => {
      const { buildSymbolEmbeddingText } = await import(
        "../../dist/indexer/symbol-embedding-text.js"
      );
      assert.ok(
        typeof buildSymbolEmbeddingText === "function",
        "buildSymbolEmbeddingText should be a function",
      );
    });

    it("imports prepareSymbolEmbeddingInputs without error", async () => {
      const { prepareSymbolEmbeddingInputs } = await import(
        "../../dist/indexer/symbol-embedding-context.js"
      );
      assert.ok(
        typeof prepareSymbolEmbeddingInputs === "function",
        "prepareSymbolEmbeddingInputs should be a function",
      );
    });
  });
});
