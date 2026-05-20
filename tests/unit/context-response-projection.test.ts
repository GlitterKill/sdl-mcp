import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isBroadContextResult,
  projectBroadContextResult,
  projectContextResultForUsageAccounting,
  projectToolResultForModelContent,
} from "../../dist/mcp/context-response-projection.js";

describe("context-response-projection", () => {
  const broadResult = {
    taskId: "task-123",
    taskType: "explain",
    actionsTaken: [{ id: "a-1", type: "getCard", status: "completed" }],
    path: { rungs: ["card"], estimatedTokens: 50 },
    finalEvidence: [
      { type: "symbolCard", reference: "sym:1", summary: "test" }],
    summary: "Task completed",
    success: true,
    metrics: { totalDurationMs: 10, totalTokens: 50 },
    answer: "# Explain Results\n\nFound 1 symbol(s).",
    nextBestAction: "none",
    retrievalEvidence: { symptomType: "taskText" },
    etag: "etag-123",
  };

  describe("isBroadContextResult", () => {
    it("returns true for sdl.context broad result", () => {
      assert.equal(
        isBroadContextResult("sdl.context", broadResult),
        true,
      );
    });

    it("returns true for sdl.context broad result", () => {
      assert.equal(isBroadContextResult("sdl.context", broadResult), true);
    });

    it("returns false for non-context tools", () => {
      assert.equal(
        isBroadContextResult("sdl.symbol.search", broadResult),
        false,
      );
    });

    it("returns false for null/undefined/array", () => {
      assert.equal(isBroadContextResult("sdl.context", null), false);
      assert.equal(isBroadContextResult("sdl.context", undefined), false);
      assert.equal(isBroadContextResult("sdl.context", [1, 2]), false);
    });

    it("returns false when answer field is missing (precise mode)", () => {
      const precise = { taskId: "t-1", actionsTaken: [], success: true };
      assert.equal(isBroadContextResult("sdl.context", precise), false);
    });
  });

  describe("projectBroadContextResult", () => {
    it("keeps only visible fields for broad context", () => {
      const projected = projectBroadContextResult(
        "sdl.context",
        broadResult,
      ) as Record<string, unknown>;

      assert.equal(projected.taskId, "task-123");
      assert.equal(projected.taskType, "explain");
      assert.equal(projected.success, true);
      assert.equal(projected.summary, "Task completed");
      assert.ok(projected.answer);
      assert.ok(projected.finalEvidence);
      assert.equal(projected.nextBestAction, "none");
      assert.equal(projected.etag, "etag-123");

      // Hidden fields
      assert.equal(projected.actionsTaken, undefined);
      assert.equal(projected.path, undefined);
      assert.equal(projected.metrics, undefined);
      // retrievalEvidence is model-visible in compact broad responses.
      assert.deepEqual(projected.retrievalEvidence, broadResult.retrievalEvidence);
    });

    it("preserves error field when present", () => {
      const errorResult = { ...broadResult, error: "something broke" };
      const projected = projectBroadContextResult(
        "sdl.context",
        errorResult,
      ) as Record<string, unknown>;
      assert.equal(projected.error, "something broke");
    });

    it("preserves truncation field when present", () => {
      const truncated = {
        ...broadResult,
        truncation: {
          originalTokens: 100,
          truncatedTokens: 50,
          fieldsAffected: ["answer"],
        },
      };
      const projected = projectBroadContextResult(
        "sdl.context",
        truncated,
      ) as Record<string, unknown>;
      assert.deepEqual(projected.truncation, truncated.truncation);
    });

    it("preserves _displayFooter", () => {
      const withFooter = { ...broadResult, _displayFooter: "meter text" };
      const projected = projectBroadContextResult(
        "sdl.context",
        withFooter,
      ) as Record<string, unknown>;
      assert.equal(projected._displayFooter, "meter text");
    });

    it("returns non-context tool results unchanged", () => {
      const result = { foo: "bar" };
      assert.strictEqual(
        projectBroadContextResult("sdl.symbol.search", result),
        result,
      );
    });

    it("returns precise-mode results unchanged", () => {
      const precise = { taskId: "t-1", actionsTaken: [], success: true };
      assert.strictEqual(
        projectBroadContextResult("sdl.context", precise),
        precise,
      );
    });

    it("is idempotent on already-compact broad payloads", () => {
      // Simulate what the context engine returns after compaction:
      // only BROAD_VISIBLE_FIELDS, no actionsTaken/path/metrics
      const compact = {
        taskId: "task-123",
        taskType: "explain",
        success: true,
        summary: "Task completed",
        answer: "# Results\n\nFound 1 symbol.",
        finalEvidence: [
          { type: "symbolCard", reference: "sym:1", summary: "test" }],
        nextBestAction: "none",
      };
      // First projection should detect it's not a broad result (no actionsTaken)
      // and return it unchanged
      const first = projectBroadContextResult("sdl.context", compact);
      assert.strictEqual(
        first,
        compact,
        "Already-compact broad payload should pass through unchanged",
      );
    });

    it("is idempotent when re-projecting a projected result", () => {
      // Project the full broad result once
      const projected = projectBroadContextResult(
        "sdl.context",
        broadResult,
      ) as Record<string, unknown>;
      // Project again — should pass through since actionsTaken was stripped
      const reprojected = projectBroadContextResult(
        "sdl.context",
        projected,
      );
      assert.strictEqual(
        reprojected,
        projected,
        "Re-projecting should return the same reference (no-op)",
      );
    });

    it("projects usage accounting payloads while preserving raw baseline hints", () => {
      const withRawContext = {
        ...broadResult,
        _rawContext: { rawTokens: 1000 },
      };
      const projected = projectContextResultForUsageAccounting(
        "sdl.context",
        withRawContext,
      );

      assert.equal(projected.actionsTaken, undefined);
      assert.equal(projected.path, undefined);
      assert.equal(projected.metrics, undefined);
      assert.equal(projected.taskId, undefined);
      assert.equal(projected.summary, undefined);
      assert.equal(projected.retrievalEvidence, undefined);
      assert.equal(projected.etag, "etag-123");
      assert.equal(projected.answer, broadResult.answer);
      assert.deepEqual(projected._rawContext, { rawTokens: 1000 });
    });
  });

  describe("projectToolResultForModelContent", () => {
    it("keeps requested workflow trace data visible in MCP content", () => {
      const projected = projectToolResultForModelContent(
        "sdl.workflow",
        {
          results: [],
          trace: {
            steps: [{ stepIndex: 0, fn: "repoStatus" }],
            totals: { durationMs: 1, tokens: 2, stepsExecuted: 1 },
          },
        },
        { trace: { level: "verbose" } },
      ) as Record<string, unknown>;

      assert.ok(projected.trace);
    });

    it("continues to hide trace-like internal fields from other tools", () => {
      const projected = projectToolResultForModelContent(
        "sdl.context",
        { success: true, trace: { internal: true } },
        {},
      ) as Record<string, unknown>;

      assert.equal(projected.trace, undefined);
    });
  });
});
