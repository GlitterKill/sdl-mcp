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

  it("preserves provider-first substage metadata in SSE progress payloads", async () => {
    const { serializeReindexProgressEvent } = await import(
      "../../dist/cli/transport/http.js"
    );

    const payload = serializeReindexProgressEvent({
      stage: "providerFirst",
      current: 0,
      total: 0,
      substage: "providerCollection.sourceLines",
      stageCurrent: 12,
      stageTotal: 40,
      message: "loaded source lines for 12/40 provider document(s)",
    });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), {
      stage: "providerFirst",
      current: 0,
      total: 0,
      substage: "providerCollection.sourceLines",
      stageCurrent: 12,
      stageTotal: 40,
      message: "loaded source lines for 12/40 provider document(s)",
    });
  });
});
