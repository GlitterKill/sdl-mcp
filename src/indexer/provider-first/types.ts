import type {
  EdgeResolutionStrategy,
  EdgeType,
  Range,
  RepoId,
  SymbolId,
  SymbolKind,
} from "../../domain/types.js";

export type ProviderSourceType = "scip" | "lsp" | "legacy";
export type ProviderFirstSelectedPipeline = "legacy" | "providerFirst";
export type CoverageLevel = "none" | "partial" | "full";
export type LegacyFallbackScope = "skip" | "targeted" | "full";
export type ProviderFactKind =
  | "file"
  | "symbol"
  | "occurrence"
  | "edge"
  | "externalSymbol"
  | "diagnostic"
  | "coverage"
  | "providerRun";

export interface ProviderFactBase {
  repoId: RepoId;
  generationId: string;
  providerType: Exclude<ProviderSourceType, "legacy">;
  providerId: string;
  providerVersion?: string;
  emittedAt: string;
}

export interface FileFact extends ProviderFactBase {
  kind: "file";
  fileId: string;
  relPath: string;
  languageId?: string;
  contentHash?: string;
}

export interface SymbolFact extends ProviderFactBase {
  kind: "symbol";
  symbolId: SymbolId;
  providerSymbolId: string;
  name: string;
  symbolKind: SymbolKind;
  relPath: string;
  range?: Range;
  signature?: string;
  documentation: string[];
  external: boolean;
}

export interface OccurrenceFact extends ProviderFactBase {
  kind: "occurrence";
  occurrenceId: string;
  providerSymbolId: string;
  symbolId?: SymbolId;
  relPath: string;
  range: Range;
  role:
    | "definition"
    | "reference"
    | "import"
    | "implementation"
    | "typeDefinition"
    | "unknown";
}

export interface EdgeFact extends ProviderFactBase {
  kind: "edge";
  sourceSymbolId: SymbolId;
  targetSymbolId: SymbolId;
  edgeType: EdgeType;
  resolution: EdgeResolutionStrategy;
  confidence: number;
  dedupeKey: string;
}

export interface ExternalSymbolFact extends ProviderFactBase {
  kind: "externalSymbol";
  symbolId: SymbolId;
  providerSymbolId: string;
  name: string;
  symbolKind?: SymbolKind;
  packageName?: string;
  packageVersion?: string;
  documentation: string[];
}

export interface DiagnosticFact extends ProviderFactBase {
  kind: "diagnostic";
  diagnosticId: string;
  relPath: string;
  message: string;
  severity: "error" | "warning" | "information" | "hint";
  code?: string;
  range?: Range;
}

export interface CoverageFact extends ProviderFactBase {
  kind: "coverage";
  relPath: string;
  symbolCoverage: CoverageLevel;
  referenceCoverage: CoverageLevel;
  callProofCoverage: CoverageLevel;
  diagnosticCoverage: CoverageLevel;
  totalSymbols: number;
  emittedSymbols: number;
  totalOccurrences: number;
  unresolvedOccurrences: number;
  totalResolvedReferences: number;
  callProofUnavailableReferences: number;
  legacyFallback: LegacyFallbackScope;
}

export interface ProviderRunFact extends ProviderFactBase {
  kind: "providerRun";
  runId: string;
  status: "planned" | "running" | "succeeded" | "failed" | "skipped";
  startedAt: string;
  finishedAt?: string;
  sourceIndexPath?: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  diagnosticCount: number;
  errorMessage?: string;
}

export interface ProviderFactSet {
  files: FileFact[];
  symbols: SymbolFact[];
  occurrences: OccurrenceFact[];
  edges: EdgeFact[];
  externalSymbols: ExternalSymbolFact[];
  diagnostics: DiagnosticFact[];
  coverage: CoverageFact[];
  providerRuns: ProviderRunFact[];
}

export interface ProviderSourcePlan {
  type: ProviderSourceType;
  providerId: string;
  priority: number;
  reason: string;
}

export interface ProviderFirstPipelineSelection {
  requestedMode: "legacy" | "providerFirst" | "auto";
  selectedPipeline: ProviderFirstSelectedPipeline;
  sources: ProviderSourcePlan[];
  warnings: string[];
}
