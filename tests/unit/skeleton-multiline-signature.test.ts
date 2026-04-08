import { describe, it } from "node:test";
import assert from "node:assert";
import { parseFile, extractSkeletonFromNode } from "../../dist/code/skeleton.js";

// Regression tests for multi-line function signature extraction.
// Covers the 2026-04-08 fix where lines[0] was used as the signature,
// dropping parameters and return types on wrapped signatures.

function findFirstFunctionNode(root: any): any {
  if (root.type === "function_declaration") return root;
  for (const child of root.children) {
    const found = findFirstFunctionNode(child);
    if (found) return found;
  }
  return null;
}

describe("skeleton multi-line signature", () => {
  it("preserves parameters and return type that wrap across multiple lines", () => {
    const content = [
      "export function process(",
      "  first: string,",
      "  second: number,",
      "  third: boolean,",
      "): Record<string, unknown> {",
      "  const result = { first, second, third };",
      "  return result;",
      "}",
    ].join("\n");
    const tree = parseFile(content, ".ts");
    assert.ok(tree, "tree should parse");
    const fnNode = findFirstFunctionNode(tree!.rootNode);
    assert.ok(fnNode, "should find function node");
    const skeleton = extractSkeletonFromNode(fnNode, content, []);
    // All four signature lines must survive. Before the fix only the
    // first line "export function process(" was retained.
    assert.ok(skeleton.includes("first: string"), "missing first param");
    assert.ok(skeleton.includes("second: number"), "missing second param");
    assert.ok(skeleton.includes("third: boolean"), "missing third param");
    assert.ok(skeleton.includes("Record<string, unknown>"), "missing return type");
  });

  it("handles short single-line-body functions without duplicating braces", () => {
    const content = [
      "export function tiny(): number {",
      "  return 1;",
      "}",
    ].join("\n");
    const tree = parseFile(content, ".ts");
    assert.ok(tree);
    const fnNode = findFirstFunctionNode(tree!.rootNode);
    assert.ok(fnNode);
    const skeleton = extractSkeletonFromNode(fnNode, content, []);
    // Before the stripBlockBraces fix, small bodies produced "{{ ... }}".
    assert.ok(!skeleton.includes("{{"), "should not have duplicated opening braces");
    assert.ok(!skeleton.includes("}}"), "should not have duplicated closing braces");
    assert.ok(skeleton.includes("return 1"), "body content should still be present");
  });
});
