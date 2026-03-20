import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { extractCalls, type ExtractedSymbol } from "../../src/indexer/treesitter/extractCalls.js";

const require = createRequire(import.meta.url);

function parseTypeScript(code: string): any {
  const TypeScript = require("tree-sitter-typescript");
  const Parser = require("tree-sitter");
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code);
}

describe("extractCalls", () => {
  it("resolves this.method() to the method on the enclosing class when duplicate method names exist", () => {
    const code = `
class First {
  render() {}
}

class Second {
  render() {}

  show() {
    this.render();
  }
}
`.trim();
    const tree = parseTypeScript(code);
    const symbols: ExtractedSymbol[] = [
      {
        nodeId: "first-class",
        kind: "class",
        name: "First",
        exported: false,
        range: { startLine: 1, startCol: 0, endLine: 3, endCol: 1 },
      },
      {
        nodeId: "first-render",
        kind: "method",
        name: "render",
        exported: false,
        range: { startLine: 2, startCol: 2, endLine: 2, endCol: 13 },
      },
      {
        nodeId: "second-class",
        kind: "class",
        name: "Second",
        exported: false,
        range: { startLine: 5, startCol: 0, endLine: 11, endCol: 1 },
      },
      {
        nodeId: "second-render",
        kind: "method",
        name: "render",
        exported: false,
        range: { startLine: 6, startCol: 2, endLine: 6, endCol: 13 },
      },
      {
        nodeId: "second-show",
        kind: "method",
        name: "show",
        exported: false,
        range: { startLine: 8, startCol: 2, endLine: 10, endCol: 3 },
      },
    ];

    const calls = extractCalls(tree, symbols);
    const thisRenderCall = calls.find(
      (call) => call.calleeIdentifier === "render" && call.callType === "method",
    );

    assert.ok(thisRenderCall, "expected this.render() call");
    assert.equal(thisRenderCall.calleeSymbolId, "second-render");
    assert.equal(thisRenderCall.callerNodeId, "second-show");
  });

  it("resolves super.method() to the inherited class method instead of an unrelated duplicate", () => {
    const code = `
function init() {}

class Base {
  init() {}
}

class Child extends Base {
  init() {}

  run() {
    super.init();
  }
}
`.trim();
    const tree = parseTypeScript(code);
    const symbols: ExtractedSymbol[] = [
      {
        nodeId: "top-init",
        kind: "function",
        name: "init",
        exported: false,
        range: { startLine: 1, startCol: 0, endLine: 1, endCol: 18 },
      },
      {
        nodeId: "base-class",
        kind: "class",
        name: "Base",
        exported: false,
        range: { startLine: 3, startCol: 0, endLine: 5, endCol: 1 },
      },
      {
        nodeId: "base-init",
        kind: "method",
        name: "init",
        exported: false,
        range: { startLine: 4, startCol: 2, endLine: 4, endCol: 11 },
      },
      {
        nodeId: "child-class",
        kind: "class",
        name: "Child",
        exported: false,
        range: { startLine: 7, startCol: 0, endLine: 13, endCol: 1 },
      },
      {
        nodeId: "child-init",
        kind: "method",
        name: "init",
        exported: false,
        range: { startLine: 8, startCol: 2, endLine: 8, endCol: 11 },
      },
      {
        nodeId: "child-run",
        kind: "method",
        name: "run",
        exported: false,
        range: { startLine: 10, startCol: 2, endLine: 12, endCol: 3 },
      },
    ];

    const calls = extractCalls(tree, symbols);
    const superInitCall = calls.find(
      (call) => call.calleeIdentifier === "init" && call.callType === "method",
    );

    assert.ok(superInitCall, "expected super.init() call");
    assert.equal(superInitCall.calleeSymbolId, "base-init");
    assert.equal(superInitCall.callerNodeId, "child-run");
  });
});
