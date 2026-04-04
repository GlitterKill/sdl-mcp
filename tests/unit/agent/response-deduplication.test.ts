import assert from "node:assert";
import { describe, it } from "node:test";
import {
  BROAD_VISIBLE_FIELDS,
  projectBroadContextResult,
} from "../../../dist/mcp/context-response-projection.js";

describe("Response Deduplication", () => {
  describe("BROAD_VISIBLE_FIELDS", () => {
    it("includes summary for backward compatibility", () => {
      assert.ok(
        BROAD_VISIBLE_FIELDS.has("summary"),
        "summary should be in BROAD_VISIBLE_FIELDS for internal compaction",
      );
    });

    it("includes answer for broad mode", () => {
      assert.ok(
        BROAD_VISIBLE_FIELDS.has("answer"),
        "answer should be in BROAD_VISIBLE_FIELDS",
      );
    });

    it("includes finalEvidence for broad mode", () => {
      assert.ok(
        BROAD_VISIBLE_FIELDS.has("finalEvidence"),
        "finalEvidence should be in BROAD_VISIBLE_FIELDS",
      );
    });

    it("does not include actionsTaken (verbose metadata)", () => {
      assert.ok(
        !BROAD_VISIBLE_FIELDS.has("actionsTaken"),
        "actionsTaken should not be in BROAD_VISIBLE_FIELDS",
      );
    });

    it("does not include path (internal planner detail)", () => {
      assert.ok(
        !BROAD_VISIBLE_FIELDS.has("path"),
        "path should not be in BROAD_VISIBLE_FIELDS",
      );
    });

    it("does not include metrics (internal execution detail)", () => {
      assert.ok(
        !BROAD_VISIBLE_FIELDS.has("metrics"),
        "metrics should not be in BROAD_VISIBLE_FIELDS",
      );
    });
  });

  describe("projectBroadContextResult", () => {
    it("keeps summary and answer in broad context results", () => {
      const result = {
        taskId: "t1",
        taskType: "explain",
        success: true,
        summary: "This is the summary that duplicates the answer",
        answer: "# Explain Results\n\nConcise answer here.",
        finalEvidence: [],
        actionsTaken: [{ id: "a1", type: "getCard" }],
        path: { rungs: ["card"] },
        metrics: { totalTokens: 100 },
      };

      const projected = projectBroadContextResult(
        "sdl.context",
        result,
      ) as Record<string, unknown>;

      assert.ok(("summary" in projected), "summary should be kept");
      assert.ok("answer" in projected, "answer should be kept");
      assert.ok("finalEvidence" in projected, "finalEvidence should be kept");
      assert.ok(
        !("actionsTaken" in projected),
        "actionsTaken should be stripped",
      );
      assert.ok(!("path" in projected), "path should be stripped");
      assert.ok(!("metrics" in projected), "metrics should be stripped");
    });


    it("preserves all fields for non-context tool even with context-shaped result", () => {
      // A result that has the same shape as a context result but comes from a non-context tool
      const result = {
        taskId: "t1",
        taskType: "explain",
        success: true,
        summary: "keep me",
        answer: "keep me too",
        finalEvidence: [],
        actionsTaken: [{ id: "a1", type: "getCard" }],
        path: { rungs: ["card"] },
        metrics: { totalTokens: 100 },
      };

      const projected = projectBroadContextResult(
        "sdl.symbol.search",
        result,
      ) as Record<string, unknown>;

      // Non-context tool should preserve ALL fields, even actionsTaken/path/metrics
      assert.ok("actionsTaken" in projected, "non-context tool should keep actionsTaken");
      assert.ok("path" in projected, "non-context tool should keep path");
      assert.ok("metrics" in projected, "non-context tool should keep metrics");
    });

    it("does not project non-context tool results", () => {
      const result = {
        taskId: "t1",
        summary: "keep me",
        actionsTaken: [{ id: "a1" }],
      };

      const projected = projectBroadContextResult(
        "sdl.symbol.search",
        result,
      ) as Record<string, unknown>;

      // Non-context tools should pass through unchanged
      assert.ok("summary" in projected, "non-context tool should keep summary");
      assert.ok(
        "actionsTaken" in projected,
        "non-context tool should keep actionsTaken",
      );
    });
  });
});
