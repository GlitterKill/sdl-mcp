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
  /** Controls context breadth. "precise" returns minimal, chain-efficient context.
   *  "broad" returns richer surrounding context. Default: "broad". */
  contextMode?: "precise" | "broad";
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

export interface OrchestrationResult {
  taskId: string;
  taskType: TaskType;
  actionsTaken: Action[];
  path: RungPath;
  finalEvidence: Evidence[];
  summary: string;
  success: boolean;
  error?: string;
  metrics: ExecutionMetrics;
  answer?: string;
  nextBestAction?: string;
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
