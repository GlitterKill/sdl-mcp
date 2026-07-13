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
