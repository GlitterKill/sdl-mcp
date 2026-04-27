// RetrievalEvidence imported for ContextSeedResult evidence field
import type { RetrievalEvidence } from "../retrieval/types.js";

export type TaskType = "debug" | "review" | "implement" | "explain";

export type RungType = "card" | "skeleton" | "hotPath" | "raw";

export type ActionStatus = "pending" | "inProgress" | "completed" | "failed";

export interface AgentTask {
  taskType: TaskType;
  taskText: string;
  repoId: string;
  budget?: BudgetOptions;
  options?: TaskOptions;
}

export interface BudgetOptions {
  maxTokens?: number;
  maxActions?: number;
  maxDurationMs?: number;
}

export interface TaskOptions {
  focusSymbols?: string[];
  focusPaths?: string[];
  includeTests?: boolean;
  requireDiagnostics?: boolean;
  /** Controls context breadth. "precise" returns minimal, workflow-efficient context.
   *  "broad" returns richer surrounding context. Default: "broad". */
  contextMode?: "precise" | "broad";
  /** Explicit search terms for symbol resolution fallback.
   *  When provided, these are used instead of extracting identifiers from taskText. */
  searchTerms?: string[];
  /** Use hybrid (FTS + vector) retrieval for context seeding. Default: true.
   *  Set to false to force plain lexical search (debugging/deterministic tests). */
  semantic?: boolean;
  /** Include retrieval evidence (which lanes contributed, per-source counts) in
   *  the response and downstream logging. Default: true. */
  includeRetrievalEvidence?: boolean;
  /** Identifiers / symbol names / IDs the user just mentioned in chat. Seeds Personalized PageRank. */
  chatMentions?: string[];
  /** Optional per-mention weight overrides for PPR seeding. */
  chatMentionWeights?: Record<string, number>;
  /** Walk direction across the dependency graph for chat-aware re-ranking. Default: "both". */
  pprDirection?: "out" | "in" | "both";
  /** Multiplicative boost ceiling for Personalized PageRank re-ranking. Default: 0.5. */
  pprWeight?: number;
}

export interface RungPath {
  rungs: RungType[];
  estimatedTokens: number;
  estimatedDurationMs: number;
  reasoning: string;
}

export interface PlannedExecution {
  task: AgentTask;
  path: RungPath;
  sequence: Action[];
}

export interface Action {
  id: string;
  type:
    | "getCard"
    | "getSkeleton"
    | "getHotPath"
    | "needWindow"
    | "search"
    | "analyze";
  status: ActionStatus;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  timestamp: number;
  durationMs: number;
  evidence: Evidence[];

  evidenceCount?: number;
}


export interface Evidence {
  type:
    | "symbolCard"
    | "skeleton"
    | "hotPath"
    | "codeWindow"
    | "delta"
    | "diagnostic"
    | "searchResult";
  reference: string;
  summary: string;
  timestamp: number;
}

export interface ContextResult {
  taskId: string;
  taskType: TaskType;
  actionsTaken: Action[];
  path: RungPath;
  /** Explains how contextMode (precise/broad) affected the results. */
  contextModeHint?: string;
  finalEvidence: Evidence[];
  summary: string;
  success: boolean;
  error?: string;
  metrics: ExecutionMetrics;
  answer?: string;
  nextBestAction?: string;
  /** Present when the broad-mode response was truncated to fit token budget. */
  truncation?: {
    originalTokens: number;
    truncatedTokens: number;
    fieldsAffected: string[];
  };
  /** Retrieval evidence with symptom classification. */
  retrievalEvidence?: {
    symptomType?: "stackTrace" | "failingTest" | "taskText" | "editedFiles";
    sources?: string[];
    feedbackBoosts?: {
      feedbackMatchCount: number;
      symbolsBoosted: number;
      feedbackIds: string[];
    };
  };
}

export interface ExecutionMetrics {
  totalDurationMs: number;
  totalTokens: number;
  totalActions: number;
  successfulActions: number;
  failedActions: number;
  cacheHits: number;
}

export interface AgentContext {
  repoId: string;
  symbolIds: string[];
  filePaths: string[];
  diagnostics?: Diagnostic[];
}

export interface Diagnostic {
  symbolId?: string;
  filePath: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Context seeding pipeline types (internal)
// ---------------------------------------------------------------------------

/** Source kind for context seed candidates. */
export type SeedSourceKind = "semantic" | "lexical" | "feedback";

/** A single candidate from the seeding pipeline. */
export interface ContextSeedCandidate {
  contextRef: string; // e.g. "symbol:abc123", "cluster:xyz", "file:path"
  source: SeedSourceKind;
  score: number; // normalized 0-1
  sourceRank: number; // rank within source (0 = best)
}

/** Result of the seeding pipeline. */
export interface ContextSeedResult {
  candidates: ContextSeedCandidate[];
  sources: { semantic: number; lexical: number; feedback: number };
  /** Hybrid retrieval evidence captured from Stage 1 entitySearch (optional). */
  evidence?: RetrievalEvidence;
}

// ---------------------------------------------------------------------------
// Symbol ranking types (multi-factor scoring)
// ---------------------------------------------------------------------------

/** Confidence tier from ranking analysis. */
export type ConfidenceTier = "high" | "medium" | "low";

/** Scored symbol with multi-factor breakdown. */
export interface ScoredSymbol {
  symbolId: string;
  totalScore: number;
  retrievalPrior: number; // 0-40
  graphProximity: number; // 0-20
  lexicalOverlap: number; // 0-15
  summarySupport: number; // 0-10
  feedbackPrior: number; // 0-10
  structuralBonus: number; // 0-8
  languageAffinity: number; // 0-4
}

/** Result of symbol ranking with confidence metadata. */
export interface SymbolRankingResult {
  ranked: ScoredSymbol[];
  topScore: number;
  secondScore: number;
  confidenceTier: ConfidenceTier;
  sourceAgreement: number; // how many sources agree on top symbols
}
