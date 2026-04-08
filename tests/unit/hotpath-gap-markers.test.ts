import { describe, it } from "node:test";
import assert from "node:assert";
import { buildHotPathExcerpt } from "../../dist/code/hotpath.js";

// Regression tests for hot-path gap markers and endCol computation.
// Covers the 2026-04-08 fix where endCol could reflect a trailing gap
// marker string length instead of the last real code line length.

describe("buildHotPathExcerpt gap markers", () => {
  it("inserts a gap marker between non-contiguous excerpt windows", () => {
    const lines = [];
    for (let i = 0; i < 30; i++) lines.push(`const v${i} = ${i};`);
    // Two matched regions far apart: line 2 and line 20. With contextLines=1
    // the windows will be [1-3] and [19-21], with a gap between.
    const matched = new Set([3, 21]); // 1-indexed for match contract
    const result = buildHotPathExcerpt(lines, matched, 1, 100, 10000);
    const hasGap = result.excerpt.split("\n").some((l) => l.includes("line") && l.includes("skipped"));
    assert.ok(hasGap, "Expected gap marker between non-contiguous windows");
  });

  it("does not insert a gap marker between contiguous windows", () => {
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(`const v${i} = ${i};`);
    // Adjacent matches produce a single contiguous window.
    const matched = new Set([3, 4, 5]);
    const result = buildHotPathExcerpt(lines, matched, 1, 100, 10000);
    const hasGap = result.excerpt.split("\n").some((l) => l.includes("skipped"));
    assert.ok(!hasGap, "Contiguous windows should not have a gap marker");
  });

  it("endCol reflects the last code line length, not a trailing gap marker", () => {
    const lines = [];
    for (let i = 0; i < 30; i++) lines.push(`x${i}`);
    // Short code lines but a fat gap-marker string. The final resultLines
    // entry should be a real code line, never the separator.
    const matched = new Set([3, 21]);
    const result = buildHotPathExcerpt(lines, matched, 1, 100, 10000);
    // The gap marker string starts with "  // ..." — it is much longer than
    // the short "xNN" code lines. If the fix is missing, endCol will equal
    // the marker length (>= 20). If the fix is correct, endCol equals the
    // last code line length (<= 4 chars).
    assert.ok(
      result.actualRange.endCol <= 5,
      `endCol (${result.actualRange.endCol}) should reflect last code line, not gap marker`,
    );
  });

  it("truncation flag is set when token budget runs out mid-loop", () => {
    const lines = [];
    for (let i = 0; i < 30; i++) lines.push(`const variable${i} = someValue${i};`);
    const matched = new Set([1, 15, 29]);
    // Very small token budget — the loop should hit the budget cap
    // and set truncated=true.
    const result = buildHotPathExcerpt(lines, matched, 2, 100, 5);
    assert.ok(result.truncated, "Expected truncated=true when token budget exhausted");
  });
});
