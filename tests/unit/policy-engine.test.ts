import { beforeEach, describe, it } from "node:test";
import assert from "node:assert";

import { PolicyEngine } from "../../dist/policy/engine.js";
import {
  PolicyGetResponseSchema,
  PolicySetResponseSchema,
} from "../../dist/mcp/tools.js";
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

  it("validates actual policy handler responses against their output schemas", async (t) => {
    const conn = {};
    let configJson = JSON.stringify({ policy: {} });
    const repo = {
      repoId: "test-repo",
      rootPath: "C:/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
      get configJson() {
        return configJson;
      },
    };

    t.mock.module("../../dist/db/ladybug.js", {
      namedExports: {
        getLadybugConn: async () => conn,
        withWriteConn: async (callback: (writeConn: object) => Promise<void>) => callback(conn),
      },
    });
    t.mock.module("../../dist/db/ladybug-queries.js", {
      namedExports: {
        getRepo: async () => repo,
        upsertRepo: async (_conn: object, row: { configJson: string }) => {
          configJson = row.configJson;
        },
      },
    });

    const { handlePolicyGet, handlePolicySet } = await import(
      "../../dist/mcp/tools/policy.js"
    );
    const getResponse = await handlePolicyGet({ repoId: "test-repo" });
    const setResponse = await handlePolicySet({
      repoId: "test-repo",
      policyPatch: { maxWindowLines: 240 },
    });

    const getPayload = JSON.parse(JSON.stringify(getResponse));
    const setPayload = JSON.parse(JSON.stringify(setResponse));
    assert.deepStrictEqual(PolicyGetResponseSchema.parse(getPayload), getPayload);
    assert.deepStrictEqual(PolicySetResponseSchema.parse(setPayload), setPayload);
  });
});
