import type {
  RepoId,
  SymbolId,
  VersionId,
  EdgeType,
  SymbolKind,
  Visibility,
} from "../db/schema.js";

export interface Range {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface SymbolSignature {
  name: string;
  params?: Array<{ name: string; type?: string }>;
  returns?: string;
  generics?: string[];
  overloads?: string[];
}

export interface SymbolDeps {
  imports: string[];
  calls: SymbolId[];
}

export interface SymbolMetrics {
  fanIn?: number;
  fanOut?: number;
  churn30d?: number;
  testRefs?: string[];
}

export interface SymbolCard {
  symbolId: SymbolId;
  repoId: RepoId;
  file: string;
  range: Range;

  kind: SymbolKind;
  name: string;
  exported: boolean;
  visibility?: Visibility;

  signature?: SymbolSignature;

  summary?: string;
  invariants?: string[];
  sideEffects?: string[];

  deps: SymbolDeps;
  metrics?: SymbolMetrics;

  version: {
    ledgerVersion: VersionId;
    astFingerprint: string;
  };
}

export interface CompressedEdge {
  from: SymbolId;
  to: SymbolId;
  type: EdgeType;
  weight: number;
}

export interface SliceBudget {
  maxCards?: number;
  maxEstimatedTokens?: number;
}

export interface SliceTruncation {
  truncated: boolean;
  droppedCards: number;
  droppedEdges: number;
  howToResume: {
    type: "cursor" | "token";
    value: string | number;
  } | null;
}

export interface GraphSlice {
  repoId: RepoId;
  versionId: VersionId;
  budget: Required<SliceBudget>;
  startSymbols: SymbolId[];

  cards: SymbolCard[];
  edges: CompressedEdge[];

  frontier?: Array<{ symbolId: SymbolId; score: number; why: string }>;
  truncation?: SliceTruncation;
}

export interface DeltaSymbolChange {
  symbolId: SymbolId;
  changeType: "added" | "removed" | "modified";
  signatureDiff?: { before?: string; after?: string };
  invariantDiff?: { added: string[]; removed: string[] };
  sideEffectDiff?: { added: string[]; removed: string[] };
}

export interface BlastRadiusItem {
  symbolId: SymbolId;
  reason: string;
  distance: number;
  rank: number;
  signal: "diagnostic" | "directDependent" | "graph";
}

export interface DiagnosticsSummary {
  totalErrors: number;
  totalWarnings: number;
  totalInfo: number;
  topFiles: Array<{ file: string; errorCount: number }>;
}

export interface DiagnosticSuspect {
  symbolId: string;
  file: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
  code: string | number;
  messageShort: string;
}

export interface DeltaPack {
  repoId: RepoId;
  fromVersion: VersionId;
  toVersion: VersionId;
  changedSymbols: DeltaSymbolChange[];
  blastRadius: BlastRadiusItem[];
  diagnosticsSummary?: DiagnosticsSummary;
  diagnosticSuspects?: DiagnosticSuspect[];
  truncation?: {
    truncated: boolean;
    droppedChanges: number;
    droppedBlastRadius: number;
    howToResume: {
      type: "cursor" | "token";
      value: string | number;
    } | null;
  };
  trimmedSet?: TrimmedSet;
  spilloverHandle?: SpilloverHandle;
}

export interface DeltaPack {
  repoId: RepoId;
  fromVersion: VersionId;
  toVersion: VersionId;
  changedSymbols: DeltaSymbolChange[];
  blastRadius: BlastRadiusItem[];
}

export interface CodeWindowRequest {
  repoId: RepoId;
  symbolId: SymbolId;
  reason: string;
  expectedLines: number;
  identifiersToFind: string[];
  granularity?: "symbol" | "block" | "fileWindow";
  maxTokens?: number;
  sliceContext?: {
    taskText: string;
    stackTrace?: string;
    failingTestPath?: string;
    editedFiles?: string[];
    entrySymbols?: SymbolId[];
    budget?: SliceBudget;
  };
}

export interface CodeWindowResponseApproved {
  approved: true;
  repoId: RepoId;
  symbolId: SymbolId;
  file: string;
  range: Range;
  code: string;
  whyApproved: string[];
  estimatedTokens: number;
}

export interface CodeWindowResponseDenied {
  approved: false;
  whyDenied: string[];
  suggestedNextRequest?: Partial<CodeWindowRequest>;
}

export type CodeWindowResponse =
  | CodeWindowResponseApproved
  | CodeWindowResponseDenied;

export type SliceHandle = string;

export interface SliceLease {
  expiresAt: string;
  minVersion: VersionId | null;
  maxVersion: VersionId | null;
}

export interface SliceEtag {
  handle: SliceHandle;
  version: VersionId;
  sliceHash: string;
}

export interface NotModifiedResponse {
  notModified: true;
  etag: string;
  ledgerVersion: VersionId;
}

export interface SliceBuildResponse {
  sliceHandle: SliceHandle;
  ledgerVersion: VersionId;
  lease: SliceLease;
  sliceEtag?: SliceEtag;
  slice: GraphSlice;
}

export type PolicyDecisionType =
  | "approve"
  | "deny"
  | "downgrade-to-skeleton"
  | "downgrade-to-hotpath";

export type EvidenceValue =
  | string
  | number
  | boolean
  | { [key: string]: EvidenceValue }
  | EvidenceValue[]
  | null;

export interface DecisionEvidence {
  type: string;
  value: EvidenceValue;
  reason: string;
}

export interface PolicyDecision {
  decision: PolicyDecisionType;
  evidenceUsed: DecisionEvidence[];
  auditHash: string;
  deniedReasons?: string[];
}

export type NextBestAction =
  | "requestSkeleton"
  | "requestHotPath"
  | "requestRaw"
  | "refreshSlice"
  | "provideIdentifiersToFind"
  | "provideErrorCodeRefs"
  | "provideFrontierJustification"
  | "increaseBudget"
  | "narrowScope"
  | "retryWithSameInputs";

export interface RequiredFieldsForNext {
  requestSkeleton?: {
    symbolId: SymbolId;
    repoId: RepoId;
  };
  requestHotPath?: {
    symbolId: SymbolId;
    repoId: RepoId;
    identifiersToFind: string[];
    maxTokens?: number;
  };
  requestRaw?: {
    repoId: RepoId;
    symbolId: SymbolId;
    reason: string;
    expectedLines: number;
    identifiersToFind: string[];
    granularity?: "symbol" | "block" | "fileWindow";
  };
  refreshSlice?: {
    sliceHandle: SliceHandle;
    knownVersion: VersionId;
  };
  provideIdentifiersToFind?: {
    minCount: number;
    examples?: string[];
  };
  provideErrorCodeRefs?: {
    errorCode: string;
  };
  provideFrontierJustification?: {
    symbolId: SymbolId;
  };
  increaseBudget?: {
    field: "maxCards" | "maxEstimatedTokens" | "expectedLines";
    suggestedValue: number;
  };
  narrowScope?: {
    field: string;
    reason: string;
  };
}

export interface TrimmedSet {
  trimmed: boolean;
  keptSymbols: SymbolId[];
  droppedSymbols: Array<{
    symbolId: SymbolId;
    reason: string;
    priority: "must" | "should" | "optional";
  }>;
  spilloverHandle: SpilloverHandle | null;
}

export type SpilloverHandle = string;

export type SkeletonOp =
  | {
      op: "call";
      target: SymbolId | string;
      line?: number;
    }
  | {
      op: "if";
      line: number;
    }
  | {
      op: "try";
      line: number;
    }
  | {
      op: "return";
      line?: number;
    }
  | {
      op: "throw";
      line?: number;
    }
  | {
      op: "elision";
      reason: "too-long" | "nested" | "block";
      startLine: number;
      endLine: number;
      estimatedLines: number;
    }
  | {
      op: "sideEffect";
      type: "network" | "fs" | "env" | "process" | "global" | "unknown";
      line?: number;
    };

export interface SkeletonIR {
  symbolId: SymbolId;
  ops: SkeletonOp[];
  hash: string;
  totalLines: number;
  elidedLines: number;
}

export interface SkeletonResponse {
  symbolId: SymbolId;
  skeletonText: string;
  skeletonIR: SkeletonIR;
}

export interface StalenessTiers {
  interfaceStable: boolean;
  behaviorStable: boolean;
  sideEffectsStable: boolean;
  riskScore: number;
}

export interface DeltaSymbolChangeWithTiers extends DeltaSymbolChange {
  tiers?: StalenessTiers;
}

export interface DeltaPackWithGovernance extends DeltaPack {
  trimmedSet?: TrimmedSet;
  spilloverHandle?: SpilloverHandle;
  changedSymbols: DeltaSymbolChangeWithTiers[];
}

export interface SliceRefreshResponse {
  sliceHandle: SliceHandle;
  knownVersion: VersionId;
  currentVersion: VersionId;
  notModified?: boolean;
  delta: DeltaPackWithGovernance | null;
  lease?: SliceLease;
}

export interface SpilloverResponse {
  spilloverHandle: SpilloverHandle;
  cursor?: string;
  hasMore: boolean;
  symbols: SymbolCard[];
}

export interface PolicyResponse<T = unknown> {
  decision: PolicyDecisionType;
  evidenceUsed: DecisionEvidence[];
  auditHash: string;
  deniedReasons?: string[];
  nextBestAction?: NextBestAction;
  requiredFieldsForNext?: RequiredFieldsForNext;
  data?: T;
}

export interface CardWithETag extends SymbolCard {
  etag: string;
}

// ============================================================================
// Directory Summary Types (for token-efficient codebase overviews)
// ============================================================================

/**
 * Aggregated symbol counts by kind for a directory or repo.
 */
export interface SymbolCountsByKind {
  function: number;
  class: number;
  interface: number;
  type: number;
  method: number;
  variable: number;
  module: number;
  constructor: number;
}

/**
 * A compact symbol reference for directory summaries.
 * Much smaller than full SymbolCard (~15 tokens vs ~135).
 */
export interface CompactSymbolRef {
  symbolId: SymbolId;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  signature?: string;
}

/**
 * Summary of a single directory's contents.
 * Compresses many symbols into a compact representation.
 */
export interface DirectorySummary {
  /** Directory path relative to repo root (e.g., "src/graph/") */
  path: string;
  /** Number of source files in this directory (not recursive) */
  fileCount: number;
  /** Total symbol count in this directory */
  symbolCount: number;
  /** Number of exported/public symbols */
  exportedCount: number;
  /** Symbol counts broken down by kind */
  byKind: SymbolCountsByKind;
  /** Names of exported symbols (the public API surface) */
  exports: string[];
  /** Top symbols by fan-in (most depended upon) */
  topByFanIn: CompactSymbolRef[];
  /** Top symbols by churn (most frequently changed) */
  topByChurn: CompactSymbolRef[];
  /** Subdirectories (for hierarchical view) */
  subdirectories?: string[];
  /** Estimated tokens if all symbols were rendered as full cards */
  estimatedFullTokens: number;
  /** Actual tokens for this summary */
  summaryTokens: number;
}

/**
 * Hotspot analysis for the codebase.
 */
export interface CodebaseHotspots {
  /** Symbols with highest fan-in (most depended upon) */
  mostDepended: CompactSymbolRef[];
  /** Symbols with highest churn in last 30 days */
  mostChanged: CompactSymbolRef[];
  /** Files with most symbols */
  largestFiles: Array<{ file: string; symbolCount: number }>;
  /** Files with most edges (highest connectivity) */
  mostConnected: Array<{ file: string; edgeCount: number }>;
}

/**
 * High-level repository statistics.
 */
export interface RepoStats {
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  exportedSymbolCount: number;
  byKind: SymbolCountsByKind;
  byEdgeType: {
    call: number;
    import: number;
    config: number;
  };
  avgSymbolsPerFile: number;
  avgEdgesPerSymbol: number;
}

/**
 * Complete repository overview with progressive detail levels.
 */
export interface RepoOverview {
  repoId: RepoId;
  versionId: VersionId;
  generatedAt: string;

  /** High-level statistics */
  stats: RepoStats;

  /** Directory-level summaries */
  directories: DirectorySummary[];

  /** Optional hotspot analysis */
  hotspots?: CodebaseHotspots;

  /** Top-level architecture layers (inferred from directory structure) */
  layers?: string[];

  /** Entry points (files named main, index, server, etc.) */
  entryPoints?: string[];

  /** Token efficiency metrics */
  tokenMetrics: {
    /** Estimated tokens if rendering all symbols as full cards */
    fullCardsEstimate: number;
    /** Actual tokens in this overview */
    overviewTokens: number;
    /** Compression ratio achieved */
    compressionRatio: number;
  };
}

/**
 * Request parameters for sdl.repo.overview tool.
 */
export interface RepoOverviewRequest {
  repoId: RepoId;
  /**
   * Level of detail:
   * - "stats": Just high-level statistics (~100 tokens)
   * - "directories": Stats + directory summaries (~500-1000 tokens)
   * - "full": Stats + directories + hotspots + architecture (~1500 tokens)
   */
  level: "stats" | "directories" | "full";
  /** Include hotspot analysis (most depended, most changed) */
  includeHotspots?: boolean;
  /** Filter to specific directories (glob patterns supported) */
  directories?: string[];
  /** Maximum directories to include in response */
  maxDirectories?: number;
  /** Maximum exports to list per directory */
  maxExportsPerDirectory?: number;
}
