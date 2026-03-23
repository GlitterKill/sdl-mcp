import { describe, it } from "node:test";
import assert from "node:assert";

import type { Range } from "../../dist/domain/types.js";
import {
  applyBounds,
  centerOnSymbol,
  estimateTokens,
  expandToBlock,
  identifiersExistInWindow,
} from "../../dist/code/windows.js";

function makeRange(startLine: number, endLine: number): Range {
  return {
    startLine,
    startCol: 0,
    endLine,
    endCol: 0,
  };
}

describe("windows applyBounds", () => {
  it("returns original code when within line and token limits", () => {
    const code = "line1\nline2";
    const bounded = applyBounds(code, 10, 10_000);
    assert.strictEqual(bounded, code);
  });

  it("truncates by maxLines", () => {
    const code = "a\nb\nc\nd";
    const bounded = applyBounds(code, 2, 10_000);
    assert.strictEqual(bounded, "a\nb");
  });

  it("truncates by maxTokens", () => {
    const code = ["short", "this line is much longer than short", "tail"].join(
      "\n",
    );
    const maxTokens = estimateTokens("short");
    const bounded = applyBounds(code, 10, maxTokens);
    assert.strictEqual(bounded, "short");
  });

  it("applies both constraints together", () => {
    const code = ["alpha", "beta", "gamma", "delta"].join("\n");
    const bounded = applyBounds(code, 3, estimateTokens("alpha\nbeta"));
    const lines = bounded.split("\n");
    assert.ok(lines.length <= 3);
    assert.ok(estimateTokens(bounded) <= estimateTokens("alpha\nbeta"));
  });

  it("returns empty string when token budget is zero", () => {
    assert.strictEqual(applyBounds("abc\ndef", 10, 0), "");
  });

  it("returns empty string when maxLines is zero", () => {
    assert.strictEqual(applyBounds("abc\ndef", 0, 10_000), "");
  });
});

describe("windows centerOnSymbol", () => {
  const fileContent = Array.from(
    { length: 10 },
    (_, i) => `line-${i + 1}`,
  ).join("\n");

  it("centers around middle symbol position", () => {
    const result = centerOnSymbol(fileContent, makeRange(5, 5), 4);
    assert.strictEqual(result.actualRange.startLine, 3);
    assert.strictEqual(result.actualRange.endLine, 6);
    assert.strictEqual(
      result.code,
      ["line-3", "line-4", "line-5", "line-6"].join("\n"),
    );
  });

  it("handles symbol near file start", () => {
    const result = centerOnSymbol(fileContent, makeRange(1, 1), 6);
    assert.strictEqual(result.actualRange.startLine, 1);
    assert.strictEqual(result.code.split("\n")[0], "line-1");
    assert.ok(result.actualRange.endLine <= 6);
  });

  it("handles symbol near file end", () => {
    const result = centerOnSymbol(fileContent, makeRange(10, 10), 6);
    assert.strictEqual(result.actualRange.endLine, 10);
    assert.ok(result.actualRange.startLine >= 7);
    assert.strictEqual(result.code.split("\n").at(-1), "line-10");
  });

  it("fills odd-sized windows instead of dropping the center line", () => {
    const result = centerOnSymbol(fileContent, makeRange(5, 5), 1);
    assert.strictEqual(result.actualRange.startLine, 5);
    assert.strictEqual(result.actualRange.endLine, 5);
    assert.strictEqual(result.code, "line-5");
  });
});

describe("windows expandToBlock", () => {
  it("expands forward to enclosing function block", () => {
    const lines = ["function outer() {", "  const x = 1;", "  return x;", "}"];

    const expanded = expandToBlock(lines, makeRange(1, 1));
    assert.strictEqual(expanded.startLine, 1);
    assert.strictEqual(expanded.endLine, 4);
  });

  it("expands nested block from inner if", () => {
    const lines = [
      "function outer() {",
      "  if (ready) {",
      "    work();",
      "  }",
      "}",
    ];

    const expanded = expandToBlock(lines, makeRange(2, 2));
    assert.strictEqual(expanded.startLine, 2);
    assert.strictEqual(expanded.endLine, 4);
  });

  it("uses keyword fallback when braces are absent", () => {
    const lines = ["const answer = 42;", "console.log(answer);"];
    const expanded = expandToBlock(lines, makeRange(2, 2));
    assert.strictEqual(expanded.startLine, 1);
    assert.strictEqual(expanded.endLine, 2);
  });

  it("ignores braces inside strings and comments while expanding", () => {
    const lines = [
      "function x() {",
      '  const s = "not a brace: }";',
      "  // comment with { ignored",
      "  return 1;",
      "}",
    ];

    const expanded = expandToBlock(lines, makeRange(1, 1));
    assert.strictEqual(expanded.endLine, 5);
  });
});

describe("windows identifiersExistInWindow", () => {
  it("returns true when all identifiers are present", () => {
    const code = "const userId = getUserId(); return userId;";
    assert.strictEqual(
      identifiersExistInWindow(code, ["userId", "getUserId"]),
      true,
    );
  });

  it("is case-sensitive (code identifiers are case-sensitive)", () => {
    const code = "const TOKEN = readToken();";
    // "token" != "TOKEN", "READTOKEN" != "readToken" — case matters
    assert.strictEqual(
      identifiersExistInWindow(code, ["token", "READTOKEN"]),
      false,
    );
    // Exact case matches work
    assert.strictEqual(
      identifiersExistInWindow(code, ["TOKEN", "readToken"]),
      true,
    );
  });

  it("requires word boundaries and avoids substring-only matches", () => {
    const code = "const foobar = 1; const barista = 2;";
    assert.strictEqual(identifiersExistInWindow(code, ["bar"]), false);
  });

  it("returns false when identifiers list is empty", () => {
    assert.strictEqual(identifiersExistInWindow("const a = 1;", []), false);
  });

  it("handles regex special characters in identifiers", () => {
    const code = "foo.bar(); value+plus;";
    assert.strictEqual(
      identifiersExistInWindow(code, ["foo.bar", "value+plus"]),
      true,
    );
  });

  it("returns false when at least one identifier is missing", () => {
    const code = "const alpha = beta;";
    assert.strictEqual(
      identifiersExistInWindow(code, ["alpha", "gamma"]),
      false,
    );
  });
});

describe("windows estimateTokens", () => {
  it("returns 0 for empty input", () => {
    assert.strictEqual(estimateTokens(""), 0);
  });

  it("tracks larger code as more tokens", () => {
    const small = "const x = 1;";
    const large = `${small}\n${small}\n${small}`;
    assert.ok(estimateTokens(large) > estimateTokens(small));
  });
});
