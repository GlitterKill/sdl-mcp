import { describe, it } from "node:test";
import assert from "node:assert";
import {
  errorToMcpResponse,
  createPolicyDenial,
  DatabaseError,
  ConfigError,
  ErrorCode,
} from "../../dist/mcp/errors.js";
import { ToolDispatchQueueTimeoutError } from "../../dist/mcp/dispatch-limiter.js";

type ErrorResponse = {
  error?: {
    message?: string;
    code?: string;
    nextBestAction?: string;
    requiredFieldsForNext?: Record<string, string>;
    classification?: string;
    retryable?: boolean;
    fallbackTools?: string[];
    candidates?: Array<{ symbolId: string }>;
    suggestedRetryDelayMs?: number;
    details?: string[];
  };
};

describe("errorToMcpResponse", () => {
  it("should sanitize error message for plain (untyped) errors", () => {
    const error = new Error("something failed with internal details");
    const response = errorToMcpResponse(error) as ErrorResponse;
    // Plain Error without ErrorCode is treated as unexpected — message is sanitized
    assert.strictEqual(
      response.error?.message,
      "An internal error occurred. Check server logs for details.",
    );
  });

  it("should preserve error code from typed errors", () => {
    const error = new DatabaseError("db failed");
    const response = errorToMcpResponse(error) as ErrorResponse;
    assert.strictEqual(response.error?.message, "db failed");
    assert.strictEqual(response.error?.code, ErrorCode.DATABASE_ERROR);
  });

  it("should preserve nextBestAction from policy denials", () => {
    const error = createPolicyDenial("too many lines", "requestSkeleton", {
      symbolId: "sym-1",
      repoId: "repo-1",
    } as any);
    const response = errorToMcpResponse(error) as ErrorResponse;
    assert.strictEqual(response.error?.message, "too many lines");
    assert.strictEqual(response.error?.code, ErrorCode.POLICY_ERROR);
    assert.strictEqual(response.error?.nextBestAction, "requestSkeleton");
    assert.deepStrictEqual(response.error?.requiredFieldsForNext, {
      symbolId: "sym-1",
      repoId: "repo-1",
    });
  });

  it("classifies typed errors and preserves guidance metadata", () => {
    const error = new DatabaseError("db failed");
    Object.assign(error, {
      classification: "transient",
      retryable: true,
      fallbackTools: ["sdl.repo.status"],
      candidates: [{ symbolId: "sym-1" }],
    });

    const response = errorToMcpResponse(error) as ErrorResponse;
    assert.strictEqual(response.error?.classification, "transient");
    assert.strictEqual(response.error?.retryable, true);
    assert.deepStrictEqual(response.error?.fallbackTools, ["sdl.repo.status"]);
    assert.deepStrictEqual(response.error?.candidates, [{ symbolId: "sym-1" }]);
  });

  it("surfaces dispatch queue timeouts as clear retryable errors", () => {
    const error = new ToolDispatchQueueTimeoutError(
      30_000,
      {
        active: 1,
        queued: 4,
        maxConcurrency: 1,
        configuredMax: 8,
        indexingActive: true,
        totalActiveMs: 0,
        totalQueueMs: 0,
        totalRuns: 0,
        peakQueued: 4,
        peakActive: 1,
      },
      "sdl.context",
    );

    const response = errorToMcpResponse(error) as ErrorResponse;

    assert.match(
      response.error?.message ?? "",
      /Tool dispatch queue timed out after 30000ms for sdl\.context/,
    );
    assert.strictEqual(response.error?.code, ErrorCode.RUNTIME_ERROR);
    assert.strictEqual(response.error?.classification, "unavailable");
    assert.strictEqual(response.error?.retryable, true);
    assert.strictEqual(response.error?.suggestedRetryDelayMs, 1000);
    assert.ok(response.error?.details?.includes("active=1"));
  });

  it("should sanitize non-Error values", () => {
    const response = errorToMcpResponse("string error") as ErrorResponse;
    // Non-Error values are treated as unexpected — message is sanitized
    assert.strictEqual(
      response.error?.message,
      "An internal error occurred. Check server logs for details.",
    );
  });

  it("should handle ConfigError", () => {
    const error = new ConfigError("bad config");
    const response = errorToMcpResponse(error) as ErrorResponse;
    assert.strictEqual(response.error?.code, ErrorCode.CONFIG_ERROR);
  });
});
