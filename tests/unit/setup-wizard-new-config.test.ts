import assert from "node:assert/strict";
import test from "node:test";

import {
  applySetupWizardConfig,
  detectRepoSizeProfile,
  semanticConfigForTier,
} from "../../dist/cli/setup-wizard/recommendations.js";

test("semantic tiers map to config without enabling LLM summaries", () => {
  assert.deepEqual(semanticConfigForTier("code"), {
    enabled: true,
    provider: "local",
    symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
    fileSummaryEmbeddingModels: [],
    generateSummaries: false,
  });
  assert.deepEqual(semanticConfigForTier("enhanced"), {
    enabled: true,
    provider: "local",
    embeddingProfile: "specialized",
    generateSummaries: false,
  });
  assert.deepEqual(semanticConfigForTier("off"), { enabled: false });
});

test("repo size profile thresholds stay deliberately simple", () => {
  assert.equal(detectRepoSizeProfile(1999), "small");
  assert.equal(detectRepoSizeProfile(2000), "medium");
  assert.equal(detectRepoSizeProfile(20_000), "large");
  assert.equal(detectRepoSizeProfile(100_001), "huge");
});

test("wizard result applies provider, semantic, graph path, and huge watcher defaults", () => {
  const config = {
    graphDatabase: { path: "default.lbug" },
    indexing: { pipeline: "auto", enableFileWatching: true },
    semantic: {},
  };

  applySetupWizardConfig(config, {
    languageProviders: false,
    semanticTier: "off",
    repoSizeProfile: "huge",
    paths: { graphDbPath: "custom.lbug", modelCachePath: ".cache/models" },
  });

  assert.equal(config.indexing.pipeline, "legacy");
  assert.equal(config.indexing.enableFileWatching, false);
  assert.equal(config.graphDatabase.path, "custom.lbug");
  assert.deepEqual(config.semantic, {
    enabled: false,
    modelCachePath: ".cache/models",
  });
});
