import { describe, it } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("tsTreesitter wrapper", () => {
  it("parseFile parses .ts content", () => {
    const {
      parseFile,
    } = require("../../dist/indexer/treesitter/tsTreesitter.js");

    const result = parseFile(
      "function add(a: number, b: number) { return a + b; }",
      ".ts",
    );

    assert.ok(result, "Expected parse result for .ts");
    assert.strictEqual(result.language, "typescript");
    assert.strictEqual(result.tree.rootNode.hasError, false);
  });

  it("parseFile parses .tsx content with JSX syntax", () => {
    const {
      parseFile,
    } = require("../../dist/indexer/treesitter/tsTreesitter.js");

    const result = parseFile(
      "export const App = () => <section><h1>Hello</h1></section>;",
      ".tsx",
    );

    assert.ok(result, "Expected parse result for .tsx");
    assert.strictEqual(result.language, "typescript");
    assert.strictEqual(result.tree.rootNode.hasError, false);
  });

  it("parseFile parses .js content", () => {
    const {
      parseFile,
    } = require("../../dist/indexer/treesitter/tsTreesitter.js");

    const result = parseFile("const value = 1 + 2;", ".js");

    assert.ok(result, "Expected parse result for .js");
    assert.strictEqual(result.language, "typescript");
    assert.strictEqual(result.tree.rootNode.hasError, false);
  });

  it("parseFile returns null for unsupported extensions", () => {
    const {
      parseFile,
    } = require("../../dist/indexer/treesitter/tsTreesitter.js");

    assert.strictEqual(parseFile("print('hi')", ".py"), null);
    assert.strictEqual(parseFile("package main", ".go"), null);
  });

  it("parseFile returns null for invalid TypeScript", () => {
    const {
      parseFile,
    } = require("../../dist/indexer/treesitter/tsTreesitter.js");

    const result = parseFile("function broken( {", ".ts");

    assert.strictEqual(result, null);
  });

  it("queryTree returns matches for valid query", () => {
    const {
      parseFile,
      queryTree,
    } = require("../../dist/indexer/treesitter/tsTreesitter.js");
    const parseResult = parseFile(
      "function alpha() { return 1; } function beta() { return 2; }",
      ".ts",
    );

    assert.ok(parseResult, "Expected parse result for query test");

    const matches = queryTree(
      parseResult.tree,
      "(function_declaration name: (identifier) @fnName)",
    );

    assert.ok(Array.isArray(matches));
    assert.strictEqual(matches.length, 2);
    assert.strictEqual(matches[0].captures[0].name, "fnName");
    assert.strictEqual(matches[0].captures[0].node.text, "alpha");
  });

  it("queryTree returns empty array for invalid query", () => {
    const {
      parseFile,
      queryTree,
    } = require("../../dist/indexer/treesitter/tsTreesitter.js");
    const parseResult = parseFile("const value = 42;", ".ts");

    assert.ok(parseResult, "Expected parse result for invalid-query test");

    const matches = queryTree(parseResult.tree, "(((not-valid-query");

    assert.deepStrictEqual(matches, []);
  });

  it("queryTree returns empty array when query has no matches", () => {
    const {
      parseFile,
      queryTree,
    } = require("../../dist/indexer/treesitter/tsTreesitter.js");
    const parseResult = parseFile("const value = 42;", ".ts");

    assert.ok(parseResult, "Expected parse result for no-match test");

    const matches = queryTree(
      parseResult.tree,
      "(class_declaration name: (type_identifier) @className)",
    );

    assert.deepStrictEqual(matches, []);
  });
});
