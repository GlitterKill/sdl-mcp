import assert from "node:assert";
import { describe, it } from "node:test";

import { extractIdentifiersFromText } from "../../../dist/agent/identifier-extraction.js";

describe("extractIdentifiersFromText", () => {
  it("retains natural-language domain terms alongside identifier variants", () => {
    const identifiers = extractIdentifiersFromText(
      "Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.",
    );

    for (const term of [
      "contracts",
      "contract",
      "output",
      "deterministic",
      "responses",
      "response",
      "safe",
      "errors",
      "error",
    ]) {
      assert.ok(
        identifiers.some((identifier) => identifier.toLowerCase() === term),
        `Expected ${term} in ${JSON.stringify(identifiers)}`,
      );
    }
  });

  it("keeps exact code identifiers authoritative", () => {
    const identifiers = extractIdentifiersFromText(
      "Review buildToolResponseEnvelope determinism",
    );

    assert.equal(identifiers[0], "buildToolResponseEnvelope");
  });
});
