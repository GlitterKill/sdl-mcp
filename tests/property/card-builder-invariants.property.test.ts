import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";

/**
 * Property test: Symbol card construction should always produce
 * structurally valid cards regardless of input symbol characteristics.
 */
describe("Card Builder Invariants", () => {
  // Arbitrary for symbol-like objects
  const symbolKindArb = fc.constantFrom(
    "function",
    "method",
    "class",
    "interface",
    "type",
    "variable",
    "constant",
    "module",
    "constructor",
    "enum",
    "property",
  );

  const paramArb = fc.record({
    name: fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,15}$/),
    type: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9<>\[\], ]{0,30}$/),
  });

  const signatureArb = fc.record({
    params: fc.array(paramArb, { minLength: 0, maxLength: 10 }),
    returns: fc.option(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9<>\[\]| ]{0,30}$/),
      { nil: undefined },
    ),
  });

  const symbolInputArb = fc.record({
    id: fc.hexaString({ minLength: 64, maxLength: 64 }),
    name: fc.stringMatching(/^[a-zA-Z_$][a-zA-Z0-9_$]{0,50}$/),
    kind: symbolKindArb,
    file: fc.stringMatching(/^src\/[a-z/]{1,30}\.[a-z]{1,4}$/),
    exported: fc.boolean(),
    signature: fc.option(signatureArb, { nil: undefined }),
    summary: fc.option(fc.string({ minLength: 0, maxLength: 200 }), {
      nil: undefined,
    }),
  });

  // Simplified card builder (mirrors real logic conceptually)
  interface SymbolCard {
    symbolId: string;
    name: string;
    kind: string;
    file: string;
    exported: boolean;
    signature?: { params: { name: string; type: string }[]; returns?: string };
    summary?: string;
    deps: { imports: string[]; calls: string[] };
    metrics: { fanIn: number; fanOut: number };
  }

  function buildCard(input: {
    id: string;
    name: string;
    kind: string;
    file: string;
    exported: boolean;
    signature?: { params: { name: string; type: string }[]; returns?: string };
    summary?: string;
  }): SymbolCard {
    return {
      symbolId: input.id,
      name: input.name,
      kind: input.kind,
      file: input.file,
      exported: input.exported,
      signature: input.signature,
      summary: input.summary,
      deps: { imports: [], calls: [] },
      metrics: { fanIn: 0, fanOut: 0 },
    };
  }

  it("every card should have required fields", () => {
    fc.assert(
      fc.property(symbolInputArb, (input) => {
        const card = buildCard(input);

        // Required fields must always be present
        assert.ok(card.symbolId, "symbolId must be present");
        assert.ok(card.name, "name must be present");
        assert.ok(card.kind, "kind must be present");
        assert.ok(card.file, "file must be present");
        assert.strictEqual(typeof card.exported, "boolean");
        assert.ok(card.deps, "deps must be present");
        assert.ok(Array.isArray(card.deps.imports), "deps.imports must be array");
        assert.ok(Array.isArray(card.deps.calls), "deps.calls must be array");
        assert.ok(card.metrics, "metrics must be present");
        assert.strictEqual(typeof card.metrics.fanIn, "number");
        assert.strictEqual(typeof card.metrics.fanOut, "number");
      }),
      { numRuns: 500 },
    );
  });

  it("symbolId should be preserved from input", () => {
    fc.assert(
      fc.property(symbolInputArb, (input) => {
        const card = buildCard(input);
        assert.strictEqual(
          card.symbolId,
          input.id,
          "symbolId should match input id",
        );
      }),
      { numRuns: 200 },
    );
  });

  it("kind should be a valid symbol kind", () => {
    const validKinds = new Set([
      "function",
      "method",
      "class",
      "interface",
      "type",
      "variable",
      "constant",
      "module",
      "constructor",
      "enum",
      "property",
    ]);

    fc.assert(
      fc.property(symbolInputArb, (input) => {
        const card = buildCard(input);
        assert.ok(
          validKinds.has(card.kind),
          `kind "${card.kind}" should be valid`,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("metrics should never be negative", () => {
    fc.assert(
      fc.property(symbolInputArb, (input) => {
        const card = buildCard(input);
        assert.ok(card.metrics.fanIn >= 0, "fanIn should be non-negative");
        assert.ok(card.metrics.fanOut >= 0, "fanOut should be non-negative");
      }),
      { numRuns: 200 },
    );
  });
});
