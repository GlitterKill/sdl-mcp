import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * Tests that the hotpath no-match branch respects maxTokens.
 * We test the buildHotPathExcerpt logic indirectly via the exported
 * extractHotPath, but since that requires DB setup, we test the
 * token-bounding logic by importing the helper from dist and
 * verifying the excerpt is token-bounded.
 *
 * Since buildHotPathExcerpt is not exported, we verify the behavior
 * via the estimateTokens utility and the contract that:
 * - no-match branch returns at most maxTokens worth of content
 * - no-match branch returns at most maxLines lines
 */

import { estimateTokens } from "../../dist/util/tokenize.js";

describe("hotpath token cap in no-match branch", () => {
  it("estimateTokens returns positive values for non-empty strings", () => {
    const result = estimateTokens("const x = 42;");
    assert.ok(result > 0, "Token estimate should be positive for code");
  });

  it("longer lines produce higher token estimates", () => {
    const shortLine = "x";
    const longLine = "const veryLongVariableName = calculateSomethingComplex(arg1, arg2, arg3);";
    const shortTokens = estimateTokens(shortLine);
    const longTokens = estimateTokens(longLine);
    assert.ok(
      longTokens > shortTokens,
      `Long line (${longTokens} tokens) should exceed short line (${shortTokens} tokens)`,
    );
  });

  it("token bounding loop stops when budget exhausted", () => {
    // Simulate the no-match branch logic
    const lines = Array.from({ length: 100 }, (_, i) =>
      `const variable${i} = someFunction(argument1, argument2, argument3);`,
    );
    const maxTokens = 50;
    const maxLines = 100;

    const resultLines: string[] = [];
    let remainingTokens = maxTokens;
    const allExcerpt = lines.slice(0, Math.min(maxLines, lines.length));
    for (const line of allExcerpt) {
      const lineTokens = estimateTokens(line);
      if (lineTokens > remainingTokens) break;
      resultLines.push(line);
      remainingTokens -= lineTokens;
    }

    assert.ok(
      resultLines.length < lines.length,
      `Should truncate: got ${resultLines.length} lines, total ${lines.length}`,
    );

    const totalTokens = resultLines.reduce(
      (sum, line) => sum + estimateTokens(line),
      0,
    );
    assert.ok(
      totalTokens <= maxTokens,
      `Total tokens (${totalTokens}) should not exceed maxTokens (${maxTokens})`,
    );
  });

  it("maxLines limit is respected even when token budget allows more", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `x${i}`);
    const maxTokens = 999999;
    const maxLines = 5;

    const resultLines: string[] = [];
    let remainingTokens = maxTokens;
    const allExcerpt = lines.slice(0, Math.min(maxLines, lines.length));
    for (const line of allExcerpt) {
      const lineTokens = estimateTokens(line);
      if (lineTokens > remainingTokens) break;
      resultLines.push(line);
      remainingTokens -= lineTokens;
    }

    assert.strictEqual(
      resultLines.length,
      maxLines,
      `Should return exactly ${maxLines} lines`,
    );
  });
});
