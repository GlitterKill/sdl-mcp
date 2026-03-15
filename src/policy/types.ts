import type {
  SymbolCard,
  GraphSlice,
  DeltaPack,
  SliceBudget,
  EvidenceValue,
} from "../domain/types.js";
import type { SymbolRow } from "../db/schema.js";

export type PolicyRequestType =
  | "codeWindow"
  | "skeleton"
  | "hotPath"
  | "symbolCard"
  | "graphSlice"
  | "delta"
  | "runtimeExecute";

export interface PolicyRequestContext {
  requestType: PolicyRequestType;
  repoId: string;
  symbolId?: string;
  file?: string;
  versionId?: string;

  maxWindowLines?: number;
  maxWindowTokens?: number;
  identifiersToFind?: string[];
  budget?: SliceBudget;
  expectedLines?: number;
  reason?: string;

  sliceContext?: GraphSlice;
  symbolData?: SymbolRow;
  cardData?: SymbolCard;
  deltaData?: DeltaPack;
}

export interface PolicyEvidence {
  type: string;
  value: EvidenceValue;
  reason: string;
}

export interface PolicyRule {
  name: string;
  enabled: boolean;
  priority: number;
  evaluate: (context: PolicyRequestContext) => {
    passed: boolean;
    evidence: PolicyEvidence;
    downgradeTo?: "skeleton" | "hotpath";
  };
}

/**
 * PolicyRule Priority Ordering
 *
 * Rules are evaluated in DESCENDING order of priority (higher number = evaluated first).
 * All rules are evaluated; denials accumulate unless overridden by break-glass.
 *
 * Priority Guidelines:
 * - 100: Hard limits (e.g., maxWindowLines, maxWindowTokens) — evaluated first
 * - 90: Input validation (e.g., requireIdentifiers)
 * - 80: Budget enforcement (e.g., budgetCaps)
 * - 10: Override mechanisms (e.g., break-glass) — evaluated last, can clear prior denials
 *
 * When multiple rules have the same priority, they are evaluated in alphabetical
 * name order.
 */

export interface PolicyDecision {
  decision:
    | "approve"
    | "deny"
    | "downgrade-to-skeleton"
    | "downgrade-to-hotpath";
  evidenceUsed: PolicyEvidence[];
  auditHash: string;
  deniedReasons?: string[];
  downgradeTarget?: {
    type: "skeleton" | "hotpath";
    symbolId: string;
    repoId: string;
  };
}

export interface PolicyConfig {
  maxWindowLines: number;
  maxWindowTokens: number;
  requireIdentifiers: boolean;
  allowBreakGlass: boolean;
  defaultMinCallConfidence?: number;
  defaultDenyRaw: boolean;
  budgetCaps: {
    maxCards: number;
    maxEstimatedTokens: number;
  };
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  maxWindowLines: 180,
  maxWindowTokens: 1400,
  requireIdentifiers: true,
  allowBreakGlass: true,
  defaultMinCallConfidence: undefined,
  defaultDenyRaw: true,
  budgetCaps: {
    maxCards: 60,
    maxEstimatedTokens: 12000,
  },
};

// ============================================================================
// Runtime Execution Policy Types
// ============================================================================

/**
 * Policy context for runtime execution requests.
 * Separate from the code-access PolicyRequestContext to avoid overloading
 * downgrade semantics that don't apply to execution.
 */
export interface RuntimePolicyRequestContext {
  requestType: "runtimeExecute";
  repoId: string;
  runtime: string;
  executable: string;
  args: string[];
  relativeCwd: string;
  timeoutMs: number;
  envKeys: string[];
}

/**
 * Policy decision for runtime execution.
 * Uses approve/deny only — no downgrade targets (nothing to downgrade to).
 * Reuses the shared PolicyEvidence and audit hash infrastructure.
 */
export interface RuntimePolicyDecision {
  decision: "approve" | "deny";
  evidenceUsed: PolicyEvidence[];
  auditHash: string;
  deniedReasons?: string[];
}
