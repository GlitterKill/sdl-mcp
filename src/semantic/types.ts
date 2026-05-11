import type { EdgeType, RepoId, SymbolId } from "../domain/types.js";

export type SemanticProviderType = "scip" | "lsp";
export type ActiveSemanticProviderType = SemanticProviderType;
// Historical provider-run rows can contain LSIF from development builds. New
// writable semantic indexes and provider runs must use active providers only.
export type PersistedSemanticProviderType = SemanticProviderType | "lsif";

export type SemanticCapability =
  | "definition"
  | "reference"
  | "implementation"
  | "typeDefinition"
  | "hover"
  | "diagnostic"
  | "documentSymbol"
  | "semanticToken"
  | "callHierarchy"
  | "typeHierarchy";

export interface SemanticRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface SemanticProvenance {
  providerType: ActiveSemanticProviderType;
  providerId: string;
  capability: SemanticCapability;
  confidence: number;
  runId: string;
  sourceIndexPath?: string;
  resolutionPhase: string;
}

export interface SemanticDocument {
  languageId: string;
  sourcePath: string;
  sourceHash?: string;
  occurrences: SemanticOccurrence[];
  diagnostics: SemanticDiagnostic[];
}

export interface SemanticSymbol {
  providerSymbolId: string;
  sdlSymbolId?: SymbolId;
  name: string;
  kind?: string;
  languageId: string;
  sourcePath?: string;
  range?: SemanticRange;
  documentation?: string[];
  external?: boolean;
  packageName?: string;
  packageVersion?: string;
}

export interface SemanticOccurrence {
  providerSymbolId: string;
  sdlSymbolId?: SymbolId;
  sourcePath: string;
  range: SemanticRange;
  capability: SemanticCapability;
  confidence: number;
}

export interface SemanticEdge {
  sourceProviderSymbolId?: string;
  targetProviderSymbolId?: string;
  sourceSymbolId?: SymbolId;
  targetSymbolId?: SymbolId;
  /**
   * Optional lower-confidence target this provider edge is meant to replace.
   * This prevents enrichment from deleting an arbitrary unresolved edge when
   * one source symbol has multiple unresolved calls.
   */
  replaceTargetSymbolId?: SymbolId;
  edgeType: EdgeType;
  confidence: number;
  resolution: "exact" | "heuristic" | "unresolved";
  resolverId: string;
  resolutionPhase: string;
  capability: SemanticCapability;
  provenance: SemanticProvenance;
}

export interface SemanticDiagnostic {
  id: string;
  repoId: RepoId;
  runId: string;
  providerType: ActiveSemanticProviderType;
  providerId: string;
  languageId: string;
  sourcePath: string;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  code?: string;
  range?: SemanticRange;
}

export interface SemanticIndex {
  repoId: RepoId;
  runId: string;
  providerType: ActiveSemanticProviderType;
  providerId: string;
  providerVersion?: string;
  sourceIndexPath?: string;
  generatedAt: string;
  documents: SemanticDocument[];
  symbols: SemanticSymbol[];
  edges: SemanticEdge[];
  diagnostics: SemanticDiagnostic[];
}

export interface SemanticProviderRunBase<
  TProviderType extends PersistedSemanticProviderType,
> {
  runId: string;
  repoId: RepoId;
  providerType: TProviderType;
  providerId: string;
  providerVersion?: string;
  languages: string[];
  sourceIndexPath?: string;
  sourceHash?: string;
  status: "planned" | "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  finishedAt?: string;
  documentsProcessed: number;
  symbolsMatched: number;
  edgesCreated: number;
  edgesUpgraded: number;
  edgesReplaced: number;
  edgesSkipped: number;
  diagnosticsCount: number;
  precisionScore?: number;
  cacheHit?: boolean;
  canAffectPass2?: boolean;
  selected?: boolean;
  metadataJson?: string;
  error?: string;
}

export interface SemanticProviderRun
  extends SemanticProviderRunBase<SemanticProviderType> {}

export interface PersistedSemanticProviderRun
  extends SemanticProviderRunBase<PersistedSemanticProviderType> {}

export interface SemanticPrecisionInputs {
  filesCovered: number;
  filesEligible: number;
  symbolsMatched: number;
  symbolsTotal: number;
  resolvedEdges: number;
  totalEdges: number;
  diagnosticsAvailable: boolean;
  providerType: ActiveSemanticProviderType;
  pass2SkippedFiles: number;
  pass2EligibleFiles: number;
}

export interface SemanticPrecisionMetric {
  id: string;
  repoId: RepoId;
  runId: string;
  languageId: string;
  providerType: SemanticProviderType;
  providerId: string;
  score: number;
  filesCovered: number;
  filesEligible: number;
  symbolMatchRate: number;
  resolvedEdgeRate: number;
  diagnosticsAvailable: boolean;
  pass2SkipRate: number;
  computedAt: string;
}
