import { beforeEach, describe, it } from "node:test";
import assert from "node:assert";

import { PolicyEngine } from "../../dist/policy/engine.js";
import type { PolicyRequestContext } from "../../dist/policy/types.js";

/**
 * Internal-only coverage for rule ordering. Behavioral policy coverage belongs
 * to the supported decideCodeAccess/decideRuntime entry-point suites.
 */
describe("Policy Engine - Priority Evaluation", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it("should evaluate rules in priority order", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: 200,
      identifiersToFind: [],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-skeleton");
    assert.strictEqual(decision.evidenceUsed.length, 5);
  });

  it("should stop evaluation at first deny if no downgrade", () => {
    const context: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: "test-repo",
      budget: {
        maxCards: 400,
      },
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "deny");
  });

  it("should continue evaluating after downgrade suggestion", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-hotpath");
  });
});
