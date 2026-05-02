/**
 * Code Access Decision module.
 *
 * Pure decision over whether one of six data-access artifact types
 * (codeWindow, skeleton, hotPath, symbolCard, graphSlice, delta) may be
 * returned. No I/O, no symbol lookup, no window text.
 *
 * The codeWindow case still requires `enforceCodeWindow` afterward to verify
 * identifiers against real file text — see code/enforce.ts.
 *
 * Sibling to decideRuntime (policy/runtime.ts).
 */

import { PolicyEngine } from "./engine.js";
import type {
  PolicyRequestContext,
  PolicyConfig,
  PolicyDecision,
  PolicyEvidence,
} from "./types.js";
import { DEFAULT_POLICY_CONFIG } from "./types.js";
import type { NextBestAction, RequiredFieldsForNext } from "../domain/types.js";

export interface EffectiveCaps {
  maxWindowLines: number;
  maxWindowTokens: number;
}

export interface CapDenialSuggestions {
  expectedLines?: number;
  maxTokens?: number;
  identifiersToFind?: string[];
  reason?: string;
}

export interface CodeAccessApprove {
  kind: "approve";
  effectiveCaps: EffectiveCaps;
  evidenceUsed: PolicyEvidence[];
  auditHash: string;
}

export interface CodeAccessDowngrade {
  kind: "downgrade";
  target: "skeleton" | "hotpath";
  effectiveCaps: EffectiveCaps;
  downgradeTarget?: {
    type: "skeleton" | "hotpath";
    symbolId: string;
    repoId: string;
  };
  evidenceUsed: PolicyEvidence[];
  auditHash: string;
  deniedReasons: string[];
  nextBestAction?: NextBestAction;
  requiredFieldsForNext?: RequiredFieldsForNext;
}

export interface CodeAccessDeny {
  kind: "deny";
  deniedReasons: string[];
  suggestions: CapDenialSuggestions;
  evidenceUsed: PolicyEvidence[];
  auditHash: string;
  nextBestAction?: NextBestAction;
  requiredFieldsForNext?: RequiredFieldsForNext;
}

export type CodeAccessDecision =
  | CodeAccessApprove
  | CodeAccessDowngrade
  | CodeAccessDeny;

// Bounded LRU cache of engines keyed by a stable serialization of the
// effective config. Avoids per-call construction of the rule chain on the
// hot path. Production typically uses 1-2 distinct configs; cap protects
// against pathological churn from test suites.
const ENGINE_CACHE_MAX = 32;
const engineCache = new Map<string, PolicyEngine>();

function buildConfigCacheKey(config: PolicyConfig): string {
  // Explicit field projection so cache keys stay stable regardless of the
  // key insertion order of the caller's config object.
  return JSON.stringify([
    config.maxWindowLines,
    config.maxWindowTokens,
    config.requireIdentifiers,
    config.allowBreakGlass,
    config.defaultDenyRaw,
    config.defaultMinCallConfidence ?? null,
    config.budgetCaps.maxCards,
    config.budgetCaps.maxEstimatedTokens,
  ]);
}

export function getPolicyEngineForConfig(config: PolicyConfig): PolicyEngine {
  const key = buildConfigCacheKey(config);
  const cached = engineCache.get(key);
  if (cached) {
    engineCache.delete(key);
    engineCache.set(key, cached);
    return cached;
  }
  const engine = new PolicyEngine(config);
  engineCache.set(key, engine);
  if (engineCache.size > ENGINE_CACHE_MAX) {
    const firstKey = engineCache.keys().next().value;
    if (firstKey !== undefined) engineCache.delete(firstKey);
  }
  return engine;
}

export function decideCodeAccess(
  context: PolicyRequestContext,
  config: Partial<PolicyConfig> = {},
): CodeAccessDecision {
  const effectiveConfig: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, ...config };
  const engine = getPolicyEngineForConfig(effectiveConfig);
  const decision = engine.evaluate(context);

  const effectiveCaps: EffectiveCaps = {
    maxWindowLines: effectiveConfig.maxWindowLines,
    maxWindowTokens: effectiveConfig.maxWindowTokens,
  };

  if (decision.decision === "approve") {
    return {
      kind: "approve",
      effectiveCaps,
      evidenceUsed: decision.evidenceUsed,
      auditHash: decision.auditHash,
    };
  }

  const next = engine.generateNextBestAction(decision, context);

  if (
    decision.decision === "downgrade-to-skeleton" ||
    decision.decision === "downgrade-to-hotpath"
  ) {
    return {
      kind: "downgrade",
      target:
        decision.decision === "downgrade-to-skeleton" ? "skeleton" : "hotpath",
      effectiveCaps,
      downgradeTarget: decision.downgradeTarget,
      evidenceUsed: decision.evidenceUsed,
      auditHash: decision.auditHash,
      deniedReasons: decision.deniedReasons ?? [],
      nextBestAction: next.nextBestAction,
      requiredFieldsForNext: next.requiredFieldsForNext,
    };
  }

  const suggestions = buildCapSuggestions(context, decision, effectiveConfig);
  return {
    kind: "deny",
    deniedReasons: decision.deniedReasons ?? [decision.decision],
    suggestions,
    evidenceUsed: decision.evidenceUsed,
    auditHash: decision.auditHash,
    nextBestAction: next.nextBestAction,
    requiredFieldsForNext: next.requiredFieldsForNext,
  };
}

function buildCapSuggestions(
  context: PolicyRequestContext,
  decision: PolicyDecision,
  policy: PolicyConfig,
): CapDenialSuggestions {
  const suggestions: CapDenialSuggestions = {};
  const reasons = decision.deniedReasons ?? [];

  const tooBroad =
    context.expectedLines !== undefined &&
    context.expectedLines > policy.maxWindowLines;
  const tokenCapExceeded =
    context.maxWindowTokens !== undefined &&
    context.maxWindowTokens > policy.maxWindowTokens;
  const noIdentifiers =
    (!context.identifiersToFind || context.identifiersToFind.length === 0) &&
    policy.requireIdentifiers;

  if (tooBroad) {
    suggestions.expectedLines = policy.maxWindowLines;
  }
  if (tokenCapExceeded) {
    suggestions.maxTokens = policy.maxWindowTokens;
  }
  if (noIdentifiers) {
    suggestions.identifiersToFind = [];
  }
  if (tooBroad && context.reason && !context.reason.includes("specific")) {
    suggestions.reason = `${context.reason} - focus on specific function/class`;
  }
  if (Object.keys(suggestions).length === 0 && reasons.length > 0) {
    suggestions.reason = context.reason
      ? `${context.reason} (please add context or identifiers)`
      : "Add context or specific identifiers";
  }

  return suggestions;
}

/**
 * Transitional adapter — converts the new discriminated `CodeAccessDecision`
 * back into the legacy `PolicyDecision` shape so existing handlers can migrate
 * away from `new PolicyEngine(...)` without rewriting their decision-handling
 * code in the same change.
 *
 * New code should consume `CodeAccessDecision` directly via `decideCodeAccess`.
 */
export function toLegacyPolicyDecision(
  decision: CodeAccessDecision,
): PolicyDecision {
  if (decision.kind === "approve") {
    return {
      decision: "approve",
      evidenceUsed: decision.evidenceUsed,
      auditHash: decision.auditHash,
    };
  }
  if (decision.kind === "downgrade") {
    return {
      decision:
        decision.target === "skeleton"
          ? "downgrade-to-skeleton"
          : "downgrade-to-hotpath",
      evidenceUsed: decision.evidenceUsed,
      auditHash: decision.auditHash,
      deniedReasons:
        decision.deniedReasons.length > 0 ? decision.deniedReasons : undefined,
      downgradeTarget: decision.downgradeTarget,
    };
  }
  return {
    decision: "deny",
    evidenceUsed: decision.evidenceUsed,
    auditHash: decision.auditHash,
    deniedReasons:
      decision.deniedReasons.length > 0 ? decision.deniedReasons : undefined,
  };
}

/**
 * Convenience: returns legacy `PolicyDecision` plus the next-best-action
 * info that callers previously got from `policyEngine.generateNextBestAction`.
 */
export function decideCodeAccessLegacy(
  context: PolicyRequestContext,
  config: Partial<PolicyConfig> = {},
): {
  decision: PolicyDecision;
  nextBestAction?: NextBestAction;
  requiredFieldsForNext?: RequiredFieldsForNext;
} {
  const access = decideCodeAccess(context, config);
  return {
    decision: toLegacyPolicyDecision(access),
    nextBestAction:
      access.kind === "approve" ? undefined : access.nextBestAction,
    requiredFieldsForNext:
      access.kind === "approve" ? undefined : access.requiredFieldsForNext,
  };
}
