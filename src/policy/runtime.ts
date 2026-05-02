/**
 * Runtime Decision module.
 *
 * Pure decision over whether a runtime execution request (node, python,
 * shell, etc.) may proceed. Sibling to decideCodeAccess (policy/code-access.ts).
 *
 * Approve / deny only — there is no downgrade target for runtime execution.
 */

import { getPolicyEngineForConfig } from "./code-access.js";
import type {
  RuntimePolicyRequestContext,
  RuntimePolicyDecision,
  PolicyConfig,
  PolicyEvidence,
} from "./types.js";
import { DEFAULT_POLICY_CONFIG } from "./types.js";
import type { RuntimeConfig } from "../config/types.js";
import type { ConcurrencyTracker } from "../runtime/types.js";

export interface RuntimeApprove {
  kind: "approve";
  evidenceUsed: PolicyEvidence[];
  auditHash: string;
}

export interface RuntimeDeny {
  kind: "deny";
  deniedReasons: string[];
  evidenceUsed: PolicyEvidence[];
  auditHash: string;
}

export type RuntimeDecision = RuntimeApprove | RuntimeDeny;

export function decideRuntime(
  context: RuntimePolicyRequestContext,
  runtimeConfig: RuntimeConfig,
  concurrencyTracker?: ConcurrencyTracker,
  policyConfig: Partial<PolicyConfig> = {},
): RuntimeDecision {
  const effectivePolicyConfig: PolicyConfig = {
    ...DEFAULT_POLICY_CONFIG,
    ...policyConfig,
  };
  const engine = getPolicyEngineForConfig(effectivePolicyConfig);
  const decision = engine.evaluateRuntimePolicy(
    context,
    runtimeConfig,
    concurrencyTracker,
  );

  if (decision.decision === "approve") {
    return {
      kind: "approve",
      evidenceUsed: decision.evidenceUsed,
      auditHash: decision.auditHash,
    };
  }

  return {
    kind: "deny",
    deniedReasons: decision.deniedReasons ?? ["runtime denied"],
    evidenceUsed: decision.evidenceUsed,
    auditHash: decision.auditHash,
  };
}

/**
 * Transitional adapter — returns the legacy `RuntimePolicyDecision` shape so
 * existing handlers can migrate away from `new PolicyEngine(...)` without
 * rewriting their decision-handling code.
 */
export function decideRuntimeLegacy(
  context: RuntimePolicyRequestContext,
  runtimeConfig: RuntimeConfig,
  concurrencyTracker?: ConcurrencyTracker,
  policyConfig: Partial<PolicyConfig> = {},
): RuntimePolicyDecision {
  const decision = decideRuntime(
    context,
    runtimeConfig,
    concurrencyTracker,
    policyConfig,
  );
  if (decision.kind === "approve") {
    return {
      decision: "approve",
      evidenceUsed: decision.evidenceUsed,
      auditHash: decision.auditHash,
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
