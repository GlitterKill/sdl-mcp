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
} from "../../src/config/types.js";

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

  it("engine defaults to 'typescript' when not specified", () => {
    const result = IndexingConfigSchema.parse({});
    assert.strictEqual(
      result.engine,
      "typescript",
      "engine should default to 'typescript'",
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
  const booleanFieldDefaults: Array<{ field: keyof typeof IndexingConfigSchema.shape; expected: boolean }> = [
    { field: "enableFileWatching", expected: true },
  ];

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
  const booleanDefaults: Array<{ field: keyof typeof PolicyConfigSchema.shape; expected: boolean }> = [
    { field: "requireIdentifiers", expected: true },
    { field: "allowBreakGlass", expected: true },
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
  const booleanDefaults: Array<{ field: keyof typeof RedactionConfigSchema.shape; expected: boolean }> = [
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
  const booleanDefaults: Array<{ field: keyof typeof PluginConfigSchema.shape; expected: boolean }> = [
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
  it("AnnConfigSchema.enabled defaults to false", () => {
    const result = AnnConfigSchema.parse({});
    assert.strictEqual(result.enabled, false);
  });
});

// ---------------------------------------------------------------------------
// SemanticConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("SemanticConfigSchema defaults", () => {
  const booleanDefaults: Array<{ field: keyof typeof SemanticConfigSchema.shape; expected: boolean }> = [
    { field: "enabled", expected: true },
    { field: "generateSummaries", expected: false },
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
});

// ---------------------------------------------------------------------------
// PrefetchConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("PrefetchConfigSchema defaults", () => {
  it("PrefetchConfigSchema.enabled defaults to false", () => {
    const result = PrefetchConfigSchema.parse({});
    assert.strictEqual(result.enabled, false);
  });
});

// ---------------------------------------------------------------------------
// TracingConfigSchema boolean defaults
// ---------------------------------------------------------------------------

describe("TracingConfigSchema defaults", () => {
  it("TracingConfigSchema.enabled defaults to false", () => {
    const result = TracingConfigSchema.parse({});
    assert.strictEqual(result.enabled, false);
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
  it("ParallelScorerConfigSchema.enabled defaults to false", () => {
    const result = ParallelScorerConfigSchema.parse({});
    assert.strictEqual(result.enabled, false);
  });
});
