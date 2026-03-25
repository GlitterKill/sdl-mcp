import { describe, it } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("ts-parsers lazy instances", () => {
  it("getTsParser returns a Parser instance", () => {
    const Parser = require("tree-sitter");
    const { getTsParser } = require("../../dist/code/ts-parsers.js");

    assert.ok(getTsParser() instanceof Parser);
  });

  it("getTsxParser returns a Parser instance", () => {
    const Parser = require("tree-sitter");
    const { getTsxParser } = require("../../dist/code/ts-parsers.js");

    assert.ok(getTsxParser() instanceof Parser);
  });

  it("getTsParser() parses valid TypeScript", () => {
    const { getTsParser } = require("../../dist/code/ts-parsers.js");

    const tree = getTsParser().parse(
      "type UserId = string; const id: UserId = 'x';",
    );

    assert.ok(tree);
    assert.strictEqual(tree.rootNode.hasError, false);
  });

  it("getTsxParser() parses valid TSX", () => {
    const { getTsxParser } = require("../../dist/code/ts-parsers.js");

    const tree = getTsxParser().parse(
      "export const Card = () => <div className='x'>ok</div>;",
    );

    assert.ok(tree);
    assert.strictEqual(tree.rootNode.hasError, false);
  });

  it("getTsxParser() parses plain TypeScript too", () => {
    const { getTsxParser } = require("../../dist/code/ts-parsers.js");

    const tree = getTsxParser().parse("interface Config { retries: number; }");

    assert.ok(tree);
    assert.strictEqual(tree.rootNode.hasError, false);
  });

  it("getTsParser() reports error on TSX JSX syntax", () => {
    const { getTsParser } = require("../../dist/code/ts-parsers.js");

    const tree = getTsParser().parse("const view = <div />;");

    assert.ok(tree);
    assert.strictEqual(tree.rootNode.hasError, true);
  });
});
