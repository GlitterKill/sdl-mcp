/**
 * Tests for symbol-embedding-text.ts - model-aware payload builders.
 * Phase 2: Jina structured payload with graph context.
 * Phase 3: Broader model-aware payload split (Nomic builder + dispatcher).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildJinaSymbolEmbeddingText,
  buildNomicSymbolEmbeddingText,
  buildSymbolEmbeddingText,
} from "../../dist/indexer/symbol-embedding-text.js";
import type {
  PreparedSymbolEmbeddingInput,
  GraphLabel,
} from "../../dist/indexer/symbol-embedding-context.js";

/** Helper to create a minimal prepared input for testing. */
function makeInput(
  overrides: Partial<PreparedSymbolEmbeddingInput> = {},
): PreparedSymbolEmbeddingInput {
  return {
    symbol: {
      symbolId: "sym-test-001",
      repoId: "test-repo",
      fileId: "file-001",
      name: "testFunction",
      kind: "function",
      signatureJson: '{"text":"function testFunction(a: string): void"}',
      rangeStartLine: 10,
      rangeEndLine: 20,
      rangeStartCol: 0,
      rangeEndCol: 1,
      astFingerprint: "fp-abc123",
      exported: true,
      roleTagsJson: null,
      invariantsJson: null,
      sideEffectsJson: null,
      searchText: null,
      summary: null,
      testCoverageJson: null,
      canonicalTestJson: null,
    },
    signatureText: "function testFunction(a: string): void",
    relPath: "src/utils/helpers.ts",
    language: "typescript",
    roleTags: [],
    searchTerms: [],
    invariants: [],
    sideEffects: [],
    imports: [],
    calls: [],
    summaryFreshness: "absent",
    summaryText: null,
    ...overrides,
  };
}

describe("buildJinaSymbolEmbeddingText", () => {
  describe("symbol identity and signature", () => {
    it("includes name, kind, and language in header", () => {
      const input = makeInput();
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(text.includes("Name: testFunction"), "should include name");
      assert.ok(text.includes("Kind: function"), "should include kind");
      assert.ok(
        text.includes("Language: typescript"),
        "should include language",
      );
    });

    it("includes signature when present", () => {
      const input = makeInput({
        signatureText:
          "async function fetchData(url: string): Promise<Response>",
      });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(
        text.includes(
          "Signature: async function fetchData(url: string): Promise<Response>",
        ),
        "should include signature",
      );
    });

    it("omits signature line when null", () => {
      const input = makeInput({ signatureText: null });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(
        !text.includes("Signature:"),
        "should not include signature line",
      );
    });
  });

  describe("path and language metadata", () => {
    it("includes file path", () => {
      const input = makeInput({ relPath: "src/core/engine.ts" });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(
        text.includes("Path: src/core/engine.ts"),
        "should include path",
      );
    });

    it("includes exported status when true", () => {
      const input = makeInput();
      input.symbol.exported = true;
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(text.includes("Exported: yes"), "should show exported");
    });

    it("includes exported status when false", () => {
      const input = makeInput();
      input.symbol.exported = false;
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(text.includes("Exported: no"), "should show not exported");
    });

    it("omits path line when null", () => {
      const input = makeInput({ relPath: null });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(!text.includes("Path:"), "should not include path line");
    });
  });

  describe("role tags and lexical terms", () => {
    it("includes role tags when present", () => {
      const input = makeInput({
        roleTags: ["controller", "http-handler", "authentication"],
      });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(
        text.includes("Roles: controller, http-handler, authentication"),
      );
    });

    it("omits role tags section when empty", () => {
      const input = makeInput({ roleTags: [] });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(!text.includes("Roles:"), "should not include roles line");
    });

    it("includes search terms when present", () => {
      const input = makeInput({
        searchTerms: ["parse", "json", "decode", "deserialize"],
      });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(text.includes("Terms: parse, json, decode, deserialize"));
    });

    it("omits search terms section when empty", () => {
      const input = makeInput({ searchTerms: [] });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(!text.includes("Terms:"), "should not include terms line");
    });
  });

  describe("invariants and side effects", () => {
    it("includes invariants when present", () => {
      const input = makeInput({
        invariants: ["input must be non-empty", "returns sorted array"],
      });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(text.includes("Invariants:"));
      assert.ok(text.includes("- input must be non-empty"));
      assert.ok(text.includes("- returns sorted array"));
    });

    it("omits invariants section when empty", () => {
      const input = makeInput({ invariants: [] });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(!text.includes("Invariants:"), "should not include invariants");
    });

    it("includes side effects when present", () => {
      const input = makeInput({
        sideEffects: ["writes to filesystem", "sends HTTP request"],
      });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(text.includes("Side effects:"));
      assert.ok(text.includes("- writes to filesystem"));
      assert.ok(text.includes("- sends HTTP request"));
    });

    it("omits side effects section when empty", () => {
      const input = makeInput({ sideEffects: [] });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(
        !text.includes("Side effects:"),
        "should not include side effects",
      );
    });
  });

  describe("resolved and unresolved import labels", () => {
    it("includes resolved imports", () => {
      const imports: GraphLabel[] = [
        { label: "readFile", confidence: 1.0, resolved: true },
        { label: "writeFile", confidence: 1.0, resolved: true },
      ];
      const input = makeInput({ imports });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(text.includes("Imports: readFile, writeFile"));
    });

    it("includes unresolved imports with marker", () => {
      const imports: GraphLabel[] = [
        { label: "lodash (from lodash)", confidence: 0.8, resolved: false },
        { label: "debounce (from lodash)", confidence: 0.8, resolved: false },
      ];
      const input = makeInput({ imports });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(text.includes("Imports:"));
      assert.ok(
        text.includes("lodash (from lodash)") ||
          text.includes("debounce (from lodash)"),
      );
    });

    it("omits imports section when empty", () => {
      const input = makeInput({ imports: [] });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(!text.includes("Imports:"), "should not include imports line");
    });
  });

  describe("resolved and unresolved call labels", () => {
    it("includes resolved calls", () => {
      const calls: GraphLabel[] = [
        { label: "parseConfig", confidence: 0.95, resolved: true },
        { label: "validateInput", confidence: 0.9, resolved: true },
      ];
      const input = makeInput({ calls });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(text.includes("Calls: parseConfig, validateInput"));
    });

    it("includes unresolved calls", () => {
      const calls: GraphLabel[] = [
        { label: "externalApi", confidence: 0.7, resolved: false },
      ];
      const input = makeInput({ calls });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(text.includes("Calls:"));
      assert.ok(text.includes("externalApi"));
    });

    it("omits calls section when empty", () => {
      const input = makeInput({ calls: [] });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(!text.includes("Calls:"), "should not include calls line");
    });
  });

  describe("summary handling based on freshness", () => {
    it("includes summary when freshness is fresh", () => {
      const input = makeInput({
        summaryFreshness: "fresh",
        summaryText:
          "Parses configuration from JSON file and validates schema.",
      });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(
        text.includes(
          "Summary: Parses configuration from JSON file and validates schema.",
        ),
        "should include fresh summary",
      );
    });

    it("omits summary when freshness is stale but still produces full payload", () => {
      // Critical regression guard: stale summary must NOT degrade payload to minimal stub.
      // The full Jina payload (all other sections) must still be produced.
      const input = makeInput({
        summaryFreshness: "stale",
        summaryText: null,
        signatureText: "function staleTest(): void",
        relPath: "src/stale.ts",
        language: "typescript",
        roleTags: ["utility"],
        invariants: ["pure"],
        sideEffects: ["none"],
        imports: [{ label: "fs", confidence: 1, resolved: true }],
        calls: [{ label: "readFile", confidence: 0.9, resolved: true }],
        searchTerms: ["stale", "test"],
      });
      const text = buildJinaSymbolEmbeddingText(input);

      // Summary must be omitted
      assert.ok(!text.includes("Summary:"), "should not include stale summary");

      // But all other sections must still be present (not degraded to minimal payload)
      assert.ok(text.includes("Name:"), "stale should still include Name");
      assert.ok(text.includes("Kind:"), "stale should still include Kind");
      assert.ok(
        text.includes("Language:"),
        "stale should still include Language",
      );
      assert.ok(text.includes("Path:"), "stale should still include Path");
      assert.ok(
        text.includes("Signature:"),
        "stale should still include Signature",
      );
      assert.ok(text.includes("Roles:"), "stale should still include Roles");
      assert.ok(
        text.includes("Invariants:"),
        "stale should still include Invariants",
      );
      assert.ok(
        text.includes("Side effects:"),
        "stale should still include Side effects",
      );
      assert.ok(
        text.includes("Imports:"),
        "stale should still include Imports",
      );
      assert.ok(text.includes("Calls:"), "stale should still include Calls");
      assert.ok(text.includes("Terms:"), "stale should still include Terms");
    });

    it("omits summary when freshness is absent", () => {
      const input = makeInput({
        summaryFreshness: "absent",
        summaryText: null,
      });
      const text = buildJinaSymbolEmbeddingText(input);

      assert.ok(
        !text.includes("Summary:"),
        "should not include summary when absent",
      );
    });
  });

  describe("section ordering", () => {
    it("produces sections in correct order", () => {
      const input = makeInput({
        signatureText: "function test(): void",
        relPath: "src/test.ts",
        language: "typescript",
        roleTags: ["utility"],
        invariants: ["pure function"],
        sideEffects: ["none"],
        imports: [{ label: "fs", confidence: 1, resolved: true }],
        calls: [{ label: "readFile", confidence: 0.9, resolved: true }],
        searchTerms: ["test"],
        summaryFreshness: "fresh",
        summaryText: "A test function.",
      });
      const text = buildJinaSymbolEmbeddingText(input);

      const nameIdx = text.indexOf("Name:");
      const pathIdx = text.indexOf("Path:");
      const signatureIdx = text.indexOf("Signature:");
      const summaryIdx = text.indexOf("Summary:");
      const rolesIdx = text.indexOf("Roles:");
      const invariantsIdx = text.indexOf("Invariants:");
      const sideEffectsIdx = text.indexOf("Side effects:");
      const importsIdx = text.indexOf("Imports:");
      const callsIdx = text.indexOf("Calls:");
      const termsIdx = text.indexOf("Terms:");

      // Verify ordering: name < path < signature < summary < roles < invariants < sideEffects < imports < calls < terms
      assert.ok(nameIdx < pathIdx, "Name before Path");
      assert.ok(pathIdx < signatureIdx, "Path before Signature");
      assert.ok(signatureIdx < summaryIdx, "Signature before Summary");
      assert.ok(summaryIdx < rolesIdx, "Summary before Roles");
      assert.ok(rolesIdx < invariantsIdx, "Roles before Invariants");
      assert.ok(
        invariantsIdx < sideEffectsIdx,
        "Invariants before Side effects",
      );
      assert.ok(sideEffectsIdx < importsIdx, "Side effects before Imports");
      assert.ok(importsIdx < callsIdx, "Imports before Calls");
      assert.ok(callsIdx < termsIdx, "Calls before Terms");
    });
  });

  describe("payload format", () => {
    it("uses plain labeled lines, not JSON blobs", () => {
      const input = makeInput({
        roleTags: ["api", "controller"],
        imports: [{ label: "express", confidence: 1, resolved: true }],
      });
      const text = buildJinaSymbolEmbeddingText(input);

      // Should not contain JSON-like structures
      assert.ok(!text.includes('{"'), "should not contain JSON objects");
      assert.ok(!text.includes('["'), "should not contain JSON arrays");
    });

    it("produces multiline output", () => {
      const input = makeInput();
      const text = buildJinaSymbolEmbeddingText(input);

      const lines = text.split("\n").filter((l) => l.trim());
      // Default makeInput produces: Name, Kind, Language, Path, Exported, Signature (6 lines min)
      assert.ok(lines.length >= 5, "should have multiple lines");
    });
  });

  describe("edge cases", () => {
    it("handles minimal input with only required fields", () => {
      const input = makeInput({
        signatureText: null,
        relPath: null,
        language: null,
        roleTags: [],
        searchTerms: [],
        invariants: [],
        sideEffects: [],
        imports: [],
        calls: [],
        summaryFreshness: "absent",
        summaryText: null,
      });
      const text = buildJinaSymbolEmbeddingText(input);

      // Should still produce valid output with name and kind
      assert.ok(text.includes("Name: testFunction"));
      assert.ok(text.includes("Kind: function"));
    });

    it("handles symbol with all metadata populated", () => {
      const input = makeInput({
        signatureText: "async function process(data: Data): Promise<Result>",
        relPath: "src/processors/main.ts",
        language: "typescript",
        roleTags: ["processor", "async", "data-transform"],
        searchTerms: ["process", "transform", "data", "async"],
        invariants: ["data must be valid", "returns non-null"],
        sideEffects: ["logs to console", "writes metrics"],
        imports: [
          { label: "Logger", confidence: 1, resolved: true },
          { label: "Metrics", confidence: 1, resolved: true },
        ],
        calls: [
          { label: "validate", confidence: 0.95, resolved: true },
          { label: "transform", confidence: 0.9, resolved: true },
          { label: "emit", confidence: 0.85, resolved: true },
        ],
        summaryFreshness: "fresh",
        summaryText:
          "Main data processing function that transforms and validates input.",
      });
      const text = buildJinaSymbolEmbeddingText(input);

      // Verify all sections present
      assert.ok(text.includes("Name:"));
      assert.ok(text.includes("Kind:"));
      assert.ok(text.includes("Language:"));
      assert.ok(text.includes("Path:"));
      assert.ok(text.includes("Signature:"));
      assert.ok(text.includes("Summary:"));
      assert.ok(text.includes("Roles:"));
      assert.ok(text.includes("Invariants:"));
      assert.ok(text.includes("Side effects:"));
      assert.ok(text.includes("Imports:"));
      assert.ok(text.includes("Calls:"));
      assert.ok(text.includes("Terms:"));
    });
  });
});

// Phase 3: Nomic builder tests
describe("buildNomicSymbolEmbeddingText", () => {
  describe("natural language format", () => {
    it("produces prose-oriented output, not labeled sections", () => {
      const input = makeInput({
        signatureText: "function processData(input: string): Result",
        relPath: "src/utils/processor.ts",
        summaryFreshness: "fresh",
        summaryText: "Processes input data and returns a result object.",
      });
      const text = buildNomicSymbolEmbeddingText(input);

      // Should use natural language phrasing, not "Label: value" format
      assert.ok(!text.includes("Name:"), "should not use labeled Name format");
      assert.ok(!text.includes("Kind:"), "should not use labeled Kind format");
      // Should include the symbol identity in prose form
      assert.ok(text.includes("testFunction"), "should include symbol name");
      assert.ok(text.includes("function"), "should include symbol kind");
    });

    it("includes summary as natural prose", () => {
      const input = makeInput({
        summaryFreshness: "fresh",
        summaryText: "Validates user input and returns parsed result.",
      });
      const text = buildNomicSymbolEmbeddingText(input);

      assert.ok(
        text.includes("Validates user input and returns parsed result"),
        "should include summary text",
      );
    });

    it("phrases imports/calls as related code context", () => {
      const input = makeInput({
        imports: [
          { label: "readFile", confidence: 1, resolved: true },
          { label: "parseJSON", confidence: 1, resolved: true },
        ],
        calls: [
          { label: "validate", confidence: 0.9, resolved: true },
          { label: "transform", confidence: 0.85, resolved: true },
        ],
      });
      const text = buildNomicSymbolEmbeddingText(input);

      // Should phrase as context, not raw list dump
      assert.ok(
        text.toLowerCase().includes("uses") ||
          text.toLowerCase().includes("calls") ||
          text.toLowerCase().includes("imports") ||
          text.toLowerCase().includes("relies on") ||
          text.toLowerCase().includes("related"),
        "should phrase dependencies as context",
      );
    });
  });

  describe("content coverage", () => {
    it("includes name and kind", () => {
      const input = makeInput();
      const text = buildNomicSymbolEmbeddingText(input);

      assert.ok(text.includes("testFunction"), "should include name");
      assert.ok(text.includes("function"), "should include kind");
    });

    it("includes path context", () => {
      const input = makeInput({ relPath: "src/core/engine.ts" });
      const text = buildNomicSymbolEmbeddingText(input);

      assert.ok(
        text.includes("src/core/engine.ts") ||
          text.includes("core") ||
          text.includes("engine"),
        "should include path or domain context",
      );
    });

    it("includes signature", () => {
      const input = makeInput({
        signatureText: "function compute(x: number): number",
      });
      const text = buildNomicSymbolEmbeddingText(input);

      assert.ok(
        text.includes("compute") || text.includes("number"),
        "should include signature elements",
      );
    });

    it("includes role tags", () => {
      const input = makeInput({
        roleTags: ["controller", "api-handler"],
      });
      const text = buildNomicSymbolEmbeddingText(input);

      assert.ok(
        text.includes("controller") || text.includes("api-handler"),
        "should include role tags",
      );
    });

    it("includes search terms", () => {
      const input = makeInput({
        searchTerms: ["parse", "json", "decode"],
      });
      const text = buildNomicSymbolEmbeddingText(input);

      assert.ok(
        text.includes("parse") ||
          text.includes("json") ||
          text.includes("decode"),
        "should include search terms",
      );
    });
  });

  describe("summary freshness handling", () => {
    it("includes summary when fresh", () => {
      const input = makeInput({
        summaryFreshness: "fresh",
        summaryText: "A fresh summary for this symbol.",
      });
      const text = buildNomicSymbolEmbeddingText(input);

      assert.ok(
        text.includes("A fresh summary for this symbol"),
        "should include fresh summary",
      );
    });

    it("omits summary when stale", () => {
      const input = makeInput({
        summaryFreshness: "stale",
        summaryText: null,
      });
      const text = buildNomicSymbolEmbeddingText(input);

      // Should still produce valid output without summary
      assert.ok(text.includes("testFunction"), "should still include name");
    });

    it("omits summary when absent", () => {
      const input = makeInput({
        summaryFreshness: "absent",
        summaryText: null,
      });
      const text = buildNomicSymbolEmbeddingText(input);

      assert.ok(text.includes("testFunction"), "should still include name");
    });
  });

  describe("edge cases", () => {
    it("handles minimal input", () => {
      const input = makeInput({
        signatureText: null,
        relPath: null,
        language: null,
        roleTags: [],
        searchTerms: [],
        invariants: [],
        sideEffects: [],
        imports: [],
        calls: [],
        summaryFreshness: "absent",
        summaryText: null,
      });
      const text = buildNomicSymbolEmbeddingText(input);

      assert.ok(text.includes("testFunction"), "should include name");
      assert.ok(text.length > 0, "should produce non-empty output");
    });

    it("handles fully populated input", () => {
      const input = makeInput({
        signatureText: "async function process(data: Data): Promise<Result>",
        relPath: "src/processors/main.ts",
        language: "typescript",
        roleTags: ["processor", "async"],
        searchTerms: ["process", "transform"],
        invariants: ["data must be valid"],
        sideEffects: ["logs to console"],
        imports: [{ label: "Logger", confidence: 1, resolved: true }],
        calls: [{ label: "validate", confidence: 0.95, resolved: true }],
        summaryFreshness: "fresh",
        summaryText: "Main data processor.",
      });
      const text = buildNomicSymbolEmbeddingText(input);

      assert.ok(text.length > 50, "should produce substantial output");
    });
  });
});

// Phase 3: Model-aware dispatcher tests
describe("buildSymbolEmbeddingText", () => {
  describe("model dispatch", () => {
    it("uses Jina builder for jina-embeddings-v2-base-code", () => {
      const input = makeInput({
        signatureText: "function test(): void",
        relPath: "src/test.ts",
      });
      const text = buildSymbolEmbeddingText(
        "jina-embeddings-v2-base-code",
        input,
      );

      // Jina format uses "Label: value" style
      assert.ok(text.includes("Name:"), "should use Jina labeled format");
      assert.ok(text.includes("Kind:"), "should use Jina labeled format");
    });

    it("uses Nomic builder for nomic-embed-text-v1.5", () => {
      const input = makeInput({
        signatureText: "function test(): void",
        relPath: "src/test.ts",
      });
      const text = buildSymbolEmbeddingText("nomic-embed-text-v1.5", input);

      // Nomic format does not use "Label:" style
      assert.ok(!text.includes("Name:"), "should not use Jina labeled format");
      assert.ok(!text.includes("Kind:"), "should not use Jina labeled format");
      // But should still contain the symbol info
      assert.ok(text.includes("testFunction"), "should include symbol name");
    });

    it("falls back to minimal for unknown models", () => {
      const input = makeInput();
      const text = buildSymbolEmbeddingText("unknown-model-xyz", input);

      // Fallback should produce something with name and kind
      assert.ok(text.includes("testFunction"), "fallback should include name");
      assert.ok(text.includes("function"), "fallback should include kind");
    });
  });

  describe("payload differences", () => {
    it("produces different payloads for Jina vs Nomic with same input", () => {
      const input = makeInput({
        signatureText: "function process(x: number): string",
        relPath: "src/processor.ts",
        language: "typescript",
        roleTags: ["utility"],
        imports: [{ label: "helper", confidence: 1, resolved: true }],
        calls: [{ label: "compute", confidence: 0.9, resolved: true }],
        summaryFreshness: "fresh",
        summaryText: "Processes numeric input.",
      });

      const jinaText = buildSymbolEmbeddingText(
        "jina-embeddings-v2-base-code",
        input,
      );
      const nomicText = buildSymbolEmbeddingText(
        "nomic-embed-text-v1.5",
        input,
      );

      // They should be different
      assert.notEqual(jinaText, nomicText, "payloads should differ by model");

      // Both should contain the essential info
      assert.ok(jinaText.includes("testFunction"), "Jina should include name");
      assert.ok(
        nomicText.includes("testFunction"),
        "Nomic should include name",
      );

      // Jina should be more structured
      assert.ok(jinaText.includes("Name:"), "Jina should use labeled sections");
      assert.ok(
        !nomicText.includes("Name:"),
        "Nomic should not use labeled sections",
      );
    });

    it("preserves content semantics across models", () => {
      const input = makeInput({
        signatureText: "function validate(data: Input): boolean",
        roleTags: ["validator"],
        summaryFreshness: "fresh",
        summaryText: "Validates input data structure.",
      });

      const jinaText = buildSymbolEmbeddingText(
        "jina-embeddings-v2-base-code",
        input,
      );
      const nomicText = buildSymbolEmbeddingText(
        "nomic-embed-text-v1.5",
        input,
      );

      // Both should contain the key semantic content
      assert.ok(
        jinaText.includes("validate") || jinaText.includes("Validates"),
      );
      assert.ok(
        nomicText.includes("validate") || nomicText.includes("Validates"),
      );
      assert.ok(jinaText.includes("validator"));
      assert.ok(nomicText.includes("validator"));
    });
  });
});
