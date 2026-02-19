import { describe, it } from "node:test";
import assert from "node:assert";
import {
  sliceOk,
  sliceErr,
  isSliceOk,
  isSliceErr,
  sliceErrorToMessage,
  sliceErrorToCode,
  sliceErrorToResponse,
  type SliceError,
  type SliceResult,
} from "../../dist/graph/slice/result.js";
import type { GraphSlice } from "../../dist/mcp/types.js";

describe("sliceOk", () => {
  it("should create a success result", () => {
    const mockSlice = createMockSlice();
    const result = sliceOk(mockSlice);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.slice, mockSlice);
  });
});

describe("sliceErr", () => {
  it("should create an error result for invalid_repo", () => {
    const error: SliceError = { type: "invalid_repo", repoId: "repo-123" };
    const result = sliceErr(error);

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.error, error);
  });

  it("should create an error result for no_symbols", () => {
    const error: SliceError = {
      type: "no_symbols",
      repoId: "repo-123",
      entrySymbols: ["sym-1"],
    };
    const result = sliceErr(error);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.type, "no_symbols");
  });
});

describe("isSliceOk / isSliceErr", () => {
  it("should narrow type for success result", () => {
    const mockSlice = createMockSlice();
    const result: SliceResult = sliceOk(mockSlice);

    if (isSliceOk(result)) {
      assert.strictEqual(result.slice.repoId, "repo-123");
    } else {
      assert.fail("Expected success result");
    }
  });

  it("should narrow type for error result", () => {
    const result: SliceResult = sliceErr({
      type: "invalid_repo",
      repoId: "repo-123",
    });

    if (isSliceErr(result)) {
      assert.strictEqual(result.error.type, "invalid_repo");
    } else {
      assert.fail("Expected error result");
    }
  });
});

describe("sliceErrorToMessage", () => {
  it("should format invalid_repo message", () => {
    const error: SliceError = { type: "invalid_repo", repoId: "test-repo" };
    assert.strictEqual(
      sliceErrorToMessage(error),
      "Repository not found: test-repo",
    );
  });

  it("should format no_version message", () => {
    const error: SliceError = { type: "no_version", repoId: "test-repo" };
    assert.strictEqual(
      sliceErrorToMessage(error),
      "No version found for repo test-repo. Please run indexing first.",
    );
  });

  it("should format no_symbols message with entry symbols", () => {
    const error: SliceError = {
      type: "no_symbols",
      repoId: "test-repo",
      entrySymbols: ["sym-1"],
    };
    assert.strictEqual(
      sliceErrorToMessage(error),
      "No symbols found for entry symbols in repo test-repo",
    );
  });

  it("should format no_symbols message without entry symbols", () => {
    const error: SliceError = { type: "no_symbols", repoId: "test-repo" };
    assert.strictEqual(
      sliceErrorToMessage(error),
      "No symbols indexed for repo test-repo",
    );
  });

  it("should format policy_denied message", () => {
    const error: SliceError = {
      type: "policy_denied",
      reason: "budget exceeded",
    };
    assert.strictEqual(
      sliceErrorToMessage(error),
      "Policy denied slice request: budget exceeded",
    );
  });

  it("should format internal message", () => {
    const error: SliceError = {
      type: "internal",
      message: "something went wrong",
    };
    assert.strictEqual(
      sliceErrorToMessage(error),
      "Internal error: something went wrong",
    );
  });

  it("should format internal message with cause", () => {
    const error: SliceError = {
      type: "internal",
      message: "db failed",
      cause: "connection timeout",
    };
    assert.strictEqual(
      sliceErrorToMessage(error),
      "Internal error: db failed (cause: connection timeout)",
    );
  });
});

describe("sliceErrorToCode", () => {
  it("should return correct code for invalid_repo", () => {
    assert.strictEqual(
      sliceErrorToCode({ type: "invalid_repo", repoId: "x" }),
      "INVALID_REPO",
    );
  });

  it("should return correct code for no_version", () => {
    assert.strictEqual(
      sliceErrorToCode({ type: "no_version", repoId: "x" }),
      "NO_VERSION",
    );
  });

  it("should return correct code for no_symbols", () => {
    assert.strictEqual(
      sliceErrorToCode({ type: "no_symbols", repoId: "x" }),
      "NO_SYMBOLS",
    );
  });

  it("should return correct code for policy_denied", () => {
    assert.strictEqual(
      sliceErrorToCode({ type: "policy_denied", reason: "x" }),
      "POLICY_DENIED",
    );
  });

  it("should return correct code for internal", () => {
    assert.strictEqual(
      sliceErrorToCode({ type: "internal", message: "x" }),
      "INTERNAL_ERROR",
    );
  });
});

describe("sliceErrorToResponse", () => {
  it("should create MCP error response with repoId", () => {
    const error: SliceError = { type: "invalid_repo", repoId: "test-repo" };
    const response = sliceErrorToResponse(error);

    assert.strictEqual(response.error.code, "INVALID_REPO");
    assert.strictEqual(response.error.type, "invalid_repo");
    assert.strictEqual(response.error.repoId, "test-repo");
    assert.ok(response.error.message.includes("test-repo"));
  });

  it("should create MCP error response without repoId for policy_denied", () => {
    const error: SliceError = {
      type: "policy_denied",
      reason: "too many cards",
    };
    const response = sliceErrorToResponse(error);

    assert.strictEqual(response.error.code, "POLICY_DENIED");
    assert.strictEqual(response.error.type, "policy_denied");
    assert.strictEqual(response.error.repoId, undefined);
    assert.ok(response.error.message.includes("too many cards"));
  });
});

function createMockSlice(): GraphSlice {
  return {
    repoId: "repo-123",
    versionId: "v1",
    budget: { maxCards: 100, maxEstimatedTokens: 10000 },
    startSymbols: ["sym-1"],
    symbolIndex: ["sym-1"],
    cards: [
      {
        symbolId: "sym-1",
        file: "test.ts",
        range: { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
        kind: "function",
        name: "testFn",
        exported: true,
        deps: { imports: [], calls: [] },
        version: { astFingerprint: "abc123" },
      },
    ],
    edges: [],
  };
}
