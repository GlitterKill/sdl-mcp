import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectIdentifierSourceEdits,
  collectStructuralSourceEdits,
  type StructuralSourceEdit,
} from "../../dist/mcp/tools/search-edit/structural.js";

function applyEdits(content: string, edits: StructuralSourceEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    chunks.push(content.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  chunks.push(content.slice(cursor));
  return chunks.join("");
}

describe("search-edit structural matcher", () => {
  it("replaces exact AST identifiers without touching strings or comments", () => {
    const content = [
      "const oldName = 1;",
      'const text = "oldName";',
      "// oldName should stay in comments",
      "oldName();",
      "object.oldName;",
      "",
    ].join("\n");

    const edits = collectIdentifierSourceEdits({
      content,
      relPath: "src/example.ts",
      literal: "oldName",
      replacement: "newName",
      global: true,
    });

    assert.equal(edits.length, 3);
    const updated = applyEdits(content, edits);
    assert.match(updated, /const newName = 1/);
    assert.match(updated, /newName\(\);/);
    assert.match(updated, /object\.newName;/);
    assert.match(updated, /const text = "oldName";/);
    assert.match(updated, /\/\/ oldName should stay in comments/);
  });

  it("targets tree-sitter query captures with capture interpolation", () => {
    const content = ['oldName("a");', 'other("b");', ""].join("\n");

    const edits = collectStructuralSourceEdits({
      content,
      relPath: "src/example.ts",
      structural: {
        treeSitterQuery: `
          (call_expression
            function: (identifier) @callee
            arguments: (arguments) @args) @target
        `,
        requiredCaptures: { callee: "oldName" },
      },
      replacement: "newName$args",
      global: true,
    });

    assert.equal(edits.length, 1);
    assert.equal(
      edits[0].captures.some((capture) => capture.name === "args"),
      true,
    );
    assert.equal(applyEdits(content, edits), 'newName("a");\nother("b");\n');
  });

  it("throws a validation error for malformed structural queries", () => {
    assert.throws(
      () =>
        collectStructuralSourceEdits({
          content: 'oldName("a");\n',
          relPath: "src/example.ts",
          structural: {
            treeSitterQuery: "(call_expression",
          },
          replacement: "newName()",
          global: true,
        }),
      /Invalid structural tree-sitter query/,
    );
  });

  it("supports JSX/TSX captures through the TSX grammar", () => {
    const content = "export const View = () => <Button oldName={value} />;\n";

    const edits = collectStructuralSourceEdits({
      content,
      relPath: "src/view.tsx",
      structural: {
        treeSitterQuery: `
          (jsx_attribute
            (property_identifier) @name) @target
        `,
        requiredCaptures: { name: "oldName" },
      },
      replacement: "newName={value}",
      global: true,
    });

    assert.equal(edits.length, 1);
    assert.equal(
      applyEdits(content, edits),
      "export const View = () => <Button newName={value} />;\n",
    );
  });
});
