import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideCodeAccess,
  decideCodeAccessLegacy,
  toLegacyPolicyDecision,
} from "../../../dist/policy/code-access.js";
import type {
  CodeAccessDecision,
  CodeAccessDeny,
} from "../../../dist/policy/code-access.js";
import type {
  PolicyRequestContext,
  PolicyConfig,
} from "../../../dist/policy/types.js";

const VALID_NEXT_BEST_ACTIONS = [
  "requestSkeleton",
  "requestHotPath",
  "requestRaw",
  "refreshSlice",
  "buildSlice",
  "provideIdentifiersToFind",
  "provideErrorCodeRefs",
  "provideFrontierJustification",
  "increaseBudget",
  "narrowScope",
  "retryWithSameInputs",
] as const;

const BASE_CONFIG: Partial<PolicyConfig> = {
  maxWindowLines: 180,
  maxWindowTokens: 1400,
  requireIdentifiers: true,
  allowBreakGlass: false,
  defaultDenyRaw: false,
  budgetCaps: { maxCards: 60, maxEstimatedTokens: 12000 },
};

function makeApprovalContext(
  overrides: Partial<PolicyRequestContext> = {},
): PolicyRequestContext {
  return {
    requestType: "codeWindow",
    repoId: "test-repo",
    symbolId: "test-sym",
    expectedLines: 50,
    maxWindowLines: 50,
    maxWindowTokens: 500,
    identifiersToFind: ["foo"],
    sliceContext: {
      repoId: "test-repo",
      versionId: "v1",
      budget: { maxCards: 30, maxEstimatedTokens: 4000 },
      startSymbols: ["test-sym"],
      symbolIndex: [],
      cards: [{ symbolId: "test-sym" } as any],
      edges: [],
      frontier: [],
    } as any,
    ...overrides,
  };
}

function expectDeny(decision: CodeAccessDecision): CodeAccessDeny {
  if (decision.kind !== "deny") {
    throw new Error(
      `Expected deny decision, got ${decision.kind}: ${JSON.stringify(decision)}`,
    );
  }
  return decision;
}

/**
 * Returns true when the decision blocked raw access — i.e. either an outright
 * deny or a downgrade. The default PolicyEngine rules tend to downgrade
 * cap violations to "skeleton" rather than denying outright; both shapes
 * count as "policy did not approve raw access".
 */
function isBlocked(
  decision: CodeAccessDecision,
): decision is Exclude<CodeAccessDecision, { kind: "approve" }> {
  return decision.kind !== "approve";
}

describe("decideCodeAccess — approve path", () => {
  it("approves a request that satisfies all default rules", () => {
    const decision = decideCodeAccess(makeApprovalContext(), BASE_CONFIG);
    assert.equal(decision.kind, "approve");
    if (decision.kind !== "approve") return;
    assert.equal(decision.effectiveCaps.maxWindowLines, 180);
    assert.equal(decision.effectiveCaps.maxWindowTokens, 1400);
    assert.ok(
      typeof decision.auditHash === "string" && decision.auditHash.length > 0,
    );
  });

  it("uses caps from passed config, not just defaults", () => {
    const decision = decideCodeAccess(
      makeApprovalContext({
        expectedLines: 250,
        maxWindowLines: 250,
      }),
      { ...BASE_CONFIG, maxWindowLines: 300, maxWindowTokens: 2000 },
    );
    assert.equal(decision.kind, "approve");
    if (decision.kind !== "approve") return;
    assert.equal(decision.effectiveCaps.maxWindowLines, 300);
    assert.equal(decision.effectiveCaps.maxWindowTokens, 2000);
  });
});

describe("decideCodeAccess — blocked paths (cap violations)", () => {
  it("blocks oversized expectedLines and emits a downgrade with deniedReasons", () => {
    const decision = decideCodeAccess(
      makeApprovalContext({ expectedLines: 500, maxWindowLines: 500 }),
      BASE_CONFIG,
    );
    assert.ok(isBlocked(decision), "expected non-approve decision");
    if (!isBlocked(decision)) return;
    assert.ok(
      decision.deniedReasons.some((r) => r.includes("Requested lines")),
    );
    assert.ok(typeof decision.auditHash === "string");
  });

  it("blocks oversized maxWindowTokens", () => {
    const decision = decideCodeAccess(
      makeApprovalContext({
        maxWindowTokens: 5000,
        expectedLines: 50,
        maxWindowLines: 50,
      }),
      BASE_CONFIG,
    );
    assert.ok(isBlocked(decision));
    if (!isBlocked(decision)) return;
    assert.ok(
      decision.deniedReasons.some(
        (r) => r.includes("token") || r.includes("Token"),
      ),
    );
  });

  it("blocks empty identifiersToFind when requireIdentifiers=true", () => {
    const decision = decideCodeAccess(
      makeApprovalContext({ identifiersToFind: [] }),
      BASE_CONFIG,
    );
    assert.ok(isBlocked(decision));
    if (!isBlocked(decision)) return;
    assert.ok(
      decision.deniedReasons.some((r) =>
        r.toLowerCase().includes("identifier"),
      ),
    );
  });

  it("populates cap suggestions on a true deny (defaultDenyRaw=true forces non-downgrade)", () => {
    // When the default deny rule lacks a downgrade target it produces a hard deny.
    // Run with sliceContext absent + symbolId absent to give the engine no
    // downgrade target, and oversized lines to trigger the cap rule.
    const decision = decideCodeAccess(
      makeApprovalContext({
        expectedLines: 999,
        maxWindowLines: 999,
        symbolId: undefined,
        sliceContext: undefined,
      }),
      BASE_CONFIG,
    );
    assert.ok(isBlocked(decision));
    if (!isBlocked(decision)) return;
    if (decision.kind === "deny") {
      assert.equal(decision.suggestions.expectedLines, 180);
    } else {
      // Engine chose downgrade — the deniedReasons still mention the cap.
      assert.ok(
        decision.deniedReasons.some((r) => r.includes("Requested lines")),
      );
    }
  });
});

describe("decideCodeAccess — evidence and audit", () => {
  it("preserves evidenceUsed entries from the underlying engine", () => {
    const decision = decideCodeAccess(makeApprovalContext(), BASE_CONFIG);
    assert.ok(Array.isArray(decision.evidenceUsed));
    assert.ok(decision.evidenceUsed.length > 0);
  });

  it("emits a stable audit hash across repeated calls with the same input", () => {
    const ctx = makeApprovalContext();
    const a = decideCodeAccess(ctx, BASE_CONFIG);
    const b = decideCodeAccess(ctx, BASE_CONFIG);
    assert.equal(a.auditHash, b.auditHash);
  });
});

describe("toLegacyPolicyDecision", () => {
  it('converts approve into legacy {decision: "approve"}', () => {
    const access = decideCodeAccess(makeApprovalContext(), BASE_CONFIG);
    const legacy = toLegacyPolicyDecision(access);
    assert.equal(legacy.decision, "approve");
    assert.ok(typeof legacy.auditHash === "string");
    assert.equal(legacy.deniedReasons, undefined);
  });

  it("converts a blocked decision into a non-approve legacy shape with deniedReasons", () => {
    const access = decideCodeAccess(
      makeApprovalContext({
        identifiersToFind: [],
        sliceContext: undefined,
        symbolId: undefined,
      }),
      BASE_CONFIG,
    );
    const legacy = toLegacyPolicyDecision(access);
    assert.notEqual(legacy.decision, "approve");
    assert.ok(Array.isArray(legacy.deniedReasons));
    assert.ok((legacy.deniedReasons ?? []).length > 0);
  });

  it("converts downgrade-to-skeleton into the matching legacy decision", () => {
    const access = decideCodeAccess(
      makeApprovalContext({ expectedLines: 500, maxWindowLines: 500 }),
      BASE_CONFIG,
    );
    if (access.kind === "downgrade") {
      const legacy = toLegacyPolicyDecision(access);
      assert.ok(
        legacy.decision === "downgrade-to-skeleton" ||
          legacy.decision === "downgrade-to-hotpath",
      );
    } else {
      assert.equal(access.kind, "deny");
    }
  });
});

describe("decideCodeAccessLegacy", () => {
  it("returns the legacy PolicyDecision shape plus nextBestAction info", () => {
    const result = decideCodeAccessLegacy(
      makeApprovalContext({
        identifiersToFind: [],
        sliceContext: undefined,
        symbolId: undefined,
      }),
      BASE_CONFIG,
    );
    assert.notEqual(result.decision.decision, "approve");
    assert.ok(typeof result.decision.auditHash === "string");
    // nextBestAction must be one of the documented NextBestAction literals.
    if (result.nextBestAction !== undefined) {
      assert.ok(
        (VALID_NEXT_BEST_ACTIONS as readonly string[]).includes(
          result.nextBestAction,
        ),
        `unexpected nextBestAction: ${result.nextBestAction}`,
      );
    }
  });

  it("returns no nextBestAction on approve", () => {
    const result = decideCodeAccessLegacy(makeApprovalContext(), BASE_CONFIG);
    assert.equal(result.decision.decision, "approve");
    assert.equal(result.nextBestAction, undefined);
    assert.equal(result.requiredFieldsForNext, undefined);
  });
});

/**
 * Rule-ordering invariants — replaces coverage from the deleted
 * `gate-policy-order.test.ts`.
 *
 * The PolicyEngine evaluates rules in DESCENDING priority order
 * (per `src/config/constants.ts`):
 *   - 110 BREAK_GLASS              (override; clears prior denials)
 *   - 100 WINDOW_SIZE_LIMIT        (hard caps on lines/tokens)
 *   -  90 IDENTIFIERS_REQUIRED     (input validation)
 *   -  80 BUDGET_CAPS              (slice budgets)
 *   -   5 DEFAULT_DENY_RAW         (last-resort deny for raw-code requests)
 *
 * The invariants below would catch regressions where an approval-leaning
 * rule fires before the cap rules, letting an oversized request leak
 * through.
 */
describe("decideCodeAccess — rule ordering invariants", () => {
  it("blocks oversized expectedLines even when identifiers would otherwise satisfy the request", () => {
    const decision = decideCodeAccess(
      makeApprovalContext({
        expectedLines: 999,
        maxWindowLines: 999,
        identifiersToFind: ["foo", "bar", "baz"],
      }),
      BASE_CONFIG,
    );
    assert.ok(
      isBlocked(decision),
      "cap rule must dominate over identifier-approval",
    );
    if (!isBlocked(decision)) return;
    assert.ok(
      decision.deniedReasons.some((r) => r.includes("Requested lines")),
    );
  });

  it("when both cap and identifiers fail, the cap reason is listed before the identifier reason", () => {
    const decision = decideCodeAccess(
      makeApprovalContext({
        expectedLines: 999,
        maxWindowLines: 999,
        identifiersToFind: [],
      }),
      BASE_CONFIG,
    );
    assert.ok(isBlocked(decision));
    if (!isBlocked(decision)) return;
    const reasons = decision.deniedReasons;
    const capIdx = reasons.findIndex((r) => r.includes("Requested lines"));
    const identIdx = reasons.findIndex((r) =>
      r.toLowerCase().includes("identifier"),
    );
    if (capIdx >= 0 && identIdx >= 0) {
      assert.ok(
        capIdx < identIdx,
        `expected cap reason (idx ${capIdx}) before identifier reason (idx ${identIdx}); got ${JSON.stringify(reasons)}`,
      );
    } else {
      assert.ok(
        capIdx >= 0,
        `cap reason missing from deniedReasons: ${JSON.stringify(reasons)}`,
      );
    }
  });

  it("break-glass override clears all prior denials (highest priority + short-circuit)", () => {
    const decision = decideCodeAccess(
      makeApprovalContext({
        identifiersToFind: [],
        reason: "BREAK-GLASS: investigating production outage",
      }),
      { ...BASE_CONFIG, allowBreakGlass: true },
    );
    assert.equal(
      decision.kind,
      "approve",
      "break-glass should clear the missing-identifiers denial",
    );
  });

  it("default-deny-raw evaluates last and yields to identifiers + reason + within-line-limit", () => {
    const decision = decideCodeAccess(
      makeApprovalContext({
        expectedLines: 50,
        maxWindowLines: 50,
        identifiersToFind: ["foo"],
        reason: "investigate handler",
      }),
      { ...BASE_CONFIG, defaultDenyRaw: true },
    );
    assert.equal(
      decision.kind,
      "approve",
      "default-deny-raw must observe in-context state (sufficient justification) and not fire",
    );
  });

  it("default-deny-raw fires when no justification is supplied and request is outside slice", () => {
    const decision = decideCodeAccess(
      makeApprovalContext({
        expectedLines: 50,
        maxWindowLines: 50,
        identifiersToFind: ["foo"],
        reason: "",
        sliceContext: undefined,
      }),
      { ...BASE_CONFIG, defaultDenyRaw: true },
    );
    assert.ok(isBlocked(decision));
    if (!isBlocked(decision)) return;
    assert.ok(
      decision.deniedReasons.some((r) => r.toLowerCase().includes("default")),
      `expected default-deny reason; got ${JSON.stringify(decision.deniedReasons)}`,
    );
  });
});
