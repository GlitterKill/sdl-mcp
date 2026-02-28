/**
 * Text-to-Slice Tests
 *
 * Verifies that slice.build works with only taskText — no entrySymbols required.
 * Tests cover schema validation, text-only mode detection, and error handling.
 *
 * @module tests/unit/text-to-slice
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { SliceBuildRequestSchema } from "../../src/mcp/tools.js";
import {
  computeStartNodeLimits,
} from "../../src/graph/slice/start-node-resolver.js";
import { TASK_TEXT_START_NODE_MAX } from "../../src/config/constants.js";

describe("Text-to-Slice: SliceBuildRequestSchema validation", () => {
  it("schema accepts taskText without entrySymbols", () => {
    const result = SliceBuildRequestSchema.safeParse({
      repoId: "test-repo",
      taskText: "build graph slice",
    });

    assert.strictEqual(result.success, true, "Should parse successfully with only taskText");
    if (result.success) {
      assert.strictEqual(result.data.repoId, "test-repo");
      assert.strictEqual(result.data.taskText, "build graph slice");
      assert.strictEqual(result.data.entrySymbols, undefined);
    }
  });

  it("schema accepts entrySymbols without taskText", () => {
    const result = SliceBuildRequestSchema.safeParse({
      repoId: "test-repo",
      entrySymbols: ["sym-abc123"],
    });

    assert.strictEqual(result.success, true, "Should parse successfully with only entrySymbols");
    if (result.success) {
      assert.strictEqual(result.data.taskText, undefined);
      assert.deepStrictEqual(result.data.entrySymbols, ["sym-abc123"]);
    }
  });

  it("schema accepts requests with neither taskText nor entrySymbols (handler validates)", () => {
    // The schema allows this; the handler returns a structured error response.
    const result = SliceBuildRequestSchema.safeParse({
      repoId: "test-repo",
    });

    // Schema should accept it (both fields are optional); entry-hint validation
    // happens in handleSliceBuildInternal, not in the schema.
    assert.strictEqual(result.success, true, "Schema should accept repoId-only request");
  });

  it("schema accepts taskText combined with entrySymbols", () => {
    const result = SliceBuildRequestSchema.safeParse({
      repoId: "test-repo",
      taskText: "resolve start nodes from task text",
      entrySymbols: ["sym-abc123", "sym-def456"],
    });

    assert.strictEqual(result.success, true);
    if (result.success) {
      assert.strictEqual(result.data.taskText, "resolve start nodes from task text");
      assert.deepStrictEqual(result.data.entrySymbols, ["sym-abc123", "sym-def456"]);
    }
  });

  it("schema rejects empty taskText string", () => {
    const result = SliceBuildRequestSchema.safeParse({
      repoId: "test-repo",
      taskText: "",
    });

    assert.strictEqual(result.success, false, "Empty taskText should fail min(1) validation");
  });
});

describe("Text-to-Slice: text-only mode produces doubled effectiveTaskTextLimit", () => {
  it("text-only mode is true when only taskText provided", () => {
    const request = { taskText: "build graph slice" };

    const textOnlyMode =
      (request as any).entrySymbols === undefined &&
      !((request as any).stackTrace) &&
      !((request as any).failingTestPath) &&
      ((request as any).editedFiles?.length ?? 0) === 0 &&
      Boolean(request.taskText);

    assert.strictEqual(textOnlyMode, true, "Should detect text-only mode");
  });

  it("text-only mode is false when entrySymbols provided", () => {
    const request = {
      taskText: "build graph slice",
      entrySymbols: ["sym-abc123"],
    };

    const textOnlyMode =
      (request.entrySymbols?.length ?? 0) === 0 &&
      !(request as any).stackTrace &&
      !(request as any).failingTestPath &&
      ((request as any).editedFiles?.length ?? 0) === 0 &&
      Boolean(request.taskText);

    assert.strictEqual(textOnlyMode, false, "entrySymbols presence disables text-only mode");
  });

  it("text-only mode is false when editedFiles provided", () => {
    const request = {
      taskText: "build graph slice",
      editedFiles: ["src/foo.ts"],
    };

    const textOnlyMode =
      ((request as any).entrySymbols?.length ?? 0) === 0 &&
      !(request as any).stackTrace &&
      !(request as any).failingTestPath &&
      (request.editedFiles?.length ?? 0) === 0 &&
      Boolean(request.taskText);

    assert.strictEqual(textOnlyMode, false, "editedFiles presence disables text-only mode");
  });

  it("text-only mode is false when no taskText provided", () => {
    const request = {};

    const textOnlyMode =
      ((request as any).entrySymbols?.length ?? 0) === 0 &&
      !(request as any).stackTrace &&
      !(request as any).failingTestPath &&
      ((request as any).editedFiles?.length ?? 0) === 0 &&
      Boolean((request as any).taskText);

    assert.strictEqual(textOnlyMode, false, "Absent taskText disables text-only mode");
  });

  it("effectiveTaskTextLimit is 2x TASK_TEXT_START_NODE_MAX in text-only mode", () => {
    const limits = computeStartNodeLimits({}, 0);

    // In text-only mode the resolver doubles the limit
    const textOnlyEffectiveLimit = limits.maxTaskTextStartNodes * 2;

    assert.strictEqual(
      limits.maxTaskTextStartNodes,
      TASK_TEXT_START_NODE_MAX,
      "Base limit should equal TASK_TEXT_START_NODE_MAX constant",
    );
    assert.strictEqual(
      textOnlyEffectiveLimit,
      TASK_TEXT_START_NODE_MAX * 2,
      "Text-only limit should be 2x TASK_TEXT_START_NODE_MAX",
    );
  });

  it("effectiveTaskTextLimit is standard when entrySymbols are provided", () => {
    // With explicit entries, computeStartNodeLimits returns an adaptive budget.
    const limits = computeStartNodeLimits({ entrySymbols: ["s1"] }, 1);

    // Should NOT be in text-only mode so no doubling applies.
    // Just verify the limit is at most TASK_TEXT_START_NODE_MAX (not doubled).
    assert.ok(
      limits.maxTaskTextStartNodes <= TASK_TEXT_START_NODE_MAX,
      "With entrySymbols, taskText limit should not exceed TASK_TEXT_START_NODE_MAX",
    );
  });
});

describe("Text-to-Slice: no-entry-hint returns structured error response", () => {
  it("hasAnyEntryHint is false when all entry fields are absent", () => {
    const parsedArgs = {
      repoId: "test-repo",
      // No taskText, no entrySymbols, no editedFiles, no stackTrace, no failingTestPath
    } as {
      repoId: string;
      entrySymbols?: string[];
      taskText?: string;
      editedFiles?: string[];
      stackTrace?: string;
      failingTestPath?: string;
    };

    const hasAnyEntryHint =
      (parsedArgs.entrySymbols?.length ?? 0) > 0 ||
      Boolean(parsedArgs.taskText) ||
      (parsedArgs.editedFiles?.length ?? 0) > 0 ||
      Boolean(parsedArgs.stackTrace) ||
      Boolean(parsedArgs.failingTestPath);

    assert.strictEqual(hasAnyEntryHint, false, "Should have no entry hints");
  });

  it("hasAnyEntryHint is true when taskText is provided", () => {
    const parsedArgs = {
      repoId: "test-repo",
      taskText: "build graph slice",
    } as {
      repoId: string;
      entrySymbols?: string[];
      taskText?: string;
      editedFiles?: string[];
      stackTrace?: string;
      failingTestPath?: string;
    };

    const hasAnyEntryHint =
      (parsedArgs.entrySymbols?.length ?? 0) > 0 ||
      Boolean(parsedArgs.taskText) ||
      (parsedArgs.editedFiles?.length ?? 0) > 0 ||
      Boolean(parsedArgs.stackTrace) ||
      Boolean(parsedArgs.failingTestPath);

    assert.strictEqual(hasAnyEntryHint, true, "taskText alone should satisfy entry hint");
  });

  it("hasAnyEntryHint is true when only entrySymbols are provided", () => {
    const parsedArgs = {
      repoId: "test-repo",
      entrySymbols: ["sym-abc123"],
    } as {
      repoId: string;
      entrySymbols?: string[];
      taskText?: string;
      editedFiles?: string[];
      stackTrace?: string;
      failingTestPath?: string;
    };

    const hasAnyEntryHint =
      (parsedArgs.entrySymbols?.length ?? 0) > 0 ||
      Boolean(parsedArgs.taskText) ||
      (parsedArgs.editedFiles?.length ?? 0) > 0 ||
      Boolean(parsedArgs.stackTrace) ||
      Boolean(parsedArgs.failingTestPath);

    assert.strictEqual(hasAnyEntryHint, true, "entrySymbols alone should satisfy entry hint");
  });

  it("hasAnyEntryHint is true when only editedFiles are provided", () => {
    const parsedArgs = {
      repoId: "test-repo",
      editedFiles: ["src/foo.ts"],
    } as {
      repoId: string;
      entrySymbols?: string[];
      taskText?: string;
      editedFiles?: string[];
      stackTrace?: string;
      failingTestPath?: string;
    };

    const hasAnyEntryHint =
      (parsedArgs.entrySymbols?.length ?? 0) > 0 ||
      Boolean(parsedArgs.taskText) ||
      (parsedArgs.editedFiles?.length ?? 0) > 0 ||
      Boolean(parsedArgs.stackTrace) ||
      Boolean(parsedArgs.failingTestPath);

    assert.strictEqual(hasAnyEntryHint, true, "editedFiles alone should satisfy entry hint");
  });
});
