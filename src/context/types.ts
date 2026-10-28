import type { RetrievalSource } from "../retrieval/types.js";

export type ContextTaskType = "debug" | "review" | "implement" | "explain";
export type ContextRung = "card" | "skeleton" | "hotPath";
export type ContextTier = 0 | 1;
export type ContextRetrievalLevel =
  | "hybrid"
  | "hybrid-partial"
  | "lexical"
  | "graph-only"
  | "insufficient";
export type ContextLaneId =
  | "exactIdentifier"
  | "symbolFts"
  | "symbolVec"
  | "fileSummaryFts"
  | "fileSummaryVec"
  | "graph"
  | "overlay"
  | "feedback"
  | "memory";
export type ContextAuxiliaryLane = "fileSummary" | "feedback" | "memory";

export interface TaskProfile {
  taskType: ContextTaskType;
  rungPreference: readonly ContextRung[];
  direction: "out";
  maxDepth: null;
  includeTests: boolean;
  auxiliaryLanes: readonly ContextAuxiliaryLane[];
}

export interface ContextV2Request {
  repoId: string;
  taskType: ContextTaskType;
  taskText: string;
  budget: { maxTokens: number };
  focusPaths?: string[];
  focusSymbols?: string[];
  chatMentions?: string[];
  includeTests?: boolean;
}

export interface ContextCandidate {
  symbolId: string;
  path: string;
  hasTestCaseFacet?: boolean;
  /** Present only for explicit test-discovery requests naming qualified targets. */
  testCaseQualifiedMatch?: boolean;
  rank: number;
  tier: ContextTier;
  lanes: ContextLaneId[];
  sourceRanks?: Partial<Record<RetrievalSource, number>>;
  estimates: Partial<Record<ContextRung, number>>;
}

export interface SelectedContextBundle {
  candidate: ContextCandidate;
  rungs: ContextRung[];
}

export interface LogicalAction {
  id: string;
  args: Record<string, unknown>;
}

export interface OmittedContextItem {
  symbolId: string;
  path: string;
  rung: ContextRung;
  rank: number;
  tier: ContextTier;
  reason: "budget" | "unavailable";
  action: LogicalAction;
}

export interface ContextEvidence {
  rung: ContextRung;
  symbolId: string;
  path: string;
  rank: number;
  tier: ContextTier;
  lanes: ContextLaneId[];
  content: unknown;
}

export interface ContextEdge {
  from: string;
  to: string;
  kind: string;
  confidencePermille: number;
}

export interface ContextRetrievalLane {
  id: ContextLaneId;
  available: boolean;
  coveragePermille?: number;
}

export interface ContextPayload {
  status: "complete" | "budgetLimited" | "empty";
  taskType: ContextTaskType;
  retrieval: {
    level: Exclude<ContextRetrievalLevel, "insufficient">;
    lanes: ContextRetrievalLane[];
  };
  evidence: ContextEvidence[];
  edges: ContextEdge[];
  omitted: {
    total: number;
    byReason: { budget: number; unavailable?: number };
    highestRanked: OmittedContextItem[];
  };
  nextActions: LogicalAction[];
}

export interface ContextRecoveryError {
  isError: true;
  error: {
    code:
      | "CONTEXT_RETRIEVAL_INSUFFICIENT"
      | "CONTEXT_FOCUS_PATH_UNAVAILABLE";
    message: string;
    recovery: LogicalAction[];
  };
}

export interface ContextRetrievalBackendError {
  isError: true;
  error: {
    code: "CONTEXT_RETRIEVAL_BACKEND_FAILED";
    message: string;
    recovery: LogicalAction[];
  };
}

export interface ContextBudgetError {
  isError: true;
  error: {
    code: "CONTEXT_BUDGET_TOO_SMALL";
    message: string;
    minimumTokens: number;
  };
}

export type ContextEngineV2Result =
  | ContextPayload
  | ContextRecoveryError
  | ContextRetrievalBackendError
  | ContextBudgetError;

/** Minimal context-building contract used for production defaults and test injection. */
export interface ContextEngine {
  buildContext(request: ContextV2Request): Promise<ContextEngineV2Result>;
}
