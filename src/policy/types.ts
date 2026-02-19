import type {
  SymbolCard,
  GraphSlice,
  DeltaPack,
  SliceBudget,
  EvidenceValue,
} from "../mcp/types.js";
import type { SymbolRow } from "../db/schema.js";

export type PolicyRequestType =
  | "codeWindow"
  | "skeleton"
  | "hotPath"
  | "symbolCard"
  | "graphSlice"
  | "delta";

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
 * Rules are evaluated in ascending order of priority (lower number = higher priority).
 * The evaluation stops at the first rule that denies the request or downgrades it.
 *
 * Priority Guidelines:
 * - 1-10: Critical security/cost controls (e.g., maxWindowLines, maxWindowTokens)
 * - 11-20: Feature-level guards (e.g., requireIdentifiers, budgetCaps)
 * - 21-30: Optional enhancements (e.g., custom rules)
 *
 * When multiple rules have the same priority, they are evaluated in the order
 * they are registered in the policy engine.
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
  defaultDenyRaw: true,
  budgetCaps: {
    maxCards: 60,
    maxEstimatedTokens: 12000,
  },
};
