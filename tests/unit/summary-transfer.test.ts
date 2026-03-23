/**
 * Tests for NN-based summary transfer (summary-transfer.ts).
 *
 * The transfer pipeline depends on the ANN index and embedding provider.
 * When the ANN index is not ready (e.g., no index built), the function
 * returns immediately with zero results. These tests validate:
 *   - Early-return behavior when ANN index is uninitialized
 *   - Correct shape of the SummaryTransferResult object
 *   - The exported types/interfaces
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  transferSummariesFromNeighbors,
  type SummaryTransferResult,
  type SummaryTransferOptions,
} from "../../dist/indexer/summary-transfer.js";
import { resetAnnIndexManager } from "../../dist/indexer/ann-index.js";
import type { EmbeddingProvider } from "../../dist/indexer/embeddings.js";

/**
 * Minimal mock EmbeddingProvider that satisfies the interface.
 * embed() should never be called in these tests because the ANN gate
 * returns early, but we provide a working implementation just in case.
 */
const mockEmbeddingProvider: EmbeddingProvider = {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(64).fill(0));
  },
  getDimension(): number {
    return 64;
  },
  isMockFallback(): boolean {
    return true;
  },
};

describe("summary transfer", () => {
  beforeEach(() => {
    // Reset the global ANN index singleton so each test starts fresh
    // with status === "uninitialized"
    resetAnnIndexManager();
  });

  it("returns zero results when ANN index not ready", async () => {
    const result = await transferSummariesFromNeighbors({
      repoId: "nonexistent-repo",
      conn: null as any,
      embeddingProvider: mockEmbeddingProvider,
    });
    assert.strictEqual(result.transferred, 0);
    assert.strictEqual(result.directTransfers, 0);
    assert.strictEqual(result.adaptedTransfers, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.noNeighbor, 0);
    assert.strictEqual(result.rejected, 0);
  });

  it("has correct result shape", async () => {
    const result = await transferSummariesFromNeighbors({
      repoId: "test",
      conn: null as any,
      embeddingProvider: mockEmbeddingProvider,
    });

    // Verify all expected fields are present
    assert.ok("transferred" in result);
    assert.ok("directTransfers" in result);
    assert.ok("adaptedTransfers" in result);
    assert.ok("skipped" in result);
    assert.ok("noNeighbor" in result);
    assert.ok("rejected" in result);

    // Verify types are numbers
    assert.strictEqual(typeof result.transferred, "number");
    assert.strictEqual(typeof result.directTransfers, "number");
    assert.strictEqual(typeof result.adaptedTransfers, "number");
    assert.strictEqual(typeof result.skipped, "number");
    assert.strictEqual(typeof result.noNeighbor, "number");
    assert.strictEqual(typeof result.rejected, "number");
  });

  it("accepts optional configuration parameters", async () => {
    // Verify all optional config fields are accepted without errors
    const result = await transferSummariesFromNeighbors({
      repoId: "test",
      conn: null as any,
      embeddingProvider: mockEmbeddingProvider,
      minSimilarity: 0.8,
      maxNeighbors: 3,
      directTransferThreshold: 0.9,
      batchSize: 10,
    });
    // Still returns early because ANN index is not ready
    assert.strictEqual(result.transferred, 0);
  });

  it("accepts optional onProgress callback", async () => {
    let callbackCalled = false;
    const result = await transferSummariesFromNeighbors(
      {
        repoId: "test",
        conn: null as any,
        embeddingProvider: mockEmbeddingProvider,
      },
      (_progress) => {
        callbackCalled = true;
      },
    );
    // onProgress should NOT be called when ANN gate returns early
    assert.strictEqual(callbackCalled, false);
    assert.strictEqual(result.transferred, 0);
  });

  it("SummaryTransferOptions type accepts required fields", () => {
    // Type-level test: verify the interface shape compiles correctly
    const options: SummaryTransferOptions = {
      repoId: "test-repo",
      conn: null as any,
      embeddingProvider: mockEmbeddingProvider,
    };
    assert.strictEqual(options.repoId, "test-repo");
    assert.ok(options.embeddingProvider !== undefined);
  });

  it("SummaryTransferResult type has all counters", () => {
    // Type-level test: verify the result interface compiles
    const result: SummaryTransferResult = {
      transferred: 0,
      directTransfers: 0,
      adaptedTransfers: 0,
      skipped: 0,
      noNeighbor: 0,
      rejected: 0,
    };
    assert.strictEqual(
      Object.keys(result).length,
      6,
      "SummaryTransferResult should have exactly 6 fields",
    );
  });
});
