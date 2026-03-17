import { describe, it } from "node:test";
import assert from "node:assert";
import {
  errorToMcpResponse,
  createPolicyDenial,
  DatabaseError,
  ConfigError,
  ErrorCode,
} from "../../dist/mcp/errors.js";

type ErrorResponse = {
  error?: {
    message?: string;
    code?: string;
    nextBestAction?: string;
    requiredFieldsForNext?: Record<string, string>;
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
