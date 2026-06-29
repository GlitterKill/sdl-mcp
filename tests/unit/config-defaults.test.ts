/**
 * config-defaults.test.ts
 *
 * Verifies that all boolean defaults in IndexingConfigSchema and related
 * sub-schemas are correctly set in both types.ts (via Zod parse) and that
 * the compiled types.js file produces identical results.
 *
 * These tests parse schemas directly with Zod — no file I/O required.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IndexingConfigSchema,
  PolicyConfigSchema,
  RedactionConfigSchema,
  DiagnosticsConfigSchema,
  CacheConfigSchema,
  PluginConfigSchema,
  AnnConfigSchema,
  SemanticConfigSchema,
  PrefetchConfigSchema,
  TracingConfigSchema,
  ParallelScorerConfigSchema,
  ProviderFirstIndexingConfigSchema,
  ScipConfigSchema,
  SemanticEnrichmentConfigSchema,
} from "../../dist/config/types.js";
import { loadConfig } from "../../dist/config/loadConfig.js";
import {
  applyMissingConfigRecommendations,
  summarizeMissingConfigKeys,
} from "../../dist/cli/setup-wizard/config-diff.js";
import { semanticConfigForTier } from "../../dist/cli/setup-wizard/recommendations.js";

// ---------------------------------------------------------------------------
// IndexingConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("IndexingConfigSchema defaults", () => {
  it("enableFileWatching defaults to true when not specified", () => {
    const result = IndexingConfigSchema.parse({});
    assert.strictEqual(
      result.enableFileWatching,
      true,
      "enableFileWatching should default to true",
    );
  });

  it("enableFileWatching can be explicitly set to false", () => {
    const result = IndexingConfigSchema.parse({ enableFileWatching: false });
    assert.strictEqual(
      result.enableFileWatching,
      false,
      "enableFileWatching should be false when explicitly set",
    );
  });

  it("enableFileWatching can be explicitly set to true", () => {
    const result = IndexingConfigSchema.parse({ enableFileWatching: true });
    assert.strictEqual(
      result.enableFileWatching,
      true,
      "enableFileWatching should be true when explicitly set",
    );
  });

  it("engine defaults to 'rust' when not specified", () => {
    const result = IndexingConfigSchema.parse({});
    assert.strictEqual(
      result.engine,
      "rust",
      "engine should default to 'rust'",
    );
  });

  it("engine can be set to 'rust'", () => {
    const result = IndexingConfigSchema.parse({ engine: "rust" });
    assert.strictEqual(result.engine, "rust");
  });

  it("maxWatchedFiles defaults to a positive integer", () => {
    const result = IndexingConfigSchema.parse({});
    assert.ok(
      Number.isInteger(result.maxWatchedFiles) && result.maxWatchedFiles > 0,
      "maxWatchedFiles should be a positive integer",
    );
  });

  // Table-driven: all known boolean fields in IndexingConfigSchema
  const booleanFieldDefaults: Array<{
    field: keyof typeof IndexingConfigSchema.shape;
    expected: boolean;
  }> = [{ field: "enableFileWatching", expected: true }];

  for (const { field, expected } of booleanFieldDefaults) {
    it(`IndexingConfigSchema.${field} defaults to ${expected}`, () => {
      const result = IndexingConfigSchema.parse({});
      assert.strictEqual(
        result[field as keyof typeof result],
        expected,
        `${field} should default to ${expected}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// PolicyConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("PolicyConfigSchema defaults", () => {
  const booleanDefaults: Array<{
    field: keyof typeof PolicyConfigSchema.shape;
    expected: boolean;
  }> = [
    { field: "requireIdentifiers", expected: true },
    { field: "allowBreakGlass", expected: false },
  ];

  for (const { field, expected } of booleanDefaults) {
    it(`PolicyConfigSchema.${field} defaults to ${expected}`, () => {
      const result = PolicyConfigSchema.parse({});
      assert.strictEqual(
        result[field as keyof typeof result],
        expected,
        `${field} should default to ${expected}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// RedactionConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("RedactionConfigSchema defaults", () => {
  const booleanDefaults: Array<{
    field: keyof typeof RedactionConfigSchema.shape;
    expected: boolean;
  }> = [
    { field: "enabled", expected: true },
    { field: "includeDefaults", expected: true },
  ];

  for (const { field, expected } of booleanDefaults) {
    it(`RedactionConfigSchema.${field} defaults to ${expected}`, () => {
      const result = RedactionConfigSchema.parse({});
      assert.strictEqual(
        result[field as keyof typeof result],
        expected,
        `${field} should default to ${expected}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// DiagnosticsConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("DiagnosticsConfigSchema defaults", () => {
  it("DiagnosticsConfigSchema.enabled defaults to true", () => {
    const result = DiagnosticsConfigSchema.parse({});
    assert.strictEqual(result.enabled, true);
  });

  it("DiagnosticsConfigSchema.mode defaults to 'tsLS'", () => {
    const result = DiagnosticsConfigSchema.parse({});
    assert.strictEqual(result.mode, "tsLS");
  });

  it("DiagnosticsConfigSchema.scope defaults to 'changedFiles'", () => {
    const result = DiagnosticsConfigSchema.parse({});
    assert.strictEqual(result.scope, "changedFiles");
  });
});

// ---------------------------------------------------------------------------
// CacheConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("CacheConfigSchema defaults", () => {
  it("CacheConfigSchema.enabled defaults to true", () => {
    const result = CacheConfigSchema.parse({});
    assert.strictEqual(result.enabled, true);
  });
});

// ---------------------------------------------------------------------------
// PluginConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("PluginConfigSchema defaults", () => {
  const booleanDefaults: Array<{
    field: keyof typeof PluginConfigSchema.shape;
    expected: boolean;
  }> = [
    { field: "enabled", expected: true },
    { field: "strictVersioning", expected: true },
  ];

  for (const { field, expected } of booleanDefaults) {
    it(`PluginConfigSchema.${field} defaults to ${expected}`, () => {
      const result = PluginConfigSchema.parse({});
      assert.strictEqual(
        result[field as keyof typeof result],
        expected,
        `${field} should default to ${expected}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// AnnConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("AnnConfigSchema defaults", () => {
  it("AnnConfigSchema.enabled defaults to true", () => {
    const result = AnnConfigSchema.parse({});
    assert.strictEqual(result.enabled, true);
  });
});

// ---------------------------------------------------------------------------
// SemanticConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("SemanticConfigSchema defaults", () => {
  const booleanDefaults: Array<{
    field: keyof typeof SemanticConfigSchema.shape;
    expected: boolean;
  }> = [
    { field: "enabled", expected: true },
    { field: "generateSummaries", expected: true },
  ];

  for (const { field, expected } of booleanDefaults) {
    it(`SemanticConfigSchema.${field} defaults to ${expected}`, () => {
      const result = SemanticConfigSchema.parse({});
      assert.strictEqual(
        result[field as keyof typeof result],
        expected,
        `${field} should default to ${expected}`,
      );
    });
  }

  it("SemanticConfigSchema.summaryProvider defaults to mock", () => {
    const result = SemanticConfigSchema.parse({});
    assert.strictEqual(result.summaryProvider, "mock");
  });

  it("SemanticConfigSchema.summaryProvider accepts legacy null as unset", () => {
    const result = SemanticConfigSchema.parse({ summaryProvider: null });
    assert.strictEqual(result.summaryProvider, null);
  });


});

// ---------------------------------------------------------------------------
// PrefetchConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("PrefetchConfigSchema defaults", () => {
  it("PrefetchConfigSchema.enabled defaults to true", () => {
    const result = PrefetchConfigSchema.parse({});
    assert.strictEqual(result.enabled, true);
  });
});

// ---------------------------------------------------------------------------
// TracingConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("TracingConfigSchema defaults", () => {
  it("TracingConfigSchema.enabled defaults to true", () => {
    const result = TracingConfigSchema.parse({});
    assert.strictEqual(result.enabled, true);
  });

  it("TracingConfigSchema.serviceName defaults to 'sdl-mcp'", () => {
    const result = TracingConfigSchema.parse({});
    assert.strictEqual(result.serviceName, "sdl-mcp");
  });
});

// ---------------------------------------------------------------------------
// ParallelScorerConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("ParallelScorerConfigSchema defaults", () => {
  it("ParallelScorerConfigSchema.enabled defaults to true", () => {
    const result = ParallelScorerConfigSchema.parse({});
    assert.strictEqual(result.enabled, true);
  });
});


// ---------------------------------------------------------------------------
// SCIP and semantic enrichment defaults
// ---------------------------------------------------------------------------

describe("SCIP and semantic enrichment defaults", () => {
  it("enables SCIP, semantic enrichment, and provider-first LSP by default", () => {
    const scip = ScipConfigSchema.parse({});
    assert.strictEqual(scip.enabled, true);
    assert.deepStrictEqual(scip.indexes, [{ path: "index.scip" }]);
    assert.deepStrictEqual(scip.externalSymbols, {
      enabled: true,
      maxPerIndex: 10_000,
    });
    assert.strictEqual(scip.confidence, 0.95);
    assert.strictEqual(scip.autoIngestOnRefresh, true);
    assert.deepStrictEqual(scip.generator, {
      enabled: true,
      binary: "scip-io",
      args: ["--include-additional-configs", "--timeout", "3600"],
      autoInstall: true,
      timeoutMs: 18_000_000,
      cleanupAfterIngest: true,
      cacheGeneratedIndexes: true,
    });

    const semanticEnrichment = SemanticEnrichmentConfigSchema.parse({});
    assert.strictEqual(semanticEnrichment.enabled, true);

    const providerFirst = ProviderFirstIndexingConfigSchema.parse({});
    assert.strictEqual(providerFirst.lsp.mode, "primaryWithCaps");

    const dir = mkdtempSync(join(tmpdir(), "sdl-config-defaults-"));
    try {
      const configPath = join(dir, "sdlmcp.config.json");
      writeFileSync(configPath, JSON.stringify({ repos: [], policy: {} }));

      const appConfig = loadConfig(configPath);
      assert.strictEqual(appConfig.scip?.enabled, true);
      assert.strictEqual(appConfig.semanticEnrichment?.enabled, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Setup wizard semantic recommendations
// ---------------------------------------------------------------------------

describe("setup wizard semantic recommendations", () => {
  it("keeps standard semantic recommendations aligned with specialized embeddings", () => {
    assert.deepStrictEqual(semanticConfigForTier("standard"), {
      enabled: true,
      provider: "local",
      symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
      fileSummaryEmbeddingModels: ["nomic-embed-text-v1.5"],
      generateSummaries: false,
    });

    const recommendations = summarizeMissingConfigKeys({});
    assert.deepStrictEqual(
      recommendations.find((item) => item.path === "semantic.fileSummaryEmbeddingModels")
        ?.recommendedValue,
      ["nomic-embed-text-v1.5"],
    );

    const rawConfig = {};
    applyMissingConfigRecommendations(rawConfig, recommendations);
    assert.deepStrictEqual(rawConfig.semantic, {
      embeddingProfile: "specialized",
      symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
      fileSummaryEmbeddingModels: ["nomic-embed-text-v1.5"],
    });
  });
});
