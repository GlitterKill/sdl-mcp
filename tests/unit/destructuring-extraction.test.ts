import { describe, it } from "node:test";
import assert from "node:assert";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import { extractSymbols } from "../../dist/indexer/treesitter/extractSymbols.js";

const parser = new Parser();
parser.setLanguage(TypeScript.typescript);

describe("Destructuring Variable Extraction", () => {
  it("should extract all bindings from object destructuring", () => {
    const code = `const { foo, bar, baz } = getConfig();`;
    const tree = parser.parse(code);
    const symbols = extractSymbols(tree);

    const names = symbols.map((s) => s.name);
    assert.ok(names.includes("foo"), `Expected 'foo' in ${JSON.stringify(names)}`);
    assert.ok(names.includes("bar"), `Expected 'bar' in ${JSON.stringify(names)}`);
    assert.ok(names.includes("baz"), `Expected 'baz' in ${JSON.stringify(names)}`);
  });

  it("should extract all bindings from array destructuring", () => {
    const code = `const [first, second, third] = getValues();`;
    const tree = parser.parse(code);
    const symbols = extractSymbols(tree);

    const names = symbols.map((s) => s.name);
    assert.ok(names.includes("first"), `Expected 'first' in ${JSON.stringify(names)}`);
    assert.ok(names.includes("second"), `Expected 'second' in ${JSON.stringify(names)}`);
    assert.ok(names.includes("third"), `Expected 'third' in ${JSON.stringify(names)}`);
  });

  it("should mark destructured bindings as exported when applicable", () => {
    const code = `export const { host, port } = config;`;
    const tree = parser.parse(code);
    const symbols = extractSymbols(tree);

    const exported = symbols.filter((s) => s.exported);
    const exportedNames = exported.map((s) => s.name);
    assert.ok(exportedNames.includes("host"), `Expected 'host' to be exported`);
    assert.ok(exportedNames.includes("port"), `Expected 'port' to be exported`);
  });

  it("should handle simple variable declarations normally", () => {
    const code = `const value = 42;`;
    const tree = parser.parse(code);
    const symbols = extractSymbols(tree);

    assert.ok(symbols.some((s) => s.name === "value"));
  });
});
