import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { PolicyEngine, generateAuditHash } from "../../dist/policy/engine.js";
import type { PolicyRequestContext } from "../../dist/policy/types.js";

describe("Policy Engine - Window Size Limit Rule", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it("should approve request within default window limits when symbol in slice", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: 100,
      maxWindowTokens: 1000,
      identifiersToFind: ["foo"],
      sliceContext: {
        repoId: "test-repo",
        versionId: "1",
        budget: { maxCards: 300, maxEstimatedTokens: 12000 },
        startSymbols: ["test-symbol"],
        cards: [{ symbolId: "test-symbol" } as any],
        edges: [],
        frontier: [],
      },
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
    assert.strictEqual(decision.evidenceUsed.length, 5);
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "window-size-check"),
    );
  });

  it("should deny when maxWindowLines exceeds limit", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: 200,
      maxWindowTokens: 1000,
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-skeleton");
    assert.ok(decision.deniedReasons);
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "max-lines-exceeded"),
    );
    assert.strictEqual(decision.downgradeTarget?.type, "skeleton");
  });

  it("should deny when maxWindowTokens exceeds limit", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: 100,
      maxWindowTokens: 2000,
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-skeleton");
    assert.ok(decision.deniedReasons);
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "max-tokens-exceeded"),
    );
  });

  it("should skip rule for non-codeWindow requests", () => {
    const context: PolicyRequestContext = {
      requestType: "symbolCard",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
    assert.ok(decision.evidenceUsed.some((e) => e.type === "check-skipped"));
  });

  it("should allow when maxWindowLines equals limit", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: 180,
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-hotpath");
  });

  it("should allow when maxWindowTokens equals limit", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowTokens: 1400,
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-hotpath");
  });
});

describe("Policy Engine - Identifiers Required Rule", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it("should downgrade when identifiers are provided but not in slice", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: ["foo", "bar", "baz"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-hotpath");
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "identifiers-provided"),
    );
  });

  it("should deny when identifiers missing but required", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: [],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-skeleton");
    assert.ok(decision.deniedReasons);
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "missing-identifiers"),
    );
  });

  it("should deny when identifiersToFind is undefined", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-skeleton");
  });

  it("should approve when identifiers not required by policy", () => {
    engine.updateConfig({ requireIdentifiers: false, defaultDenyRaw: false });

    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: [],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "identifiers-not-required"),
    );
  });

  it("should skip rule for non-codeWindow requests", () => {
    const context: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: "test-repo",
      identifiersToFind: [],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
  });

  it("should capture limited identifiers in evidence", () => {
    const identifiers = Array.from({ length: 10 }, (_, i) => `id${i}`);
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: identifiers,
    };

    const decision = engine.evaluate(context);
    const evidence = decision.evidenceUsed.find(
      (e) => e.type === "identifiers-provided",
    );

    assert.ok(evidence);
    assert.strictEqual(evidence.value.count, 10);
    assert.strictEqual(evidence.value.identifiers.length, 5);
  });
});

describe("Policy Engine - Budget Caps Rule", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it("should approve when budget within limits", () => {
    const context: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: "test-repo",
      budget: {
        maxCards: 30,
        maxEstimatedTokens: 5000,
      },
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "budget-within-limits"),
    );
  });

  it("should deny when maxCards exceeds limit", () => {
    const context: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: "test-repo",
      budget: {
        maxCards: 100,
        maxEstimatedTokens: 5000,
      },
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "max-cards-exceeded"),
    );
  });

  it("should deny when maxEstimatedTokens exceeds limit", () => {
    const context: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: "test-repo",
      budget: {
        maxCards: 30,
        maxEstimatedTokens: 15000,
      },
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "deny");
    assert.ok(decision.deniedReasons);
    assert.ok(
      decision.evidenceUsed.some(
        (e) => e.type === "max-tokens-budget-exceeded",
      ),
    );
  });

  it("should skip rule for non-graphSlice requests", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      budget: {
        maxCards: 400,
      },
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-skeleton");
  });

  it("should skip rule when budget not provided", () => {
    const context: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: "test-repo",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
  });

  it("should approve when budget at limits", () => {
    const context: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: "test-repo",
      budget: {
        maxCards: 60,
        maxEstimatedTokens: 12000,
      },
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
  });
});

describe("Policy Engine - Break Glass Rule", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it("should not trigger break glass with AUDIT keyword alone", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      reason: "AUDIT: need to review security fix",
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-hotpath");
    assert.ok(
      decision.evidenceUsed.some(
        (e) => e.type === "break-glass-not-triggered",
      ),
    );
  });

  it("should trigger break glass with BREAK-GLASS keyword", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      reason: "BREAK-GLASS: production incident",
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-hotpath");
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "break-glass-triggered"),
    );
  });

  it("should require exact BREAK-GLASS: prefix", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      reason: "audit required for investigation",
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-hotpath");
    assert.ok(
      decision.evidenceUsed.some(
        (e) => e.type === "break-glass-not-triggered",
      ),
    );
  });

  it("should not trigger break glass without keyword", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      reason: "just need to see this function",
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);

    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "break-glass-not-triggered"),
    );
  });

  it("should approve when break glass disabled in config", () => {
    engine.updateConfig({
      allowBreakGlass: false,
      defaultDenyRaw: false,
      requireIdentifiers: false,
    });

    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      reason: "AUDIT: emergency fix",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "break-glass-disabled"),
    );
  });
});

describe("Policy Engine - Default Deny Raw Rule", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it("should deny raw code access by default", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-skeleton");
    assert.ok(decision.deniedReasons);
    assert.ok(decision.evidenceUsed.some((e) => e.type === "default-deny-raw"));
  });

  it("should approve when symbol in slice context", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: ["foo"],
      sliceContext: {
        repoId: "test-repo",
        versionId: "1",
        budget: { maxCards: 300, maxEstimatedTokens: 12000 },
        startSymbols: ["test-symbol"],
        cards: [{ symbolId: "test-symbol" } as any],
        edges: [],
        frontier: [],
      },
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "in-slice-or-frontier"),
    );
  });

  it("should approve when symbol in frontier", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: ["foo"],
      sliceContext: {
        repoId: "test-repo",
        versionId: "1",
        budget: { maxCards: 300, maxEstimatedTokens: 12000 },
        startSymbols: ["test-symbol"],
        cards: [],
        edges: [],
        frontier: [{ symbolId: "test-symbol", score: 1.0, why: "test" }],
      },
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
  });

  it("should downgrade to skeleton when no identifiers", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: [],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-skeleton");
  });

  it("should downgrade to hotpath when identifiers provided", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: ["foo", "bar"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-hotpath");
    assert.strictEqual(decision.downgradeTarget?.type, "hotpath");
  });

  it("should allow raw when defaultDenyRaw is false", () => {
    engine.updateConfig({ defaultDenyRaw: false, requireIdentifiers: false });

    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
    assert.ok(
      decision.evidenceUsed.some((e) => e.type === "default-allow-raw"),
    );
  });

  it("should skip rule for non-codeWindow requests", () => {
    const context: PolicyRequestContext = {
      requestType: "symbolCard",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
  });
});

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

describe("Policy Engine - Next Best Action", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it("should suggest skeleton for downgrade-to-skeleton", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: 200,
    };

    const decision = engine.evaluate(context);
    const nextBest = engine.generateNextBestAction(decision, context);

    assert.strictEqual(nextBest.nextBestAction, "requestSkeleton");
    assert.ok(nextBest.requiredFieldsForNext?.requestSkeleton);
    assert.strictEqual(
      nextBest.requiredFieldsForNext?.requestSkeleton?.symbolId,
      "test-symbol",
    );
  });

  it("should suggest hotpath for downgrade-to-hotpath", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);
    const nextBest = engine.generateNextBestAction(decision, context);

    assert.strictEqual(nextBest.nextBestAction, "requestHotPath");
    assert.ok(nextBest.requiredFieldsForNext?.requestHotPath);
  });

  it("should suggest increaseBudget for max-lines-exceeded", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: 200,
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);
    const nextBest = engine.generateNextBestAction(decision, context);

    assert.strictEqual(nextBest.nextBestAction, "requestSkeleton");
  });

  it("should suggest provideIdentifiersToFind for missing identifiers", () => {
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: [],
    };

    const decision = engine.evaluate(context);
    const nextBest = engine.generateNextBestAction(decision, context);

    assert.strictEqual(nextBest.nextBestAction, "requestSkeleton");
  });

  it("should suggest narrowScope for max-cards-exceeded", () => {
    const context: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: "test-repo",
      budget: {
        maxCards: 400,
      },
    };

    const decision = engine.evaluate(context);
    const nextBest = engine.generateNextBestAction(decision, context);

    assert.strictEqual(nextBest.nextBestAction, "narrowScope");
    assert.strictEqual(nextBest.requiredFieldsForNext?.narrowScope?.field, "budget.maxCards");
  });

  it("should suggest narrowScope for max-tokens-budget-exceeded", () => {
    const context: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: "test-repo",
      budget: {
        maxEstimatedTokens: 15000,
      },
    };

    const decision = engine.evaluate(context);
    const nextBest = engine.generateNextBestAction(decision, context);

    assert.strictEqual(nextBest.nextBestAction, "narrowScope");
    assert.strictEqual(
      nextBest.requiredFieldsForNext?.narrowScope?.field,
      "budget.maxEstimatedTokens",
    );
  });

  it("should return no action for approved requests", () => {
    const context: PolicyRequestContext = {
      requestType: "symbolCard",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const decision = engine.evaluate(context);
    const nextBest = engine.generateNextBestAction(decision, context);

    assert.strictEqual(nextBest.nextBestAction, undefined);
  });
});

describe("Policy Engine - Audit Trail", () => {
  it("should generate consistent hash for same inputs", () => {
    const decision = "approve";
    const evidence: any[] = [{ type: "test", value: null, reason: "test" }];
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const hash1 = generateAuditHash(decision, evidence, context);
    const hash2 = generateAuditHash(decision, evidence, context);

    assert.strictEqual(hash1, hash2);
  });

  it("should generate different hashes for different decisions", () => {
    const evidence: any[] = [{ type: "test", value: null, reason: "test" }];
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const hash1 = generateAuditHash("approve", evidence, context);
    const hash2 = generateAuditHash("deny", evidence, context);

    assert.notStrictEqual(hash1, hash2);
  });

  it("should include audit hash in decision", () => {
    const engine = new PolicyEngine();
    const context: PolicyRequestContext = {
      requestType: "symbolCard",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(typeof decision.auditHash, "string");
    assert.strictEqual(decision.auditHash.length, 64);
  });

  it("should capture all evidence in audit trail", () => {
    const engine = new PolicyEngine();
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: 200,
    };

    const decision = engine.evaluate(context);

    assert.ok(decision.evidenceUsed.length > 0);
    decision.evidenceUsed.forEach((evidence) => {
      assert.ok(evidence.type);
      assert.ok(evidence.reason);
    });
  });

  it("should capture denied reasons when applicable", () => {
    const engine = new PolicyEngine();
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: [],
    };

    const decision = engine.evaluate(context);

    assert.ok(decision.deniedReasons);
    assert.ok(decision.deniedReasons.length > 0);
  });
});

describe("Policy Engine - Rule Management", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it("should add custom rule", () => {
    const customRule = {
      name: "custom-rule",
      enabled: true,
      priority: 50,
      evaluate: () => ({
        passed: true,
        evidence: {
          type: "custom-check",
          value: null,
          reason: "Custom rule passed",
        },
      }),
    };

    engine.addRule(customRule);
    const retrieved = engine.getRule("custom-rule");

    assert.ok(retrieved);
    assert.strictEqual(retrieved.name, "custom-rule");
  });

  it("should remove existing rule", () => {
    engine.removeRule("window-size-limit");
    const retrieved = engine.getRule("window-size-limit");

    assert.strictEqual(retrieved, undefined);
  });

  it("should get rule by name", () => {
    const rule = engine.getRule("window-size-limit");

    assert.ok(rule);
    assert.strictEqual(rule.name, "window-size-limit");
    assert.strictEqual(rule.enabled, true);
  });

  it("should return undefined for non-existent rule", () => {
    const rule = engine.getRule("non-existent-rule");

    assert.strictEqual(rule, undefined);
  });

  it("should respect disabled rule during evaluation", () => {
    const customRule = {
      name: "failing-rule",
      enabled: false,
      priority: 50,
      evaluate: () => ({
        passed: false,
        evidence: {
          type: "fail",
          value: null,
          reason: "Should not run",
        },
      }),
    };

    engine.addRule(customRule);
    const context: PolicyRequestContext = {
      requestType: "symbolCard",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
  });
});

describe("Policy Engine - Configuration Management", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  it("should update configuration", () => {
    engine.updateConfig({ maxWindowLines: 200, maxWindowTokens: 2000 });
    const config = engine.getConfig();

    assert.strictEqual(config.maxWindowLines, 200);
    assert.strictEqual(config.maxWindowTokens, 2000);
  });

  it("should merge configuration updates", () => {
    engine.updateConfig({ maxWindowLines: 200 });
    engine.updateConfig({ requireIdentifiers: false });
    const config = engine.getConfig();

    assert.strictEqual(config.maxWindowLines, 200);
    assert.strictEqual(config.requireIdentifiers, false);
  });

  it("should return copy of configuration", () => {
    const config1 = engine.getConfig();
    config1.maxWindowLines = 999;
    const config2 = engine.getConfig();

    assert.notStrictEqual(config1.maxWindowLines, config2.maxWindowLines);
  });

  it("should use updated configuration in evaluation", () => {
    engine.updateConfig({
      maxWindowLines: 200,
      defaultDenyRaw: false,
      requireIdentifiers: false,
    });
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: 100,
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
  });
});

describe("Policy Engine - Error Handling", () => {
  it("should handle rule evaluation errors gracefully", () => {
    const engine = new PolicyEngine();
    const customRule = {
      name: "error-rule",
      enabled: true,
      priority: 50,
      evaluate: () => {
        throw new Error("Simulated error");
      },
    };

    engine.addRule(customRule);
    const context: PolicyRequestContext = {
      requestType: "symbolCard",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
    assert.ok(decision.evidenceUsed.some((e) => e.type === "rule-error"));
  });

  it("should continue evaluation after error", () => {
    const engine = new PolicyEngine();
    const errorRule = {
      name: "error-rule",
      enabled: true,
      priority: 50,
      evaluate: () => {
        throw new Error("Simulated error");
      },
    };

    engine.addRule(errorRule);
    const context: PolicyRequestContext = {
      requestType: "symbolCard",
      repoId: "test-repo",
      symbolId: "test-symbol",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.evidenceUsed.length, 6);
  });
});

describe("Policy Engine - Edge Cases", () => {
  it("should handle empty context", () => {
    const engine = new PolicyEngine();
    const context: PolicyRequestContext = {
      requestType: "symbolCard",
      repoId: "test-repo",
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "approve");
  });

  it("should handle maximum budget values", () => {
    const engine = new PolicyEngine();
    const context: PolicyRequestContext = {
      requestType: "graphSlice",
      repoId: "test-repo",
      budget: {
        maxCards: Number.MAX_SAFE_INTEGER,
        maxEstimatedTokens: Number.MAX_SAFE_INTEGER,
      },
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "deny");
  });

  it("should handle zero values", () => {
    const engine = new PolicyEngine();
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: 0,
      maxWindowTokens: 0,
      identifiersToFind: [],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-skeleton");
  });

  it("should handle negative values", () => {
    const engine = new PolicyEngine();
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: -10,
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-hotpath");
  });

  it("should handle very long reason strings", () => {
    const engine = new PolicyEngine();
    const longReason = "a".repeat(10000);
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      reason: longReason,
      identifiersToFind: ["foo"],
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-hotpath");
  });

  it("should handle very large identifier arrays", () => {
    const engine = new PolicyEngine();
    const identifiers = Array.from({ length: 1000 }, (_, i) => `id${i}`);
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: identifiers,
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-hotpath");
    const evidence = decision.evidenceUsed.find(
      (e) => e.type === "identifiers-provided",
    );
    assert.ok(evidence);
    assert.strictEqual(evidence.value.count, 1000);
  });
});

describe("Policy Engine - Integration Tests", () => {
  it("should handle complex multi-rule scenarios", () => {
    const engine = new PolicyEngine();
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      maxWindowLines: 200,
      maxWindowTokens: 2000,
      identifiersToFind: [],
      reason: "AUDIT: emergency",
    };

    const decision = engine.evaluate(context);
    const nextBest = engine.generateNextBestAction(decision, context);

    assert.strictEqual(decision.decision, "downgrade-to-skeleton");
    assert.ok(decision.auditHash);
    assert.strictEqual(nextBest.nextBestAction, "requestSkeleton");
  });

  it("should work with symbol in slice context", () => {
    const engine = new PolicyEngine();
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: ["foo"],
      maxWindowLines: 200,
      sliceContext: {
        repoId: "test-repo",
        versionId: "1",
        budget: { maxCards: 300, maxEstimatedTokens: 12000 },
        startSymbols: ["test-symbol"],
        cards: [{ symbolId: "test-symbol" } as any],
        edges: [],
        frontier: [],
      },
    };

    const decision = engine.evaluate(context);

    assert.strictEqual(decision.decision, "downgrade-to-skeleton");
    assert.ok(decision.deniedReasons);
  });

  it("should generate downgrade target with symbol info", () => {
    const engine = new PolicyEngine();
    const context: PolicyRequestContext = {
      requestType: "codeWindow",
      repoId: "test-repo",
      symbolId: "test-symbol",
      identifiersToFind: [],
    };

    const decision = engine.evaluate(context);

    assert.ok(decision.downgradeTarget);
    assert.strictEqual(decision.downgradeTarget?.type, "skeleton");
    assert.strictEqual(decision.downgradeTarget?.symbolId, "test-symbol");
    assert.strictEqual(decision.downgradeTarget?.repoId, "test-repo");
  });
});
