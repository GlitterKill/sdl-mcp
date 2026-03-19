import { describe, it } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("ts-parsers shared instances", () => {
  it("exports tsParser as a Parser instance", () => {
    const Parser = require("tree-sitter");
    const { tsParser } = require("../../dist/code/ts-parsers.js");

    assert.ok(tsParser instanceof Parser);
  });

  it("exports tsxParser as a Parser instance", () => {
    const Parser = require("tree-sitter");
    const { tsxParser } = require("../../dist/code/ts-parsers.js");

    assert.ok(tsxParser instanceof Parser);
  });

  it("tsParser parses valid TypeScript", () => {
    const { tsParser } = require("../../dist/code/ts-parsers.js");

    const tree = tsParser.parse(
      "type UserId = string; const id: UserId = 'x';",
    );

    assert.ok(tree);
    assert.strictEqual(tree.rootNode.hasError, false);
  });

  it("tsxParser parses valid TSX", () => {
    const { tsxParser } = require("../../dist/code/ts-parsers.js");

    const tree = tsxParser.parse(
      "export const Card = () => <div className='x'>ok</div>;",
    );

    assert.ok(tree);
    assert.strictEqual(tree.rootNode.hasError, false);
  });

  it("tsxParser parses plain TypeScript too", () => {
    const { tsxParser } = require("../../dist/code/ts-parsers.js");

    const tree = tsxParser.parse("interface Config { retries: number; }");

    assert.ok(tree);
    assert.strictEqual(tree.rootNode.hasError, false);
  });

  it("tsParser reports error on TSX JSX syntax", () => {
    const { tsParser } = require("../../dist/code/ts-parsers.js");

    const tree = tsParser.parse("const view = <div />;");

    assert.ok(tree);
    assert.strictEqual(tree.rootNode.hasError, true);
  });
});
