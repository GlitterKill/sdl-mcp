import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/mcp/tools/search-edit/planner.ts", "utf-8");
const entrySource = readFileSync("src/mcp/tools/search-edit/index.ts", "utf-8");

describe("search.edit batch safety", () => {
  it("does not diff aggregate-read content against stale per-operation output", () => {
    const functionStart = source.indexOf("function sourceEditsForPlan");
    assert.notEqual(functionStart, -1);
    const functionBody = source.slice(functionStart, functionStart + 1800);

    assert.doesNotMatch(
      functionBody,
      /changedSourceEdits\(content,\s*plan\.edit\.newContent\)/,
    );
    assert.match(functionBody, /prepareNewContent\(/);
    assert.match(functionBody, /collectReplacePatternSourceEdits\(/);
    assert.match(functionBody, /collectAstAwareSourceEdits\(/);
  });

  it("does not double-count duplicate files when estimating batch preview bytes", () => {
    const functionStart = source.indexOf("async function planSearchEditBatchPreview");
    assert.notEqual(functionStart, -1);
    const functionBody = source.slice(functionStart, functionStart + 2600);

    assert.match(functionBody, /const previewBytesByFile = new Map<string, number>\(\)/);
    assert.match(functionBody, /previewBytesByFile\.get\(edit\.relPath\)/);
    assert.doesNotMatch(functionBody, /remainingBatchBytes/);
  });

  it("stores compact skipped-file summaries instead of every skipped path", () => {
    assert.match(entrySource, /function compactStoredSummary/);
    assert.match(entrySource, /filesSkipped: skippedSummary\.filesSkipped/);
    assert.match(entrySource, /filesSkippedByReason: skippedSummary\.filesSkippedByReason/);
    assert.match(entrySource, /store\.create\([\s\S]*storedSummary/s);
  });
});
