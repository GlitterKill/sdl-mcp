import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSearchEditPreviewSnippets } from "../../dist/mcp/tools/search-edit/planner.js";

describe("buildSearchEditPreviewSnippets", () => {
  it("returns line-numbered hunks around regex replacements", () => {
    const before = [
      "const keep = 1;",
      "function target() {",
      "  return foo();",
      "}",
      "const after = 2;",
    ].join("\n");
    const after = before.replace("foo()", "bar()");

    const snippets = buildSearchEditPreviewSnippets(before, after, 1, /foo\(\)/);

    assert.equal(snippets.beforeStartLine, 2);
    assert.equal(snippets.beforeEndLine, 4);
    assert.equal(snippets.afterStartLine, 2);
    assert.equal(snippets.afterEndLine, 4);
    assert.match(snippets.before, />3 \|   return foo\(\);/);
    assert.match(snippets.after, />3 \|   return bar\(\);/);
    assert.doesNotMatch(snippets.before, /const keep/);
  });

  it("includes every changed line in a multi-line replacement hunk", () => {
    const before = [
      "const keep = 1;",
      "function target() {",
      "  return foo();",
      "}",
      "const after = 2;",
    ].join("\n");
    const after = [
      "const keep = 1;",
      "function target() {",
      "  const first = bar();",
      "  const second = baz();",
      "  return first + second;",
      "}",
      "const after = 2;",
    ].join("\n");

    const snippets = buildSearchEditPreviewSnippets(before, after, 1, /foo\(\)/);

    assert.equal(snippets.beforeStartLine, 2);
    assert.equal(snippets.beforeEndLine, 4);
    assert.equal(snippets.afterStartLine, 2);
    assert.equal(snippets.afterEndLine, 6);
    assert.match(snippets.before, />3 \|   return foo\(\);/);
    assert.match(snippets.after, />3 \|   const first = bar\(\);/);
    assert.match(snippets.after, />4 \|   const second = baz\(\);/);
    assert.match(snippets.after, />5 \|   return first \+ second;/);
    assert.match(snippets.after, / 6 \| }/);
  });

  it("falls back to the first changed line when no regex anchor exists", () => {
    const snippets = buildSearchEditPreviewSnippets(
      ["alpha", "beta", "gamma"].join("\n"),
      ["alpha", "delta", "gamma"].join("\n"),
      0,
      null,
    );

    assert.equal(snippets.beforeStartLine, 2);
    assert.equal(snippets.beforeEndLine, 2);
    assert.equal(snippets.afterStartLine, 2);
    assert.equal(snippets.afterEndLine, 2);
    assert.equal(snippets.before, ">2 | beta");
    assert.equal(snippets.after, ">2 | delta");
  });

  it("bounds distant multi-match replacements to an anchored preview hunk", () => {
    const beforeLines = [
      "first foo();",
      ...Array.from({ length: 120 }, (_, index) => `unchanged ${index}`),
      "second foo();",
    ];
    const before = beforeLines.join("\n");
    const after = before.replace(/foo\(\)/g, "bar()");

    const snippets = buildSearchEditPreviewSnippets(before, after, 2, /foo\(\)/g);

    assert.ok(snippets.before.split("\n").length <= 5);
    assert.ok(snippets.after.split("\n").length <= 5);
    assert.match(snippets.before, />1 \| first foo\(\);/);
    assert.match(snippets.after, />1 \| first bar\(\);/);
    assert.doesNotMatch(snippets.before, /second foo/);
    assert.doesNotMatch(snippets.after, /second bar/);
  });
});
