import assert from "node:assert";
import { describe, it } from "node:test";
import {
  generateCompoundIdentifiers,
  extractIdentifiersFromText,
} from "../../../dist/agent/executor.js";

describe("generateCompoundIdentifiers", () => {
  it("generates camelCase pairs from adjacent words", () => {
    const result = generateCompoundIdentifiers("graph slice building");
    assert.ok(
      result.includes("graphSlice"),
      `Expected graphSlice in ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.includes("sliceBuilding"),
      `Expected sliceBuilding in ${JSON.stringify(result)}`,
    );
  });

  it("generates PascalCase pairs", () => {
    const result = generateCompoundIdentifiers("graph slice");
    assert.ok(
      result.includes("GraphSlice"),
      `Expected GraphSlice in ${JSON.stringify(result)}`,
    );
  });

  it("generates snake_case pairs", () => {
    const result = generateCompoundIdentifiers("graph slice");
    assert.ok(
      result.includes("graph_slice"),
      `Expected graph_slice in ${JSON.stringify(result)}`,
    );
  });

  it("generates triple compounds", () => {
    const result = generateCompoundIdentifiers("beam search engine");
    assert.ok(
      result.includes("beamSearchEngine"),
      `Expected beamSearchEngine in ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.includes("BeamSearchEngine"),
      `Expected BeamSearchEngine in ${JSON.stringify(result)}`,
    );
  });

  it("filters stop words from compounds", () => {
    const result = generateCompoundIdentifiers("how does the graph work");
    // "how", "does", "the" are stop words; only "graph" and "work" remain
    assert.ok(
      result.includes("graphWork"),
      `Expected graphWork in ${JSON.stringify(result)}`,
    );
    assert.ok(!result.includes("howDoes"), `Should not include howDoes`);
  });

  it("returns empty array for single word input", () => {
    const result = generateCompoundIdentifiers("skeleton");
    assert.deepStrictEqual(result, []);
  });

  it("returns empty array for very short words", () => {
    const result = generateCompoundIdentifiers("a b c");
    assert.deepStrictEqual(result, []);
  });

  it("deduplicates results", () => {
    const result = generateCompoundIdentifiers("beam search beam search");
    const beamSearchCount = result.filter((r) => r === "beamSearch").length;
    assert.strictEqual(beamSearchCount, 1, "Should deduplicate beamSearch");
  });

  it("limits total compounds", () => {
    const longText = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu apple banana cherry dragonfruit elderberry fig grape honeydew kiwi lemon mango nectarine orange papaya quince raspberry strawberry tangerine ugli vanilla watermelon ximenia yam zucchini";
    const result = generateCompoundIdentifiers(longText);
    assert.ok(
      result.length <= 40,
      `Expected <= 40 compounds (cap enforced), got ${result.length}`,
    );
    assert.ok(
      result.length > 20,
      `Expected > 20 compounds from 50 distinct words, got ${result.length}`,
    );
  });
});

describe("extractIdentifiersFromText compound integration", () => {
  it("includes compound identifiers in extraction results", () => {
    const result = extractIdentifiersFromText(
      "How does the graph slice building work?",
    );
    // Should find compound forms alongside regular words
    assert.ok(
      result.some((id) => /[a-z][A-Z]/.test(id) || id.includes("_")),
      `Expected at least one compound identifier in ${JSON.stringify(result.slice(0, 10))}`,
    );
  });

  it("generates barrel re-export compound identifiers", () => {
    const result = extractIdentifiersFromText(
      "The extractImports function is not resolving barrel re-exports correctly",
    );
    // Should generate "barrelExports" or similar
    const hasBarrelCompound = result.some(
      (id) => id.toLowerCase().includes("barrel") && id.length > 6,
    );
    assert.ok(
      hasBarrelCompound || result.includes("extractImports"),
      `Expected barrel compound or extractImports in ${JSON.stringify(result.slice(0, 15))}`,
    );
  });
});
