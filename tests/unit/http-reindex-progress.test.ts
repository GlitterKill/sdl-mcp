import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("HTTP reindex progress serialization", () => {
  it("preserves embedding model metadata in SSE progress payloads", async () => {
    const { serializeReindexProgressEvent } = await import(
      "../../dist/cli/transport/http.js"
    );

    const payload = serializeReindexProgressEvent({
      stage: "embeddings",
      current: 17,
      total: 42,
      substage: "fileSummaryEmbeddings",
      model: "jina-embeddings-v2-base-code",
    });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), {
      stage: "embeddings",
      current: 17,
      total: 42,
      substage: "fileSummaryEmbeddings",
      model: "jina-embeddings-v2-base-code",
    });
  });
});
