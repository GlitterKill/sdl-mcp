import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildFileSummaryEmbeddingText,
  resolveFileSummaryEmbeddingBatchSize,
} from "../../dist/indexer/file-summary-embeddings.js";

describe("FileSummary embedding resource controls", () => {
  it("uses a conservative FileSummary batch default instead of symbol batch width", () => {
    assert.equal(resolveFileSummaryEmbeddingBatchSize(undefined, 32), 4);
    assert.equal(resolveFileSummaryEmbeddingBatchSize(2, 32), 2);
    assert.equal(resolveFileSummaryEmbeddingBatchSize(64, 128), 16);
  });

  it("embeds the hybrid summary once and caps oversized payloads", () => {
    const summary = `File: src/huge.ts\n${"x".repeat(10_000)}`;
    const searchText = `file: src/huge.ts summary: ${summary}`;

    const text = buildFileSummaryEmbeddingText(
      { summary, searchText },
      4096,
    );

    assert.ok(text.length <= 4096);
    assert.equal(text.startsWith("File: src/huge.ts"), true);
    assert.equal(
      text.includes("summary: File: src/huge.ts"),
      false,
      "searchText should not duplicate the summary payload when summary exists",
    );
  });
});
