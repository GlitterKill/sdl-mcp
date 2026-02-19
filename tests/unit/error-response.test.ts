import { describe, it } from "node:test";
import assert from "node:assert";
import {
  errorToMcpResponse,
  createPolicyDenial,
  DatabaseError,
  ConfigError,
  ErrorCode,
} from "../../dist/mcp/errors.js";

describe("errorToMcpResponse", () => {
  it("should preserve error message for plain errors", () => {
    const error = new Error("something failed");
    const response = errorToMcpResponse(error);
    assert.strictEqual(response.error?.message, "something failed");
  });

  it("should preserve error code from typed errors", () => {
    const error = new DatabaseError("db failed");
    const response = errorToMcpResponse(error);
    assert.strictEqual(response.error?.message, "db failed");
    assert.strictEqual(response.error?.code, ErrorCode.DATABASE_ERROR);
  });

  it("should preserve nextBestAction from policy denials", () => {
    const error = createPolicyDenial(
      "too many lines",
      "getSkeleton",
      { symbolId: "sym-1", repoId: "repo-1" },
    );
    const response = errorToMcpResponse(error);
    assert.strictEqual(response.error?.message, "too many lines");
    assert.strictEqual(response.error?.code, ErrorCode.POLICY_ERROR);
    assert.strictEqual(response.error?.nextBestAction, "getSkeleton");
    assert.deepStrictEqual(response.error?.requiredFieldsForNext, {
      symbolId: "sym-1",
      repoId: "repo-1",
    });
  });

  it("should handle non-Error values", () => {
    const response = errorToMcpResponse("string error");
    assert.strictEqual(response.error?.message, "string error");
  });

  it("should handle ConfigError", () => {
    const error = new ConfigError("bad config");
    const response = errorToMcpResponse(error);
    assert.strictEqual(response.error?.code, ErrorCode.CONFIG_ERROR);
  });
});
