import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMissingConfigRecommendations,
  summarizeMissingConfigKeys,
} from "../../src/cli/setup-wizard/config-diff.ts";

test("missing config summary reports semantic, provider LSP, and observability keys", () => {
  const summary = summarizeMissingConfigKeys({
    semantic: { enabled: true },
    indexing: { providerFirst: {} },
    observability: {},
  });

  assert.deepEqual(
    summary.map((item) => item.path),
    [
      "semantic.embeddingProfile",
      "semantic.symbolEmbeddingModels",
      "semantic.fileSummaryEmbeddingModels",
      "indexing.providerFirst.lsp",
      "observability.sampleIntervalMs",
    ],
  );
  assert.equal(summary[0].recommendedValue, "specialized");
});

test("existing values are not reported as missing", () => {
  const summary = summarizeMissingConfigKeys({
    semantic: {
      embeddingProfile: "specialized",
      symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
      fileSummaryEmbeddingModels: [],
    },
    indexing: { providerFirst: { lsp: {} } },
    observability: { sampleIntervalMs: 2000 },
  });

  assert.deepEqual(summary, []);
});

test("applying missing recommendations preserves existing tuned values", () => {
  const rawConfig = {
    semantic: { enabled: true, embeddingProfile: "custom" },
    indexing: { providerFirst: {} },
    observability: {},
  };

  applyMissingConfigRecommendations(rawConfig, summarizeMissingConfigKeys(rawConfig));

  assert.equal(rawConfig.semantic.embeddingProfile, "custom");
  assert.deepEqual(rawConfig.semantic.symbolEmbeddingModels, [
    "jina-embeddings-v2-base-code",
  ]);
  assert.deepEqual(rawConfig.indexing.providerFirst.lsp, { mode: "primaryWithCaps" });
  assert.equal(rawConfig.observability.sampleIntervalMs, 2000);
});
