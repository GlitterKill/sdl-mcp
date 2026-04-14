/**
 * Tests for symbol-embedding-text.ts - model-aware payload builders.
 * Phase 2: Jina structured payload with graph context.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildJinaSymbolEmbeddingText } from "../../dist/indexer/symbol-embedding-text.js";
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
      id: "sym-test-001",
      repoId: "test-repo",
      fileId: "file-001",
      name: "testFunction",
      kind: "function",
      signatureJson: '{"text":"function testFunction(a: string): void"}',
      startLine: 10,
      endLine: 20,
      startCol: 0,
      endCol: 1,
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
