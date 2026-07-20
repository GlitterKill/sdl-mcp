import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildActionSeedQueries } from "../../../dist/agent/context-seeding.js";

const PROJECTION_QUERY = "context response projection";
const GENERIC_TOOL_QA_TASK =
  "Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.";

describe("generic tool-contract action seeding", () => {
  it("does not special-case the canonical generic review", () => {
    assert.deepEqual(buildActionSeedQueries(GENERIC_TOOL_QA_TASK), []);
  });

  it("does not treat generic determinism words as action names", () => {
    assert.deepEqual(buildActionSeedQueries("tool determinism"), []);
  });

  it("does not activate for partial or ordinary formatting intent", () => {
    for (const taskText of [
      "debug tool output formatting",
      "fix schema response error",
      "review tool output formatting",
      "review tool registration safety",
      "debug tool contract formatting",
      "audit response contracts for application output",
    ]) {
      assert.deepEqual(
        buildActionSeedQueries(taskText),
        [],
        `unexpected generic seed for: ${taskText}`,
      );
    }
  });

  it("does not emit response-test queries without a named action", () => {
    assert.deepEqual(
      buildActionSeedQueries(
        "Review SDL-MCP tool schemas, contracts, deterministic responses, and tests.",
      ),
      [],
    );
  });

  it("preserves named-action query text and ordering", () => {
    assert.deepEqual(
      buildActionSeedQueries(
        "Review runtime.queryOutput output contract tests",
      ),
      [
        "handleRuntimeQueryOutput RuntimeQueryOutputRequestSchema RuntimeQueryOutputResponseSchema runtimeQueryOutput runtime.queryOutput",
        "context response projection runtimeQueryOutput runtime queryOutput",
        "response runtime queryOutput",
      ],
    );
  });
});
