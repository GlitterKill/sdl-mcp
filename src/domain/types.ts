// ---------------------------------------------------------------------------
// Domain primitives — canonical definitions (no imports from ../db/)
// ---------------------------------------------------------------------------

export type EdgeType = "import" | "call" | "config" | "implements";
export type EdgeResolutionStrategy = "exact" | "heuristic" | "unresolved";
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "module"
  | "method"
  | "constructor"
  | "variable";
export type Visibility =
  | "public"
  | "protected"
  | "private"
  | "exported"
  | "internal";

export type RepoId = string;
export type SymbolId = string;
export type VersionId = string;

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
  calls: string[];
  callsNote?: string;
}

export interface SliceDepRef {
  symbolId: string;
  confidence: number;
}

export interface SliceSymbolDeps {
  imports: SliceDepRef[];
  calls: SliceDepRef[];
}

export interface CallResolutionRef {
  symbolId: SymbolId;
  label: string;
  confidence: number;
  resolutionReason?: string;
  resolverId?: string;
  resolutionPhase?: string;
}

export interface CallResolution {
  minCallConfidence?: number;
  calls: CallResolutionRef[];
}

export interface CanonicalTest {
  file: string; // relative path to the test file
  symbolId?: SymbolId; // specific test function symbolId, if resolvable
  distance: number; // BFS hops from source symbol to this test node
  proximity: number; // 0–1 score: 1.0 = direct test, lower = indirect
}

export interface SymbolMetrics {
  fanIn?: number;
  fanOut?: number;
  churn30d?: number;
  testRefs?: string[];
  canonicalTest?: CanonicalTest;
}

export interface SymbolClusterInfo {
  clusterId: string;
  label: string;
  memberCount: number;
}

export type ProcessRole = "entry" | "intermediate" | "exit";

export interface SymbolProcessInfo {
  processId: string;
  label: string;
  role: ProcessRole;
  depth: number;
}

export type CardDetailLevel =
  | "minimal"
  | "signature"
  | "deps"
  | "compact"
  | "full";

export type LegacyCardDetailLevel = "compact" | "full";

export const CARD_DETAIL_LEVELS: CardDetailLevel[] = [
  "minimal",
  "signature",
  "deps",
  "compact",
  "full",
];

export const CARD_DETAIL_LEVEL_RANK: Record<CardDetailLevel, number> = {
  minimal: 0,
  signature: 1,
  deps: 2,
  compact: 3,
  full: 4,
};

export function normalizeCardDetailLevel(
  level: CardDetailLevel | LegacyCardDetailLevel | undefined,
): CardDetailLevel {
  if (!level) return "deps";
  if (level === "compact") return "deps";
  // Validate against known values
  const validLevels: readonly string[] = [
    "minimal",
    "signature",
    "deps",
    "full",
  ];
  if (validLevels.includes(level)) {
    return level as CardDetailLevel;
  }
  return "deps"; // safe fallback for unknown values
}

export function legacyDetailLevelToWire(
  level: CardDetailLevel | LegacyCardDetailLevel | undefined,
): CardDetailLevel {
  if (!level) return "compact";
  // Validate against known values
  const validLevels: readonly string[] = [
    "minimal",
    "signature",
    "deps",
    "compact",
    "full",
  ];
  if (validLevels.includes(level)) {
    return level as CardDetailLevel;
  }
  return "compact"; // safe fallback for unknown values
}

export function isLegacyDetailLevel(
  level: string,
): level is LegacyCardDetailLevel {
  return level === "compact" || level === "full";
}

export function cardDetailLevelOrder(level: CardDetailLevel): number {
  return CARD_DETAIL_LEVEL_RANK[level];
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

  cluster?: SymbolClusterInfo;
  processes?: SymbolProcessInfo[];
  callResolution?: CallResolution;

  deps: SymbolDeps;
  metrics?: SymbolMetrics;
  detailLevel?: CardDetailLevel;
  etag?: string;

  // SCIP integration fields
  external?: boolean;
  scipSymbol?: string;
  source?: "treesitter" | "scip" | "both";
  packageName?: string;
  packageVersion?: string;

  version: {
    ledgerVersion: VersionId;
    astFingerprint: string;
  };
}

export interface SliceSymbolCard extends Omit<
  SymbolCard,
  "repoId" | "etag" | "version" | "deps"
> {
  deps: SliceSymbolDeps;
  version: {
    astFingerprint: string;
  };
}

export interface SliceCardRef {
  symbolId: SymbolId;
  etag: string;
  detailLevel: CardDetailLevel;
}

export interface DetailLevelMetadata {
  requested: CardDetailLevel;
  effective: CardDetailLevel;
  budgetAdaptive: boolean;
  cardsByLevel: Record<CardDetailLevel, number>;
}

export type CompressedEdge = [
  fromIndex: number,
  toIndex: number,
  type: EdgeType,
  weight: number,
];

export interface SliceBudget {
  maxCards?: number;
  maxEstimatedTokens?: number;
}

export interface SliceBuildInput {
  repoId: RepoId;
  taskText?: string;
  stackTrace?: string;
  failingTestPath?: string;
  editedFiles?: string[];
  entrySymbols?: SymbolId[];
  knownCardEtags?: Record<SymbolId, string>;
  cardDetail?: CardDetailLevel;
  adaptiveDetail?: boolean;
  budget?: SliceBudget;
  minConfidence?: number;
  minCallConfidence?: number;
  includeResolutionMetadata?: boolean;
}

export interface ConfidenceDistribution {
  high: number;
  medium: number;
  low: number;
  unknown: number;
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
  symbolIndex: SymbolId[];

  cards: SliceSymbolCard[];
  cardRefs?: SliceCardRef[];
  edges: CompressedEdge[];

  frontier?: Array<{ symbolId: SymbolId; score: number; why: string }>;
  truncation?: SliceTruncation;
  confidenceDistribution?: ConfidenceDistribution;
  detailLevelMetadata?: DetailLevelMetadata;
  staleSymbols?: SymbolId[]; // symbolIds that changed since this slice was issued
  memories?: SurfacedMemory[];
}

/**
 * Discriminated union for a single symbol change in a delta pack.
 *
 * `"added"` and `"removed"` variants carry no diff fields — there is nothing
 * to diff when one side is absent. Diff fields are exclusive to `"modified"`
 * so TypeScript's narrowing (`change.changeType === "modified"`) gates access
 * to `signatureDiff`, `invariantDiff`, and `sideEffectDiff` at compile time.
 */
export type DeltaSymbolChange =
  | {
      symbolId: SymbolId;
      changeType: "added" | "removed";
      name?: string;
      kind?: string;
      file?: string;
    }
  | {
      symbolId: SymbolId;
      changeType: "modified";
      name?: string;
      kind?: string;
      file?: string;
      signatureDiff?: { before?: string; after?: string };
      invariantDiff?: { added: string[]; removed: string[] };
      sideEffectDiff?: { added: string[]; removed: string[] };
    };

export interface BlastRadiusItem {
  symbolId: SymbolId;
  name?: string;
  kind?: string;
  file?: string;
  reason?: string;
  distance: number;
  rank: number;
  signal: "diagnostic" | "directDependent" | "graph" | "process";
  fanInTrend?: {
    previous: number;
    current: number;
    growthRate: number; // (current - previous) / max(previous, 1)
    isAmplifier: boolean; // growthRate > FAN_IN_AMPLIFIER_THRESHOLD
  };
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
  repoId?: RepoId;
  symbolId: SymbolId;
  file: string;
  range: Range;
  code: string;
  whyApproved: string[];
  warnings?: string[];
  estimatedTokens: number;
}

export interface CodeWindowResponseDenied {
  approved: false;
  whyDenied: string[];
  suggestedNextRequest?: Partial<CodeWindowRequest>;
  nextBestAction?: NextBestActionCallable;
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
  | { [key: string]: EvidenceValue | undefined }
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
  | "buildSlice"
  | "provideIdentifiersToFind"
  | "provideErrorCodeRefs"
  | "provideFrontierJustification"
  | "increaseBudget"
  | "narrowScope"
  | "retryWithSameInputs";

/**
 * A directly executable tool suggestion returned on policy denials.
 * Provides the exact tool name, arguments, and rationale so the agent
 * can immediately retry with a less expensive context-ladder rung.
 */
export interface NextBestActionCallable {
  tool: string;
  args: Record<string, unknown>;
  rationale: string;
}

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
  buildSlice?: {
    repoId: RepoId;
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

export type DeltaSymbolChangeWithTiers = DeltaSymbolChange & {
  tiers?: StalenessTiers;
};

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

  clusters?: {
    totalClusters: number;
    averageClusterSize: number;
    largestClusters: Array<{ clusterId: string; label: string; size: number }>;
  };

  /** True when cluster/process data was deferred (stats level, cold cache) */
  clustersAvailable?: boolean;
  /** Hint for how to fetch full cluster/process data */
  clustersHint?: string;

  processes?: {
    totalProcesses: number;
    averageDepth: number;
    entryPoints: number;
    longestProcesses: Array<{
      processId: string;
      label: string;
      depth: number;
    }>;
  };

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

export type ContextSummaryScope = "symbol" | "file" | "task" | "repo";
export type ContextSummaryFormat = "markdown" | "json" | "clipboard";

export interface ContextSummarySymbol {
  symbolId: SymbolId;
  name: string;
  kind: SymbolKind;
  signature?: string;
  summary: string;
  cluster?: SymbolClusterInfo;
  processes?: SymbolProcessInfo[];
}

export interface ContextSummaryDependency {
  fromSymbolId: SymbolId;
  toSymbolIds: SymbolId[];
}

export interface ContextSummaryRiskArea {
  symbolId: SymbolId;
  name: string;
  reasons: string[];
}

export interface ContextSummaryFileTouch {
  file: string;
  symbolCount: number;
}

export interface ContextSummaryMetadata {
  query: string;
  summaryTokens: number;
  budget: number;
  truncated: boolean;
  indexVersion: VersionId | string;
  /** Warning when budget is too small for the requested scope. */
  budgetWarning?: string;
}

export interface ContextSummary {
  repoId: RepoId;
  query: string;
  scope: ContextSummaryScope;
  keySymbols: ContextSummarySymbol[];
  dependencyGraph: ContextSummaryDependency[];
  riskAreas: ContextSummaryRiskArea[];
  filesTouched: ContextSummaryFileTouch[];
  metadata: ContextSummaryMetadata;
  /** Cluster IDs surfaced by entity retrieval for this query (optional). */
  relatedClusterIds?: string[];
  /** Process IDs surfaced by entity retrieval for this query (optional). */
  relatedProcessIds?: string[];
  /** File IDs surfaced by entity retrieval for this query (optional). */
  relatedFileIds?: string[];
}

export interface HealthComponents {
  freshness: number;
  coverage: number;
  errorRate: number;
  edgeQuality: number;
  callResolution?: number;
}

export interface WatcherHealth {
  enabled: boolean;
  running: boolean;
  filesWatched: number;
  eventsReceived: number;
  eventsProcessed: number;
  errors: number;
  queueDepth: number;
  restartCount: number;
  stale: boolean;
  lastEventAt: string | null;
  lastSuccessfulReindexAt: string | null;
}

// ============================================================================
// Agent Memory Types
// ============================================================================

export type MemoryType =
  | "decision"
  | "bugfix"
  | "task_context"
  | "pattern"
  | "convention"
  | "architecture"
  | "performance"
  | "security";

export interface SurfacedMemory {
  memoryId: string;
  type: MemoryType;
  title: string;
  content: string;
  confidence: number;
  stale: boolean;
  linkedSymbols: string[];
  tags: string[];
}
