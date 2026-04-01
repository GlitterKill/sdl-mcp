import { z } from "zod";
import { RUNTIME_NAMES } from "../runtime/runtimes.js";
import {
  SYMBOL_SEARCH_MAX_RESULTS,
  PAGE_SIZE_MAX,
  DEFAULT_MAX_WINDOW_LINES,
  DEFAULT_MAX_WINDOW_TOKENS,
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  RUNTIME_MIN_TIMEOUT_MS,
  RUNTIME_MAX_TIMEOUT_MS,
  RUNTIME_MAX_ARG_COUNT,
  RUNTIME_MAX_CODE_LENGTH,
  RUNTIME_MAX_QUERY_TERMS,
  RUNTIME_DEFAULT_MAX_RESPONSE_LINES,
  MAX_REPO_ID_LENGTH,
  MAX_SYMBOL_ID_LENGTH,
} from "../config/constants.js";

const RangeSchema = z.object({
  startLine: z.number().int().min(0),
  startCol: z.number().int().min(0),
  endLine: z.number().int().min(0),
  endCol: z.number().int().min(0),
});

const SymbolSignatureParamSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
});

const SymbolSignatureSchema = z.object({
  name: z.string(),
  params: z.array(SymbolSignatureParamSchema).optional(),
  returns: z.string().optional(),
  generics: z.array(z.string()).optional(),
  overloads: z.array(z.string()).optional(),
});

const SymbolDepsSchema = z.object({
  imports: z.array(z.string()),
  calls: z.array(z.string()),
});

const SliceDepRefSchema = z.object({
  symbolId: z.string(),
  confidence: z.number().min(0).max(1),
});

const SliceSymbolDepsSchema = z.object({
  imports: z.array(SliceDepRefSchema),
  calls: z.array(SliceDepRefSchema),
});

const CallResolutionRefSchema = z.object({
  symbolId: z.string(),
  label: z.string(),
  confidence: z.number().min(0).max(1),
  resolutionReason: z.string().optional(),
  resolverId: z.string().optional(),
  resolutionPhase: z.string().optional(),
});

const CallResolutionSchema = z.object({
  minCallConfidence: z.number().min(0).max(1).optional(),
  calls: z.array(CallResolutionRefSchema),
});

const SymbolMetricsSchema = z.object({
  fanIn: z.number().int().min(0).optional(),
  fanOut: z.number().int().min(0).optional(),
  churn30d: z.number().int().min(0).optional(),
  testRefs: z.array(z.string()).optional(),
  canonicalTest: z
    .object({
      file: z.string(),
      symbolId: z.string().optional(),
      distance: z.number(),
      proximity: z.number(),
    })
    .optional(),
});

const SymbolCardVersionSchema = z.object({
  ledgerVersion: z.string(),
  astFingerprint: z.string(),
});

const SliceSymbolCardVersionSchema = z.object({
  astFingerprint: z.string(),
});

const CardDetailLevelSchema = z.enum([
  "minimal",
  "signature",
  "deps",
  "compact",
  "full",
]);

const _LegacyCardDetailLevelSchema = z.enum(["compact", "full"]);

const SymbolClusterInfoSchema = z.object({
  clusterId: z.string(),
  label: z.string(),
  memberCount: z.number().int().min(0),
});

const ProcessRoleSchema = z.enum(["entry", "intermediate", "exit"]);

const SymbolProcessInfoSchema = z.object({
  processId: z.string(),
  label: z.string(),
  role: ProcessRoleSchema,
  depth: z.number().int().min(0),
});

const SymbolCardSchema = z.object({
  symbolId: z.string(),
  repoId: z.string().min(1),
  file: z.string(),
  range: RangeSchema,
  kind: z.enum([
    "function",
    "class",
    "interface",
    "type",
    "module",
    "method",
    "constructor",
    "variable",
  ]),
  name: z.string(),
  exported: z.boolean(),
  visibility: z
    .enum(["public", "protected", "private", "exported", "internal"])
    .optional(),
  signature: SymbolSignatureSchema.optional(),
  summary: z.string().optional(),
  invariants: z.array(z.string()).optional(),
  sideEffects: z.array(z.string()).optional(),
  cluster: SymbolClusterInfoSchema.optional(),
  processes: z.array(SymbolProcessInfoSchema).optional(),
  callResolution: CallResolutionSchema.optional(),
  deps: SymbolDepsSchema,
  metrics: SymbolMetricsSchema.optional(),
  detailLevel: CardDetailLevelSchema.optional(),
  etag: z.string().optional(),
  version: SymbolCardVersionSchema,
});

const SliceSymbolCardSchema = SymbolCardSchema.omit({
  repoId: true,
  etag: true,
  version: true,
  deps: true,
}).extend({
  deps: SliceSymbolDepsSchema,
  version: SliceSymbolCardVersionSchema,
});

const CompressedEdgeSchema = z.tuple([
  z.number().int().min(0),
  z.number().int().min(0),
  z.enum(["import", "call", "config"]),
  z.number(),
]);

const SliceBudgetSchema = z.object({
  maxCards: z.number().int().min(1).max(500).optional(),
  maxEstimatedTokens: z.number().int().min(1).max(200000).optional(),
});

const RequiredSliceBudgetSchema = z.object({
  maxCards: z.number().int().min(1).max(500),
  maxEstimatedTokens: z.number().int().min(1).max(200000),
});

const FrontierItemSchema = z.object({
  symbolId: z.string(),
  score: z.number(),
  why: z.string(),
});

const SliceCardRefSchema = z.object({
  symbolId: z.string(),
  etag: z.string(),
  detailLevel: CardDetailLevelSchema,
});

const SliceTruncationSchema = z.object({
  truncated: z.boolean(),
  droppedCards: z.number().int().min(0),
  droppedEdges: z.number().int().min(0),
  howToResume: z
    .object({
      type: z.enum(["cursor", "token"]),
      value: z.union([z.string(), z.number()]),
    })
    .nullable(),
});

const MemoryTypeSchema = z.enum(["decision", "bugfix", "task_context", "pattern", "convention", "architecture", "performance", "security"]);

const SurfacedMemorySchema = z.object({
  memoryId: z.string(),
  type: MemoryTypeSchema,
  title: z.string(),
  content: z.string(),
  confidence: z.number(),
  stale: z.boolean(),
  linkedSymbols: z.array(z.string()),
  tags: z.array(z.string()),
});

const SliceBuildWireFormatSchema = z.enum(["standard", "compact", "agent"]);
const SliceBuildWireFormatVersionSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

const GraphSliceSchema = z.object({
  repoId: z.string().min(1),
  versionId: z.string(),
  budget: RequiredSliceBudgetSchema,
  startSymbols: z.array(z.string()),
  symbolIndex: z.array(z.string()),
  cards: z.array(SliceSymbolCardSchema),
  cardRefs: z.array(SliceCardRefSchema).optional(),
  edges: z.array(CompressedEdgeSchema),
  frontier: z.array(FrontierItemSchema).optional(),
  truncation: SliceTruncationSchema.optional(),
  confidenceDistribution: z
    .object({
      high: z.number().int().min(0),
      medium: z.number().int().min(0),
      low: z.number().int().min(0),
      unknown: z.number().int().min(0),
    })
    .optional(),
  staleSymbols: z.array(z.string()).optional(),
  memories: z.array(SurfacedMemorySchema).optional(),
});

const CompactRangeSchema = z.tuple([
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
]);

const CompactSymbolDepsSchema = z.object({
  i: z.array(SliceDepRefSchema),
  c: z.array(SliceDepRefSchema),
});

const CompactSymbolMetricsSchema = z.object({
  fi: z.number().optional(),
  fo: z.number().optional(),
  ch: z.number().optional(),
  t: z.array(z.string()).optional(),
});

const CompactSliceSymbolCardSchema = z.object({
  sid: z.string(),
  f: z.string(),
  r: CompactRangeSchema,
  k: z.enum([
    "function",
    "class",
    "interface",
    "type",
    "module",
    "method",
    "constructor",
    "variable",
  ]),
  n: z.string(),
  x: z.boolean(),
  v: z
    .enum(["public", "protected", "private", "exported", "internal"])
    .optional(),
  sig: SymbolSignatureSchema.optional(),
  sum: z.string().optional(),
  inv: z.array(z.string()).optional(),
  se: z.array(z.string()).optional(),
  d: CompactSymbolDepsSchema,
  cr: z.array(CallResolutionRefSchema).optional(),
  m: CompactSymbolMetricsSchema.optional(),
  dl: CardDetailLevelSchema.optional(),
  af: z.string(),
});

const CompactSliceCardRefSchema = z.object({
  sid: z.string(),
  e: z.string(),
  dl: CardDetailLevelSchema.optional(),
});

const CompactFrontierItemSchema = z.object({
  sid: z.string(),
  s: z.number(),
  w: z.string(),
});

const CompactSliceResumeSchema = z.object({
  t: z.enum(["cursor", "token"]),
  v: z.union([z.string(), z.number()]),
});

const CompactSliceTruncationSchema = z.object({
  tr: z.boolean(),
  dc: z.number().int().min(0),
  de: z.number().int().min(0),
  res: CompactSliceResumeSchema.optional(),
});

const CompactSliceBudgetSchema = z.object({
  mc: z.number().int().min(1).max(500),
  mt: z.number().int().min(1).max(200000),
});

const CompactGraphSliceSchema = z.object({
  wf: z.literal("compact"),
  wv: z.literal(1),
  rid: z.string(),
  vid: z.string(),
  b: CompactSliceBudgetSchema,
  ss: z.array(z.string()),
  si: z.array(z.string()),
  c: z.array(CompactSliceSymbolCardSchema),
  cr: z.array(CompactSliceCardRefSchema).optional(),
  e: z.array(CompressedEdgeSchema),
  f: z.array(CompactFrontierItemSchema).optional(),
  t: CompactSliceTruncationSchema.optional(),
  staleSymbols: z.array(z.string()).optional(),
  memories: z.array(SurfacedMemorySchema).optional(),
});

// ============================================================================
// Compact Wire Format V2 Schemas
// ============================================================================

const SymbolKindEnumSchema = z.enum([
  "function",
  "class",
  "interface",
  "type",
  "module",
  "method",
  "constructor",
  "variable",
]);

const CompactSliceSymbolCardV2Schema = z.object({
  fi: z.number().int().min(0),
  r: CompactRangeSchema,
  k: SymbolKindEnumSchema,
  n: z.string(),
  x: z.boolean(),
  v: z
    .enum(["public", "protected", "private", "exported", "internal"])
    .optional(),
  sig: SymbolSignatureSchema.optional(),
  sum: z.string().optional(),
  inv: z.array(z.string()).optional(),
  se: z.array(z.string()).optional(),
  d: CompactSymbolDepsSchema,
  cr: z.array(CallResolutionRefSchema).optional(),
  m: CompactSymbolMetricsSchema.optional(),
  dl: CardDetailLevelSchema.optional(),
  af: z.string().optional(),
});

const CompactFrontierItemV2Schema = z.object({
  ci: z.number().int().min(0),
  s: z.number(),
  w: z.string(),
});

const CompactSliceCardRefV2Schema = z.object({
  ci: z.number().int().min(0),
  e: z.string(),
  dl: CardDetailLevelSchema.optional(),
});

const CompactEdgeV2Schema = z.tuple([
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
  z.number(),
]);

const CompactGraphSliceV2Schema = z.object({
  wf: z.literal("compact"),
  wv: z.literal(2),
  rid: z.string().optional(),
  vid: z.string(),
  b: CompactSliceBudgetSchema,
  ss: z.array(z.string()),
  si: z.array(z.string()),
  fp: z.array(z.string()),
  et: z.array(z.string()).optional(),
  c: z.array(CompactSliceSymbolCardV2Schema),
  cr: z.array(CompactSliceCardRefV2Schema).optional(),
  e: z.array(CompactEdgeV2Schema),
  f: z.array(CompactFrontierItemV2Schema).optional(),
  t: CompactSliceTruncationSchema.optional(),
  staleSymbols: z.array(z.string()).optional(),
  memories: z.array(SurfacedMemorySchema).optional(),
  _legend: z.record(z.string(), z.string()).optional(),
});

// ============================================================================
// Compact Wire Format V3 Schemas (Grouped Edge Encoding)
// ============================================================================

const CompactGroupedEdgeV3Schema = z.object({
  from: z.number().int().min(0),
  c: z.array(z.number().int().min(0)).optional(),
  i: z.array(z.number().int().min(0)).optional(),
  cf: z.array(z.number().int().min(0)).optional(),
});

const CompactGraphSliceV3Schema = z.object({
  wf: z.literal("compact"),
  wv: z.literal(3),
  vid: z.string(),
  b: CompactSliceBudgetSchema,
  ss: z.array(z.string()),
  si: z.array(z.string()),
  fp: z.array(z.string()),
  et: z.array(z.string()).optional(),
  c: z.array(CompactSliceSymbolCardV2Schema),
  cr: z.array(CompactSliceCardRefV2Schema).optional(),
  e: z.array(CompactGroupedEdgeV3Schema),
  f: z.array(CompactFrontierItemV2Schema).optional(),
  t: CompactSliceTruncationSchema.optional(),
  staleSymbols: z.array(z.string()).optional(),
  memories: z.array(SurfacedMemorySchema).optional(),
});

export {
  CompactGroupedEdgeV3Schema,
  CompactGraphSliceV3Schema,
  CompactGraphSliceV2Schema,
};

const DeltaSymbolChangeSchema = z.discriminatedUnion("changeType", [
  z.object({
    symbolId: z.string(),
    changeType: z.literal("added"),
    name: z.string().optional(),
    kind: z.string().optional(),
    file: z.string().optional(),
  }),
  z.object({
    symbolId: z.string(),
    changeType: z.literal("removed"),
    name: z.string().optional(),
    kind: z.string().optional(),
    file: z.string().optional(),
  }),
  z.object({
    symbolId: z.string(),
    changeType: z.literal("modified"),
    name: z.string().optional(),
    kind: z.string().optional(),
    file: z.string().optional(),
    signatureDiff: z
      .object({
        before: z.string().optional(),
        after: z.string().optional(),
      })
      .optional(),
    invariantDiff: z
      .object({
        added: z.array(z.string()),
        removed: z.array(z.string()),
      })
      .optional(),
    sideEffectDiff: z
      .object({
        added: z.array(z.string()),
        removed: z.array(z.string()),
      })
      .optional(),
  }),
]);

const FanInTrendSchema = z.object({
  previous: z.number().int().min(0),
  current: z.number().int().min(0),
  growthRate: z.number(),
  isAmplifier: z.boolean(),
});

const BlastRadiusItemSchema = z.object({
  symbolId: z.string(),
  name: z.string().optional(),
  kind: z.string().optional(),
  file: z.string().optional(),
  reason: z.string().optional(),
  distance: z.number(),
  rank: z.number(),
  signal: z.enum(["diagnostic", "directDependent", "graph", "process"]),
  fanInTrend: FanInTrendSchema.optional(),
});

const DiagnosticsSummarySchema = z.object({
  totalErrors: z.number().int().min(0),
  totalWarnings: z.number().int().min(0),
  totalInfo: z.number().int().min(0),
  topFiles: z.array(
    z.object({
      file: z.string(),
      errorCount: z.number().int().min(0),
    }),
  ),
});

const DiagnosticSuspectSchema = z.object({
  symbolId: z.string(),
  file: z.string(),
  range: z.object({
    startLine: z.number().int().min(0),
    startCol: z.number().int().min(0),
    endLine: z.number().int().min(0),
    endCol: z.number().int().min(0),
  }),
  code: z.union([z.string(), z.number()]),
  messageShort: z.string(),
});

const DeltaPackTruncationSchema = z.object({
  truncated: z.boolean(),
  droppedChanges: z.number().int().min(0),
  droppedBlastRadius: z.number().int().min(0),
  howToResume: z
    .object({
      type: z.enum(["cursor", "token"]),
      value: z.union([z.string(), z.number()]),
    })
    .nullable(),
});

const DroppedSymbolSchema = z.object({
  symbolId: z.string(),
  reason: z.string(),
  priority: z.enum(["must", "should", "optional"]),
});

const TrimmedSetSchema = z.object({
  trimmed: z.boolean(),
  keptSymbols: z.array(z.string()),
  droppedSymbols: z.array(DroppedSymbolSchema),
  spilloverHandle: z.string().nullable(),
});

const DeltaPackSchema = z.object({
  repoId: z.string().min(1),
  fromVersion: z.string(),
  toVersion: z.string(),
  changedSymbols: z.array(DeltaSymbolChangeSchema),
  blastRadius: z.array(BlastRadiusItemSchema),
  diagnosticsSummary: DiagnosticsSummarySchema.optional(),
  diagnosticSuspects: z.array(DiagnosticSuspectSchema).optional(),
  truncation: DeltaPackTruncationSchema.optional(),
  trimmedSet: TrimmedSetSchema.optional(),
  spilloverHandle: z.string().optional(),
});

const CodeWindowRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  symbolId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH),
  reason: z.string().max(10000),
  expectedLines: z.number().int().min(1),
  identifiersToFind: z.array(z.string()).max(50),
  granularity: z.enum(["symbol", "block", "fileWindow"]).optional(),
  maxTokens: z.number().int().min(1).optional(),
  sliceContext: z
    .object({
      taskText: z.string().min(1).max(2000),
      stackTrace: z.string().max(10000).optional(),
      failingTestPath: z.string().max(500).optional(),
      editedFiles: z.array(z.string()).max(100).optional(),
      entrySymbols: z.array(z.string()).max(100).optional(),
      budget: SliceBudgetSchema.optional(),
    })
    .optional(),
});

export const RepoRegisterRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  rootPath: z.string().min(1),
  ignore: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  maxFileBytes: z.number().int().min(1).optional(),
});

export const RepoRegisterResponseSchema = z.object({
  ok: z.boolean(),
  repoId: z.string().min(1),
});

export const RepoStatusRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  surfaceMemories: z.boolean().optional().default(false),
  /** "minimal" returns only core counts (fastest). "standard" includes health/watcher/prefetch. "full" adds live-index. */
  detail: z.enum(["minimal", "standard", "full"]).optional().default("standard"),
});

export const RepoStatusResponseSchema = z.object({
  repoId: z.string().min(1),
  rootPath: z.string(),
  latestVersionId: z.string().nullable(),
  filesIndexed: z.number().int(),
  symbolsIndexed: z.number().int(),
  lastIndexedAt: z.string().nullable(),
  healthScore: z.number().int().min(0).max(100).optional(),
  healthComponents: z.object({
    freshness: z.number().min(0).max(1),
    coverage: z.number().min(0).max(1),
    errorRate: z.number().min(0).max(1),
    edgeQuality: z.number().min(0).max(1),
    callResolution: z.number().min(0).max(1).optional(),
  }),
  healthAvailable: z.boolean().optional(),
  /**
   * Watcher health states:
   * - null: server never started watchers for this repo
   * - { enabled: false }: explicitly disabled in config
   * - { enabled: true, running: true }: active and healthy
   * - { enabled: true, running: false, stale: true }: started but unhealthy
   */
  watcherHealth: z
    .object({
      enabled: z.boolean(),
      running: z.boolean(),
      filesWatched: z.number().int().min(0),
      eventsReceived: z.number().int().min(0),
      eventsProcessed: z.number().int().min(0),
      errors: z.number().int().min(0),
      queueDepth: z.number().int().min(0),
      restartCount: z.number().int().min(0),
      stale: z.boolean(),
      lastEventAt: z.string().nullable(),
      lastSuccessfulReindexAt: z.string().nullable(),
    })
    .nullable(),
  watcherNote: z.string().optional(),
  prefetchStats: z
    .object({
    enabled: z.boolean(),
    queueDepth: z.number().int().min(0),
    running: z.boolean(),
    completed: z.number().int().min(0),
    cancelled: z.number().int().min(0),
    cacheHits: z.number().int().min(0),
    cacheMisses: z.number().int().min(0),
    wastedPrefetch: z.number().int().min(0),
    hitRate: z.number().min(0).max(1),
    wasteRate: z.number().min(0),
    avgLatencyReductionMs: z.number().min(0),
    lastRunAt: z.string().nullable(),
    modelEnabled: z.boolean(),
    strategyMetrics: z.array(
      z.object({
        strategy: z.string(),
        hitRate: z.number().min(0),
        wasteRate: z.number().min(0),
        avgLatencyReductionMs: z.number().min(0),
        samples: z.number().int().min(0),
        cacheHits: z.number().int().min(0),
        cacheMisses: z.number().int().min(0),
        wastedPrefetch: z.number().int().min(0),
      }),
    ),
    deterministicFallback: z.boolean(),
  }).optional(),
  liveIndexStatus: z
    .object({
      enabled: z.boolean(),
      pendingBuffers: z.number().int().min(0),
      dirtyBuffers: z.number().int().min(0),
      parseQueueDepth: z.number().int().min(0),
      checkpointPending: z.boolean(),
      lastBufferEventAt: z.string().nullable(),
      lastCheckpointAt: z.string().nullable(),
      lastCheckpointAttemptAt: z.string().nullable().optional(),
      lastCheckpointResult: z
        .enum(["success", "partial", "failed"])
        .nullable()
        .optional(),
      lastCheckpointError: z.string().nullable().optional(),
      lastCheckpointReason: z.string().nullable().optional(),
      reconcileQueueDepth: z.number().int().min(0).optional(),
      oldestReconcileAt: z.string().nullable().optional(),
      lastReconciledAt: z.string().nullable().optional(),
      reconcileInflight: z.boolean().optional(),
      reconcileLastError: z.string().nullable().optional(),
    })
    .optional(),
  memories: z.array(SurfacedMemorySchema).optional(),
});

export const IndexRefreshRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  mode: z.enum(["full", "incremental"]),
  reason: z.string().optional(),
  async: z.boolean().optional().describe("If true, return immediately with operationId and run indexing in background"),
});

export const IndexRefreshResponseSchema = z.object({
  ok: z.boolean(),
  repoId: z.string().min(1),
  versionId: z.string().optional(),
  changedFiles: z.number().int().optional(),
  async: z.boolean().optional(),
  operationId: z.string().optional(),
  message: z.string().optional(),
});

const BufferSelectionSchema = z.object({
  startLine: z.number().int().min(0),
  startCol: z.number().int().min(0),
  endLine: z.number().int().min(0),
  endCol: z.number().int().min(0),
});

const BufferCursorSchema = z.object({
  line: z.number().int().min(0),
  col: z.number().int().min(0),
});

export const BufferPushRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  eventType: z.enum(["open", "change", "save", "close", "checkpoint"]),
  filePath: z
    .string()
    .min(1)
    .refine((p) => !p.includes(".."), {
      message: "filePath must not contain path traversal sequences",
    })
    .refine((p) => !/^[/\\]/.test(p) && !/^[a-zA-Z]:/.test(p), {
      message: "filePath must be relative (absolute paths are not allowed)",
    })
    .refine((p) => !p.includes("\0"), {
      message: "filePath must not contain null bytes",
    }),
  content: z.string().max(5_242_880),
  language: z.string().optional(),
  version: z.number().int().min(0),
  dirty: z.boolean(),
  timestamp: z.string(),
  cursor: BufferCursorSchema.optional(),
  selections: z.array(BufferSelectionSchema).optional(),
});

export const BufferPushResponseSchema = z.object({
  accepted: z.boolean(),
  repoId: z.string().min(1),
  overlayVersion: z.number().int().min(0),
  parseScheduled: z.boolean(),
  checkpointScheduled: z.boolean(),
  warnings: z.array(z.string()),
});

export const BufferCheckpointRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  reason: z.string().optional(),
});

export const BufferCheckpointResponseSchema = z.object({
  repoId: z.string().min(1),
  requested: z.boolean(),
  checkpointId: z.string(),
  pendingBuffers: z.number().int().min(0),
  checkpointedFiles: z.number().int().min(0),
  failedFiles: z.number().int().min(0),
  lastCheckpointAt: z.string().nullable(),
});

export const BufferStatusRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
});

export const BufferStatusResponseSchema = z.object({
  repoId: z.string().min(1),
  enabled: z.boolean(),
  pendingBuffers: z.number().int().min(0),
  dirtyBuffers: z.number().int().min(0),
  parseQueueDepth: z.number().int().min(0),
  checkpointPending: z.boolean(),
  lastBufferEventAt: z.string().nullable(),
  lastCheckpointAt: z.string().nullable(),
  lastCheckpointAttemptAt: z.string().nullable().optional(),
  lastCheckpointResult: z
    .enum(["success", "partial", "failed"])
    .nullable()
    .optional(),
  lastCheckpointError: z.string().nullable().optional(),
  lastCheckpointReason: z.string().nullable().optional(),
  reconcileQueueDepth: z.number().int().min(0).optional(),
  oldestReconcileAt: z.string().nullable().optional(),
  lastReconciledAt: z.string().nullable().optional(),
  reconcileInflight: z.boolean().optional(),
  reconcileLastError: z.string().nullable().optional(),
});

const SymbolSearchResultSchema = z.object({
  symbolId: z.string(),
  name: z.string(),
  file: z.string(),
  kind: z.enum([
    "function",
    "class",
    "interface",
    "type",
    "module",
    "method",
    "constructor",
    "variable",
  ]),
  relevance: z.number().min(0).max(1).optional(),
});

export const SymbolSearchRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  query: z.string().min(1).max(1000),
  kinds: z.array(SymbolKindEnumSchema).optional(),
  limit: z.number().int().min(1).max(SYMBOL_SEARCH_MAX_RESULTS).optional(),
  semantic: z.boolean().optional(),
  /** When true, include per-result retrieval evidence (FTS score, vector score, fusion rank). */
  includeRetrievalEvidence: z.boolean().optional(),
});

export const RetrievalEvidenceItemSchema = z.object({
  symbolId: z.string(),
  ftsScore: z.number().optional(),
  vectorScore: z.number().optional(),
  fusionRank: z.number().int().optional(),
  retrievalSource: z.enum(["fts", "vector", "hybrid", "legacy"]).optional(),
});

export type RetrievalEvidenceItem = z.infer<typeof RetrievalEvidenceItemSchema>;

export const SymbolSearchResponseSchema = z.object({
  repoId: z.string().optional(),
  results: z.array(SymbolSearchResultSchema),
  /** @deprecated Use results instead. Removed to reduce response size. */
  symbols: z.array(SymbolSearchResultSchema).optional(),
  truncation: z
    .object({
      truncated: z.boolean(),
      droppedCount: z.number().int().min(0),
      howToResume: z
        .object({
          type: z.enum(["cursor", "token"]),
          value: z.union([z.string(), z.number()]),
        })
        .nullable(),
    })
    .optional(),
  /** Per-result retrieval evidence. Only populated when includeRetrievalEvidence is true. */
  retrievalEvidence: z.array(RetrievalEvidenceItemSchema).optional(),
  /** Whether any result had a high-confidence exact match (relevance >= 0.85). */
  exactMatchFound: z.boolean().optional(),
  /** Suggestion text when results are weak or empty. */
  suggestion: z.string().optional(),
});

const NotModifiedResponseSchema = z.object({
  notModified: z.literal(true),
  etag: z.string(),
  ledgerVersion: z.string(),
});

export const SymbolRefSchema = z.object({
  name: z.string().min(1),
  file: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  exportedOnly: z.boolean().optional(),
});

export const SymbolGetCardRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  symbolId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH).optional(),
  symbolRef: SymbolRefSchema.optional(),
  ifNoneMatch: z.string().optional(),
  minCallConfidence: z.number().min(0).max(1).optional(),
  includeResolutionMetadata: z.boolean().optional(),
}).superRefine((value, ctx) => {
  const provided = Number(value.symbolId !== undefined) + Number(value.symbolRef !== undefined);
  if (provided !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of symbolId or symbolRef.",
      path: ["symbolId"],
    });
  }
});

export const SymbolGetCardsRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH).describe("Repository ID"),
  symbolIds: z
    .array(z.string())
    .min(1)
    .max(100)
    .describe("Array of symbol IDs to fetch (max 100)")
    .optional(),
  symbolRefs: z.array(SymbolRefSchema).min(1).max(100).optional(),
  minCallConfidence: z.number().min(0).max(1).optional(),
  includeResolutionMetadata: z.boolean().optional(),
  knownEtags: z
    .record(z.string(), z.string())
    .refine(obj => Object.keys(obj).length <= 1000, { message: "knownEtags exceeds maximum of 1000 entries" })
    .optional()
    .describe(
      "Map of symbolId → known ETag. Matching symbols return notModified instead of full card.",
    ),
}).superRefine((value, ctx) => {
  const provided =
    Number(value.symbolIds !== undefined) + Number(value.symbolRefs !== undefined);
  if (provided !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of symbolIds or symbolRefs.",
      path: ["symbolIds"],
    });
  }
});

const CardWithETagSchema = SymbolCardSchema.extend({
  etag: z.string(),
});

export const SymbolGetCardResponseSchema = z.union([
  z.object({
    card: CardWithETagSchema,
    truncation: z
      .object({
        truncated: z.boolean(),
        droppedCount: z.number().int().min(0),
        howToResume: z
          .object({
            type: z.enum(["cursor", "token"]),
            value: z.union([z.string(), z.number()]),
          })
          .nullable(),
      })
      .optional(),
  }),
  NotModifiedResponseSchema,
]);

export const SliceBuildRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  taskText: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      "Natural language task description. Can be used alone (without entrySymbols) " +
        "to auto-discover relevant symbols via full-text search and build the slice " +
        "in a single round trip.",
    ),
  stackTrace: z.string().max(10000).optional(),
  failingTestPath: z.string().max(500).optional(),
  editedFiles: z.array(z.string()).max(100).optional(),
  entrySymbols: z.array(z.string()).max(100).optional(),
  knownCardEtags: z.record(z.string(), z.string())
    .refine(obj => Object.keys(obj).length <= 1000, { message: "knownCardEtags exceeds maximum of 1000 entries" })
    .optional(),
  cardDetail: CardDetailLevelSchema.optional(),
  adaptiveDetail: z.boolean().optional(),
  wireFormat: SliceBuildWireFormatSchema.optional(),
  wireFormatVersion: SliceBuildWireFormatVersionSchema.optional(),
  budget: SliceBudgetSchema.optional(),
  minConfidence: z.number().min(0).max(1).default(0.5),
  minCallConfidence: z.number().min(0).max(1).optional(),
  includeResolutionMetadata: z.boolean().optional(),
  includeMemories: z.boolean().optional(),
  memoryLimit: z.number().int().min(0).max(20).optional(),
  /** When true, include retrieval evidence in the slice response. */
  includeRetrievalEvidence: z.boolean().optional(),
});

const SliceLeaseSchema = z.object({
  expiresAt: z.string(),
  minVersion: z.string().nullable(),
  maxVersion: z.string().nullable(),
});

const SliceEtagSchema = z.object({
  handle: z.string(),
  version: z.string(),
  sliceHash: z.string(),
});

export const SliceRefreshRequestSchema = z.object({
  sliceHandle: z.string(),
  knownVersion: z.string().optional().describe("Known version. Defaults to the slice handle's maxVersion."),
});

const DeltaPackWithGovernanceSchema = DeltaPackSchema.extend({
  trimmedSet: z
    .object({
      trimmed: z.boolean(),
      keptSymbols: z.array(z.string()),
      droppedSymbols: z.array(
        z.object({
          symbolId: z.string(),
          reason: z.string(),
          priority: z.enum(["must", "should", "optional"]),
        }),
      ),
      spilloverHandle: z.string().nullable(),
    })
    .optional(),
  spilloverHandle: z.string().optional(),
  changedSymbols: z.array(
    z.discriminatedUnion("changeType", [
      z.object({
        symbolId: z.string(),
        changeType: z.literal("added"),
        tiers: z
          .object({
            interfaceStable: z.boolean(),
            behaviorStable: z.boolean(),
            sideEffectsStable: z.boolean(),
            riskScore: z.number(),
          })
          .optional(),
      }),
      z.object({
        symbolId: z.string(),
        changeType: z.literal("removed"),
        tiers: z
          .object({
            interfaceStable: z.boolean(),
            behaviorStable: z.boolean(),
            sideEffectsStable: z.boolean(),
            riskScore: z.number(),
          })
          .optional(),
      }),
      z.object({
        symbolId: z.string(),
        changeType: z.literal("modified"),
        signatureDiff: z
          .object({
            before: z.string().optional(),
            after: z.string().optional(),
          })
          .optional(),
        invariantDiff: z
          .object({
            added: z.array(z.string()),
            removed: z.array(z.string()),
          })
          .optional(),
        sideEffectDiff: z
          .object({
            added: z.array(z.string()),
            removed: z.array(z.string()),
          })
          .optional(),
        tiers: z
          .object({
            interfaceStable: z.boolean(),
            behaviorStable: z.boolean(),
            sideEffectsStable: z.boolean(),
            riskScore: z.number(),
          })
          .optional(),
      }),
    ]),
  ),
});

export const SliceRefreshResponseSchema = z.object({
  sliceHandle: z.string(),
  knownVersion: z.string(),
  currentVersion: z.string(),
  notModified: z.boolean().optional(),
  delta: DeltaPackWithGovernanceSchema.nullable(),
  lease: SliceLeaseSchema.optional(),
});

const SliceErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    type: z.string(),
    repoId: z.string().optional(),
  }),
});

export const SliceBuildResponseSchema = z.union([
  z.object({
    sliceHandle: z.string(),
    ledgerVersion: z.string(),
    lease: SliceLeaseSchema,
    sliceEtag: SliceEtagSchema.optional(),
    slice: z.union([
      GraphSliceSchema,
      CompactGraphSliceSchema,
      CompactGraphSliceV2Schema,
      CompactGraphSliceV3Schema,
      z.object({
        wireFormat: z.literal("agent"),
        version: z.string(),
        budget: z.object({ maxCards: z.number(), maxTokens: z.number() }),
        seedSymbols: z.array(z.string()),
        cards: z.array(z.unknown()),
        edges: z.array(z.unknown()),
      }),
    ]),
    /** Per-symbol retrieval evidence. Only populated when includeRetrievalEvidence is true. */
    retrievalEvidence: z.array(RetrievalEvidenceItemSchema).optional(),
    /** Symptom type classification. Only populated when includeRetrievalEvidence is true. */
    symptomType: z.enum(["stackTrace", "failingTest", "taskText", "editedFiles"]).optional(),
  }),
  NotModifiedResponseSchema,
  SliceErrorResponseSchema,
]);

export const DeltaGetRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  fromVersion: z.string().optional().describe("Start version. Defaults to previous version."),
  toVersion: z.string().optional().describe("End version. Defaults to latest version."),
  budget: SliceBudgetSchema.optional(),
});

const AmplifierSummaryItemSchema = z.object({
  symbolId: z.string(),
  growthRate: z.number(),
  previous: z.number().int().min(0),
  current: z.number().int().min(0),
});

export const DeltaGetResponseSchema = z.object({
  delta: DeltaPackSchema,
  amplifiers: z.array(AmplifierSummaryItemSchema),
  blastRadiusTruncated: z.boolean().optional(),
});

export const SliceSpilloverGetRequestSchema = z.object({
  spilloverHandle: z.string(),
  cursor: z.string().optional(),
  pageSize: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
});

export const SliceSpilloverGetResponseSchema = z.object({
  spilloverHandle: z.string(),
  cursor: z.string().optional(),
  hasMore: z.boolean(),
  symbols: z.array(SymbolCardSchema),
});

export const CodeNeedWindowRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  symbolId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH),
  reason: z.string().min(1).max(10000),
  expectedLines: z.number().int().min(1),
  identifiersToFind: z.array(z.string()).max(50),
  granularity: z.enum(["symbol", "block", "fileWindow"]).optional(),
  maxTokens: z.number().int().min(1).optional(),
  sliceContext: z
    .object({
      taskText: z.string().min(1).max(2000),
      stackTrace: z.string().max(10000).optional(),
      failingTestPath: z.string().max(500).optional(),
      editedFiles: z.array(z.string()).max(100).optional(),
      entrySymbols: z.array(z.string()).max(100).optional(),
      budget: SliceBudgetSchema.optional(),
    })
    .optional(),
});

const CodeWindowResponseApprovedSchema = z.object({
  approved: z.literal(true),
  repoId: z.string().optional(),
  symbolId: z.string(),
  file: z.string(),
  range: RangeSchema,
  code: z.string(),
  whyApproved: z.array(z.string()),
  warnings: z.array(z.string()).optional(),
  estimatedTokens: z.number().int(),
  downgradedFrom: z.enum(["raw-code", "skeleton", "hotpath"]).optional(),
  truncation: z
    .object({
      truncated: z.boolean(),
      droppedCount: z.number().int().min(0),
      howToResume: z
        .object({
          type: z.enum(["cursor", "token"]),
          value: z.union([z.string(), z.number()]),
          parameter: z.string().optional(),
        })
        .nullable(),
    })
    .optional(),
  matchedIdentifiers: z.array(z.string()).optional(),
  matchedLineNumbers: z.array(z.number().int()).optional(),
  downgradeGuidance: z.string().optional(),
});

const CodeWindowResponseDeniedSchema = z.object({
  approved: z.literal(false),
  whyDenied: z.array(z.string()),
  suggestedNextRequest: CodeWindowRequestSchema.partial().optional(),
  nextBestAction: z
    .object({
      tool: z.string(),
      args: z.record(z.string(), z.unknown()),
      rationale: z.string(),
    })
    .optional(),
});

export const CodeNeedWindowResponseSchema = z.discriminatedUnion("approved", [
  CodeWindowResponseApprovedSchema,
  CodeWindowResponseDeniedSchema,
]);

export const GetSkeletonRequestSchema = z
  .object({
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    symbolId: z.string().max(MAX_SYMBOL_ID_LENGTH).optional(),
    file: z
      .string()
      .refine((p) => !p.includes(".."), {
        message: "Path traversal (..) is not allowed",
      })
      .refine((p) => !/^[/\]/.test(p) && !/^[a-zA-Z]:/.test(p), {
        message: "filePath must be relative",
      })
      .refine((p) => !p.includes("\0"), {
        message: "filePath must not contain null bytes",
      })
      .optional(),
    exportedOnly: z.boolean().optional(),
    maxLines: z.number().int().min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    identifiersToFind: z.array(z.string()).max(50).optional(),
    skeletonOffset: z.number().int().min(0).optional(),
  })
  .refine((data) => data.symbolId !== undefined || data.file !== undefined, {
    message: "Either symbolId or file must be provided",
  });

export const GetSkeletonResponseSchema = z.object({
  skeleton: z.string(),
  file: z.string(),
  range: RangeSchema,
  estimatedTokens: z.number().int(),
  originalLines: z.number().int(),
  truncated: z.boolean(),
  truncation: z
    .object({
      truncated: z.boolean(),
      droppedCount: z.number().int().min(0),
      howToResume: z
        .object({
          type: z.enum(["cursor", "token"]),
          value: z.union([z.string(), z.number()]),
          parameter: z.string().optional(),
        })
        .nullable(),
    })
    .optional(),
});

export const GetHotPathRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  symbolId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH),
  identifiersToFind: z.array(z.string()).min(1).max(50),
  maxLines: z.number().int().min(1).optional(),
  maxTokens: z.number().int().min(1).optional(),
  contextLines: z.number().int().min(0).optional(),
});

export const GetHotPathResponseSchema = z.object({
  excerpt: z.string(),
  file: z.string(),
  range: RangeSchema,
  estimatedTokens: z.number().int(),
  matchedIdentifiers: z.array(z.string()),
  matchedLineNumbers: z.array(z.number().int()),
  missedIdentifiers: z.array(z.string()).optional(),
  truncated: z.boolean(),
});

const PolicyConfigSchema = z.object({
  maxWindowLines: z.number().int().min(1).default(DEFAULT_MAX_WINDOW_LINES),
  maxWindowTokens: z.number().int().min(1).default(DEFAULT_MAX_WINDOW_TOKENS),
  requireIdentifiers: z.boolean().default(true),
  allowBreakGlass: z.boolean().default(false),
  defaultMinCallConfidence: z.number().min(0).max(1).optional(),
  defaultDenyRaw: z.boolean().default(true),
  budgetCaps: z.object({
    maxCards: z.number().int().min(1).default(DEFAULT_MAX_CARDS),
    maxEstimatedTokens: z.number().int().min(100).default(DEFAULT_MAX_TOKENS_SLICE),
  }).optional(),
});

export const PolicyGetRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
});

export const PolicyGetResponseSchema = z.object({
  policy: PolicyConfigSchema,
});

export const PolicySetRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  policyPatch: PolicyConfigSchema.partial(),
});

export const PolicySetResponseSchema = z.object({
  ok: z.boolean(),
  repoId: z.string().min(1),
});

// ============================================================================
// Repository Overview Schemas
// ============================================================================

const SymbolCountsByKindSchema = z.object({
  function: z.number().int().min(0),
  class: z.number().int().min(0),
  interface: z.number().int().min(0),
  type: z.number().int().min(0),
  method: z.number().int().min(0),
  variable: z.number().int().min(0),
  module: z.number().int().min(0),
  constructor: z.number().int().min(0),
});

const CompactSymbolRefSchema = z.object({
  symbolId: z.string(),
  name: z.string(),
  kind: z.enum([
    "function",
    "class",
    "interface",
    "type",
    "module",
    "method",
    "constructor",
    "variable",
  ]),
  exported: z.boolean(),
  signature: z.string().optional(),
});

const DirectorySummarySchema = z.object({
  path: z.string(),
  fileCount: z.number().int().min(0),
  symbolCount: z.number().int().min(0),
  exportedCount: z.number().int().min(0),
  byKind: SymbolCountsByKindSchema,
  exports: z.array(z.string()),
  topByFanIn: z.array(CompactSymbolRefSchema),
  topByChurn: z.array(CompactSymbolRefSchema),
  subdirectories: z.array(z.string()).optional(),
  estimatedFullTokens: z.number().int().min(0),
  summaryTokens: z.number().int().min(0),
});

const CodebaseHotspotsSchema = z.object({
  mostDepended: z.array(CompactSymbolRefSchema),
  mostChanged: z.array(CompactSymbolRefSchema),
  largestFiles: z.array(
    z.object({
      file: z.string(),
      symbolCount: z.number().int().min(0),
    }),
  ),
  mostConnected: z.array(
    z.object({
      file: z.string(),
      edgeCount: z.number().int().min(0),
    }),
  ),
});

const RepoStatsSchema = z.object({
  fileCount: z.number().int().min(0),
  symbolCount: z.number().int().min(0),
  edgeCount: z.number().int().min(0),
  exportedSymbolCount: z.number().int().min(0),
  byKind: SymbolCountsByKindSchema,
  byEdgeType: z.object({
    call: z.number().int().min(0),
    import: z.number().int().min(0),
    config: z.number().int().min(0),
  }),
  avgSymbolsPerFile: z.number().min(0),
  avgEdgesPerSymbol: z.number().min(0),
});

const TokenMetricsSchema = z.object({
  fullCardsEstimate: z.number().int().min(0),
  overviewTokens: z.number().int().min(0),
  compressionRatio: z.number().min(0),
});

export const RepoOverviewRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  level: z.enum(["stats", "directories", "full"]),
  includeHotspots: z.boolean().optional(),
  directories: z.array(z.string()).optional(),
  maxDirectories: z.number().int().min(1).max(200).optional(),
  maxExportsPerDirectory: z.number().int().min(1).max(50).optional(),
});

export const RepoOverviewResponseSchema = z.object({
  repoId: z.string().min(1),
  versionId: z.string(),
  generatedAt: z.string(),
  stats: RepoStatsSchema,
  directories: z.array(DirectorySummarySchema),
  hotspots: CodebaseHotspotsSchema.optional(),
  layers: z.array(z.string()).optional(),
  entryPoints: z.array(z.string()).optional(),
  clusters: z
    .object({
      totalClusters: z.number().int().min(0),
      averageClusterSize: z.number(),
      largestClusters: z.array(
        z.object({
          clusterId: z.string(),
          label: z.string(),
          size: z.number().int().min(0),
        }),
      ),
    })
    .optional(),
  processes: z
    .object({
      totalProcesses: z.number().int().min(0),
      averageDepth: z.number(),
      entryPoints: z.number().int().min(0),
      longestProcesses: z.array(
        z.object({
          processId: z.string(),
          label: z.string(),
          depth: z.number().int().min(0),
        }),
      ),
    })
    .optional(),
  tokenMetrics: TokenMetricsSchema,
});

// ============================================================================
// Context Summary Schemas
// ============================================================================

const ContextSummaryScopeSchema = z.enum(["symbol", "file", "task", "repo"]);
const ContextSummaryFormatSchema = z.enum(["markdown", "json", "clipboard"]);

const ContextSummarySymbolSchema = z.object({
  symbolId: z.string(),
  name: z.string(),
  kind: z.enum([
    "function",
    "class",
    "interface",
    "type",
    "module",
    "method",
    "constructor",
    "variable",
  ]),
  signature: z.string().optional(),
  summary: z.string(),
  cluster: z
    .object({
      clusterId: z.string(),
      label: z.string(),
      memberCount: z.number().int().min(0),
    })
    .optional(),
  processes: z
    .array(
      z.object({
        processId: z.string(),
        label: z.string(),
        role: z.enum(["entry", "intermediate", "exit"]),
        depth: z.number().int().min(0),
      }),
    )
    .optional(),
});

const ContextSummaryDependencySchema = z.object({
  fromSymbolId: z.string(),
  toSymbolIds: z.array(z.string()),
});

const ContextSummaryRiskAreaSchema = z.object({
  symbolId: z.string(),
  name: z.string(),
  reasons: z.array(z.string()),
});

const ContextSummaryFileTouchSchema = z.object({
  file: z.string(),
  symbolCount: z.number().int().min(0),
});

const ContextSummaryMetadataSchema = z.object({
  query: z.string(),
  summaryTokens: z.number().int().min(0),
  budget: z.number().int().min(1),
  truncated: z.boolean(),
  indexVersion: z.string(),
});

const ContextSummarySchema = z.object({
  repoId: z.string().min(1),
  query: z.string(),
  scope: ContextSummaryScopeSchema,
  keySymbols: z.array(ContextSummarySymbolSchema),
  dependencyGraph: z.array(ContextSummaryDependencySchema),
  riskAreas: z.array(ContextSummaryRiskAreaSchema),
  filesTouched: z.array(ContextSummaryFileTouchSchema),
  metadata: ContextSummaryMetadataSchema,
});

export const ContextSummaryRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  query: z.string().min(1).max(1000),
  budget: z.number().int().min(1).optional(),
  format: ContextSummaryFormatSchema.optional(),
  scope: ContextSummaryScopeSchema.optional(),
});

export const ContextSummaryResponseSchema = z.object({
  repoId: z.string().min(1),
  format: ContextSummaryFormatSchema,
  summary: ContextSummarySchema,
  content: z.string(),
});

export type RepoRegisterRequest = z.infer<typeof RepoRegisterRequestSchema>;
export type RepoRegisterResponse = z.infer<typeof RepoRegisterResponseSchema>;
export type RepoStatusRequest = z.infer<typeof RepoStatusRequestSchema>;
export type RepoStatusResponse = z.infer<typeof RepoStatusResponseSchema>;
export type IndexRefreshRequest = z.infer<typeof IndexRefreshRequestSchema>;
export type IndexRefreshResponse = z.infer<typeof IndexRefreshResponseSchema>;
export type BufferPushRequest = z.infer<typeof BufferPushRequestSchema>;
export type BufferPushResponse = z.infer<typeof BufferPushResponseSchema>;
export type BufferCheckpointRequest = z.infer<
  typeof BufferCheckpointRequestSchema
>;
export type BufferCheckpointResponse = z.infer<
  typeof BufferCheckpointResponseSchema
>;
export type BufferStatusRequest = z.infer<typeof BufferStatusRequestSchema>;
export type BufferStatusResponse = z.infer<typeof BufferStatusResponseSchema>;
export type SymbolSearchRequest = z.infer<typeof SymbolSearchRequestSchema>;
export type SymbolSearchResponse = z.infer<typeof SymbolSearchResponseSchema>;
export type SymbolRef = z.infer<typeof SymbolRefSchema>;
export type SymbolGetCardRequest = z.infer<typeof SymbolGetCardRequestSchema>;
export type SymbolGetCardResponse = z.infer<typeof SymbolGetCardResponseSchema>;
export type SymbolGetCardsRequest = z.infer<typeof SymbolGetCardsRequestSchema>;
export const SymbolGetCardsResponseSchema = z.object({
  cards: z.array(z.union([CardWithETagSchema, NotModifiedResponseSchema])),
  partial: z.boolean().optional(),
  succeeded: z.array(z.string()).optional(),
  failed: z.array(z.string()).optional(),
  failures: z.array(z.object({
    input: z.string(),
    message: z.string(),
    code: z.string().optional(),
    classification: z.string().optional(),
    retryable: z.boolean().optional(),
    fallbackTools: z.array(z.string()).optional(),
    fallbackRationale: z.string().optional(),
    candidates: z.array(z.record(z.string(), z.unknown())).optional(),
  })).optional(),
});
export type SymbolGetCardsResponse = z.infer<typeof SymbolGetCardsResponseSchema>;
export type SliceBuildRequest = z.infer<typeof SliceBuildRequestSchema>;
export type SliceBuildResponse = z.infer<typeof SliceBuildResponseSchema>;
export type SliceBuildWireFormat = z.infer<typeof SliceBuildWireFormatSchema>;
export type CardDetailLevelSchemaType = z.infer<typeof CardDetailLevelSchema>;
export type LegacyCardDetailLevelSchemaType = z.infer<
  typeof _LegacyCardDetailLevelSchema
>;
export type CompactGraphSlice = z.infer<typeof CompactGraphSliceSchema>;
export type CompactGraphSliceV2 = z.infer<typeof CompactGraphSliceV2Schema>;
export type CompactGroupedEdgeV3 = z.infer<typeof CompactGroupedEdgeV3Schema>;
export type CompactGraphSliceV3 = z.infer<typeof CompactGraphSliceV3Schema>;
export type SliceLease = z.infer<typeof SliceLeaseSchema>;
export type SliceEtag = z.infer<typeof SliceEtagSchema>;
export type NotModifiedResponse = z.infer<typeof NotModifiedResponseSchema>;
export type SliceRefreshRequest = z.infer<typeof SliceRefreshRequestSchema>;
export type SliceRefreshResponse = z.infer<typeof SliceRefreshResponseSchema>;
export type DeltaGetRequest = z.infer<typeof DeltaGetRequestSchema>;
export type DeltaGetResponse = z.infer<typeof DeltaGetResponseSchema>;
export type SliceSpilloverGetRequest = z.infer<
  typeof SliceSpilloverGetRequestSchema
>;
export type SliceSpilloverGetResponse = z.infer<
  typeof SliceSpilloverGetResponseSchema
>;
export type CodeNeedWindowRequest = z.infer<typeof CodeNeedWindowRequestSchema>;
export type CodeNeedWindowResponse = z.infer<
  typeof CodeNeedWindowResponseSchema
>;
export type PolicyGetRequest = z.infer<typeof PolicyGetRequestSchema>;
export type PolicyGetResponse = z.infer<typeof PolicyGetResponseSchema>;
export type PolicySetRequest = z.infer<typeof PolicySetRequestSchema>;
export type PolicySetResponse = z.infer<typeof PolicySetResponseSchema>;
export type GetSkeletonRequest = z.infer<typeof GetSkeletonRequestSchema>;
export type GetSkeletonResponse = z.infer<typeof GetSkeletonResponseSchema>;
export type GetHotPathRequest = z.infer<typeof GetHotPathRequestSchema>;
export type GetHotPathResponse = z.infer<typeof GetHotPathResponseSchema>;
export type RepoOverviewRequest = z.infer<typeof RepoOverviewRequestSchema>;
export type RepoOverviewResponse = z.infer<typeof RepoOverviewResponseSchema>;
export type ContextSummaryRequest = z.infer<typeof ContextSummaryRequestSchema>;
export type ContextSummaryResponse = z.infer<
  typeof ContextSummaryResponseSchema
>;

const FindingSchema = z.object({
  type: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  message: z.string(),
  affectedSymbols: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const EvidenceSchema = z.object({
  type: z.string(),
  description: z.string(),
  symbolId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const RecommendedTestSchema = z.object({
  type: z.string(),
  description: z.string(),
  targetSymbols: z.array(z.string()),
  priority: z.enum(["high", "medium", "low"]),
});

const PRRiskAnalysisSchema = z.object({
  repoId: z.string().min(1),
  fromVersion: z.string(),
  toVersion: z.string(),
  riskScore: z.number().int().min(0).max(100),
  riskLevel: z.enum(["low", "medium", "high"]),
  findings: z.array(FindingSchema),
  impactedSymbols: z.array(z.string()),
  evidence: z.array(EvidenceSchema),
  recommendedTests: z.array(RecommendedTestSchema),
  changedSymbolsCount: z.number().int().min(0),
  blastRadiusCount: z.number().int().min(0),
});

const PolicyDecisionSummarySchema = z.object({
  decision: z.enum([
    "approve",
    "deny",
    "downgrade-to-skeleton",
    "downgrade-to-hotpath",
  ]),
  deniedReasons: z.array(z.string()).optional(),
  auditHash: z.string(),
});

export const PRRiskAnalysisRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  fromVersion: z.string(),
  toVersion: z.string(),
  riskThreshold: z.number().int().min(0).max(100).optional(),
  budget: z.object({
    maxChangedSymbols: z.number().int().min(1).max(200).optional(),
    maxBlastRadius: z.number().int().min(1).max(200).optional(),
  }).optional(),
});

export const PRRiskAnalysisResponseSchema = z.object({
  analysis: PRRiskAnalysisSchema,
  escalationRequired: z.boolean(),
  policyDecision: PolicyDecisionSummarySchema.optional(),
});

export type PRRiskAnalysisRequest = z.infer<typeof PRRiskAnalysisRequestSchema>;
export type PRRiskAnalysisResponse = z.infer<
  typeof PRRiskAnalysisResponseSchema
>;

export const AgentContextRequestSchema = z.object({
  repoId: z
    .string()
    .min(1)
    .max(MAX_REPO_ID_LENGTH)
    .describe("Repository ID to work with"),
  taskType: z
    .enum(["debug", "review", "implement", "explain"])
    .describe("Type of task to perform"),
  taskText: z.string().min(1).max(2000).describe("Task description or prompt"),
  budget: z
    .object({
      maxTokens: z.number().optional().describe("Maximum tokens to consume"),
      maxActions: z
        .number()
        .optional()
        .describe("Maximum number of actions to execute"),
      maxDurationMs: z
        .number()
        .optional()
        .describe("Maximum duration in milliseconds"),
    })
    .optional()
    .describe("Budget constraints for the task"),
  options: z
    .object({
      focusSymbols: z
        .array(z.string())
        .optional()
        .describe("List of symbol IDs to focus on"),
      focusPaths: z
        .array(z.string())
        .optional()
        .describe("List of file paths to focus on"),
      includeTests: z
        .boolean()
        .optional()
        .describe("Whether to include test files"),
      requireDiagnostics: z
        .boolean()
        .optional()
        .describe("Whether to require diagnostic information"),
      contextMode: z
        .enum(["precise", "broad"])
        .optional()
        .describe("Context breadth: precise returns minimal workflow-efficient context, broad returns richer surrounding context. Default: broad"),
    })
    .optional()
    .describe("Task-specific options"),
});

export const AgentContextResponseSchema = z.object({
  taskId: z.string().describe("Unique task identifier"),
  taskType: z
    .enum(["debug", "review", "implement", "explain"])
    .describe("Type of task performed"),
  actionsTaken: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        status: z.enum(["pending", "inProgress", "completed", "failed"]),
        input: z.record(z.string(), z.unknown()),
        output: z.unknown().optional(),
        error: z.string().optional(),
        timestamp: z.number(),
        durationMs: z.number(),
        evidence: z.array(z.unknown()),
      }),
    )
    .describe("Actions taken during execution"),
  path: z
    .object({
      rungs: z.array(z.enum(["card", "skeleton", "hotPath", "raw"])),
      estimatedTokens: z.number(),
      estimatedDurationMs: z.number(),
      reasoning: z.string(),
    })
    .describe("Rung path selected for execution"),
  finalEvidence: z
    .array(
      z.object({
        type: z.string(),
        reference: z.string(),
        summary: z.string(),
        timestamp: z.number(),
      }),
    )
    .describe("Evidence collected during execution"),
  summary: z.string().describe("Summary of execution"),
  success: z.boolean().describe("Whether execution was successful"),
  error: z.string().optional().describe("Error message if execution failed"),
  metrics: z
    .object({
      totalDurationMs: z.number(),
      totalTokens: z.number(),
      totalActions: z.number(),
      successfulActions: z.number(),
      failedActions: z.number(),
      cacheHits: z.number(),
    })
    .describe("Execution metrics"),
  answer: z
    .string()
    .optional()
    .describe("Answer to the task based on collected evidence"),
  nextBestAction: z
    .string()
    .optional()
    .describe(
      "Suggested next action based on execution results and policy decisions",
    ),
  /** Retrieval evidence with symptom classification. */
  retrievalEvidence: z.object({
    symptomType: z.enum(["stackTrace", "failingTest", "taskText", "editedFiles"]).optional(),
    sources: z.array(z.string()).optional(),
    feedbackBoosts: z.object({
      feedbackMatchCount: z.number(),
      symbolsBoosted: z.number(),
      feedbackIds: z.array(z.string()),
    }).optional(),
  }).optional(),
});

export type AgentContextRequest = z.infer<
  typeof AgentContextRequestSchema
>;
export type AgentContextResponse = z.infer<
  typeof AgentContextResponseSchema
>;

// ============================================================================
// Agent Feedback Schemas
// ============================================================================

export const AgentFeedbackRequestSchema = z.object({
  repoId: z
    .string()
    .min(1)
    .max(MAX_REPO_ID_LENGTH)
    .describe("Repository identifier"),
  versionId: z
    .string()
    .min(1)
    .describe("Version identifier for the feedback context"),
  sliceHandle: z
    .string()
    .min(1)
    .describe("Slice handle that was used for the task"),
  usefulSymbols: z
    .array(z.string())
    .min(1)
    .describe("Symbol IDs that were useful for the task"),
  missingSymbols: z
    .array(z.string())
    .optional()
    .describe("Symbol IDs that were expected but missing"),
  taskTags: z
    .array(z.string())
    .optional()
    .describe("Optional tags describing the task type"),
  taskType: z
    .enum(["debug", "review", "implement", "explain"])
    .optional()
    .describe("Type of task performed"),
  taskText: z
    .string()
    .max(2000)
    .optional()
    .describe("Optional task description for context"),
});

export const AgentFeedbackResponseSchema = z.object({
  ok: z.boolean().describe("Whether the feedback was recorded successfully"),
  feedbackId: z.string().describe("The ID of the created feedback record"),
  repoId: z.string().describe("Repository identifier"),
  versionId: z.string().describe("Version identifier"),
  symbolsRecorded: z
    .number()
    .int()
    .describe("Total number of symbols recorded"),
});

export const AgentFeedbackQueryRequestSchema = z.object({
  repoId: z
    .string()
    .min(1)
    .max(MAX_REPO_ID_LENGTH)
    .describe("Repository identifier"),
  versionId: z
    .string()
    .optional()
    .describe("Optional version identifier to filter by"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum number of records to return"),
  since: z
    .string()
    .optional()
    .describe("Optional ISO timestamp to filter feedback from"),
});

export const AgentFeedbackQueryResponseSchema = z.object({
  repoId: z.string().describe("Repository identifier"),
  feedback: z
    .array(
      z.object({
        feedbackId: z.string(),
        versionId: z.string(),
        sliceHandle: z.string(),
        usefulSymbols: z.array(z.string()),
        missingSymbols: z.array(z.string()),
        taskTags: z.array(z.string()).nullable(),
        taskType: z.string().nullable(),
        taskText: z.string().nullable(),
        createdAt: z.string(),
      }),
    )
    .describe("Array of feedback records"),
  aggregatedStats: z
    .object({
      totalFeedback: z.number().int(),
      topUsefulSymbols: z.array(
        z.object({
          symbolId: z.string(),
          count: z.number().int(),
        }),
      ),
      topMissingSymbols: z.array(
        z.object({
          symbolId: z.string(),
          count: z.number().int(),
        }),
      ),
    })
    .optional()
    .describe("Aggregated statistics if requested"),
  hasMore: z.boolean().describe("Whether more records are available"),
});

export type AgentFeedbackRequest = z.infer<typeof AgentFeedbackRequestSchema>;
export type AgentFeedbackResponse = z.infer<typeof AgentFeedbackResponseSchema>;
export type AgentFeedbackQueryRequest = z.infer<
  typeof AgentFeedbackQueryRequestSchema
>;
export type AgentFeedbackQueryResponse = z.infer<
  typeof AgentFeedbackQueryResponseSchema
>;

// ============================================================================
// Runtime Execution Schemas
// ============================================================================

export const RuntimeExecuteRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  runtime: z.enum(RUNTIME_NAMES),
  executable: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Override executable; defaults to runtime's default (node, python3, bash/cmd)",
    ),
  args: z
    .array(z.string())
    .max(RUNTIME_MAX_ARG_COUNT)
    .default([])
    .describe("Arguments to pass to the executable"),
  code: z
    .string()
    .max(RUNTIME_MAX_CODE_LENGTH)
    .optional()
    .describe(
      "Code mode: write to temp file and execute. Mutually exclusive with args-only mode.",
    ),
  relativeCwd: z
    .string()
    .default(".")
    .describe("Working directory relative to repo root. Must not escape repo."),
  timeoutMs: z
    .number()
    .int()
    .min(RUNTIME_MIN_TIMEOUT_MS)
    .max(RUNTIME_MAX_TIMEOUT_MS)
    .optional()
    .describe("Execution timeout in ms. Defaults to config maxDurationMs."),
  queryTerms: z
    .array(z.string())
    .max(RUNTIME_MAX_QUERY_TERMS)
    .optional()
    .describe(
      "Keywords for excerpt matching — up to 10 terms scanned against output",
    ),
  maxResponseLines: z
    .number()
    .int()
    .min(10)
    .max(1000)
    .default(RUNTIME_DEFAULT_MAX_RESPONSE_LINES)
    .describe("Max lines in stdout/stderr summaries"),
  persistOutput: z
    .boolean()
    .default(true)
    .describe("Whether to persist full output as a gzip artifact"),
  outputMode: z
    .enum(["minimal", "summary", "intent"])
    .default("minimal")
    .describe(
      "Response verbosity: 'minimal' returns only status/exitCode/duration/artifactHandle (~50 tokens); " +
        "'summary' returns head+tail output excerpts (legacy behavior); " +
        "'intent' returns only queryTerms-matched excerpts, no head/tail summary",
    ),
}).strict();

export const RuntimeExecuteExcerptSchema = z.object({
  lineStart: z.number().int(),
  lineEnd: z.number().int(),
  content: z.string(),
  source: z.enum(["stdout", "stderr"]),
});

export const RuntimeExecuteResponseSchema = z.object({
  status: z.enum(["success", "failure", "timeout", "cancelled", "denied"]),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number().int(),
  stdoutSummary: z.string().describe("Head + tail, truncated"),
  stdoutPreview: z
    .string()
    .optional()
    .describe("First 3 lines / 200 chars of stdout (minimal mode only)"),
  stderrSummary: z.string().describe("Tail, truncated"),
  artifactHandle: z.string().nullable(),
  excerpts: z
    .array(RuntimeExecuteExcerptSchema)
    .optional()
    .describe("Keyword-matched line windows from queryTerms"),
  truncation: z.object({
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    totalStdoutBytes: z.number().int(),
    totalStderrBytes: z.number().int(),
  }),
  policyDecision: z
    .object({
      auditHash: z.string(),
      deniedReasons: z.array(z.string()).optional(),
    })
    .optional(),
});

export type RuntimeExecuteRequest = z.infer<typeof RuntimeExecuteRequestSchema>;
export type RuntimeExecuteResponse = z.infer<
  typeof RuntimeExecuteResponseSchema
>;

// Runtime Query Output Schemas
// ============================================================================

export const RuntimeQueryOutputRequestSchema = z.object({
  artifactHandle: z.string().min(1).describe("Artifact handle from a previous runtime.execute call"),
  queryTerms: z
    .array(z.string())
    .min(1)
    .max(RUNTIME_MAX_QUERY_TERMS)
    .describe("Keywords to search for in stored output"),
  maxExcerpts: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of excerpt windows to return"),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(3)
    .describe("Lines of context around each match"),
  stream: z
    .enum(["stdout", "stderr", "both"])
    .default("both")
    .describe("Which output stream(s) to search"),
});

export const RuntimeQueryOutputResponseSchema = z.object({
  artifactHandle: z.string(),
  excerpts: z.array(RuntimeExecuteExcerptSchema),
  totalLines: z.number().int().describe("Total lines in stored output"),
  totalBytes: z.number().int().describe("Total bytes in stored output"),
  searchedStreams: z.array(z.enum(["stdout", "stderr"])),
});

export type RuntimeQueryOutputRequest = z.infer<typeof RuntimeQueryOutputRequestSchema>;
export type RuntimeQueryOutputResponse = z.infer<typeof RuntimeQueryOutputResponseSchema>;

// ============================================================================
// Memory Schemas
// ============================================================================

export const MemoryStoreRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  type: MemoryTypeSchema,
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(50000),
  tags: z.array(z.string()).max(20).optional(),
  confidence: z.number().min(0).max(1).optional(),
  symbolIds: z.array(z.string()).max(100).optional(),
  fileRelPaths: z.array(z.string()).max(100).optional(),
  memoryId: z.string().optional(),
});

export const MemoryStoreResponseSchema = z.object({
  ok: z.boolean(),
  memoryId: z.string(),
  created: z.boolean(),
  deduplicated: z.boolean(),
});

export const MemoryQueryRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  query: z.string().max(1000).optional(),
  types: z.array(MemoryTypeSchema).optional(),
  tags: z.array(z.string()).max(20).optional(),
  symbolIds: z.array(z.string()).max(100).optional(),
  staleOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  sortBy: z.enum(["recency", "confidence"]).optional(),
});

export const MemoryQueryResponseSchema = z.object({
  repoId: z.string(),
  memories: z.array(SurfacedMemorySchema),
  total: z.number().int().min(0),
  hasMore: z.boolean().optional(),
});

export const MemoryRemoveRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  memoryId: z.string().min(1),
  deleteFile: z.boolean().optional(),
});

export const MemoryRemoveResponseSchema = z.object({
  ok: z.boolean(),
  memoryId: z.string(),
});

export const MemorySurfaceRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  symbolIds: z.array(z.string()).max(500).optional(),
  taskType: MemoryTypeSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const MemorySurfaceResponseSchema = z.object({
  repoId: z.string(),
  memories: z.array(SurfacedMemorySchema),
});

export type MemoryStoreRequest = z.infer<typeof MemoryStoreRequestSchema>;
export type MemoryStoreResponse = z.infer<typeof MemoryStoreResponseSchema>;
export type MemoryQueryRequest = z.infer<typeof MemoryQueryRequestSchema>;
export type MemoryQueryResponse = z.infer<typeof MemoryQueryResponseSchema>;
export type MemoryRemoveRequest = z.infer<typeof MemoryRemoveRequestSchema>;
export type MemoryRemoveResponse = z.infer<typeof MemoryRemoveResponseSchema>;
export type MemorySurfaceRequest = z.infer<typeof MemorySurfaceRequestSchema>;
export type MemorySurfaceResponse = z.infer<typeof MemorySurfaceResponseSchema>;

// ============================================================================
// Usage Stats
// ============================================================================

const ToolUsageEntrySchema = z.object({
  tool: z.string(),
  sdlTokens: z.number(),
  rawEquivalent: z.number(),
  savedTokens: z.number(),
  callCount: z.number().int(),
});

const SessionUsageSnapshotSchema = z.object({
  sessionId: z.string(),
  startedAt: z.string(),
  totalSdlTokens: z.number(),
  totalRawEquivalent: z.number(),
  totalSavedTokens: z.number(),
  overallSavingsPercent: z.number(),
  toolBreakdown: z.array(ToolUsageEntrySchema),
  callCount: z.number().int(),
});

const UsageHistorySnapshotSchema = z.object({
  snapshotId: z.string(),
  sessionId: z.string(),
  repoId: z.string(),
  timestamp: z.string(),
  totalSdlTokens: z.number(),
  totalRawEquivalent: z.number(),
  totalSavedTokens: z.number(),
  savingsPercent: z.number(),
  callCount: z.number().int(),
});

const TopToolSavingsSchema = z.object({
  tool: z.string(),
  savedTokens: z.number(),
  savingsPercent: z.number(),
});

export const UsageStatsRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH).optional(),
  scope: z.enum(["session", "history", "both"]).default("both"),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  persist: z.boolean().optional(),
});

export const UsageStatsResponseSchema = z.object({
  session: SessionUsageSnapshotSchema.optional(),
  history: z
    .object({
      snapshots: z.array(UsageHistorySnapshotSchema),
      aggregate: z.object({
        totalSdlTokens: z.number(),
        totalRawEquivalent: z.number(),
        totalSavedTokens: z.number(),
        overallSavingsPercent: z.number(),
        totalCalls: z.number().int(),
        sessionCount: z.number().int(),
        topToolsBySavings: z.array(TopToolSavingsSchema),
      }),
    })
    .optional(),
  formattedSummary: z.string().optional(),
});

export type UsageStatsRequest = z.infer<typeof UsageStatsRequestSchema>;
export type UsageStatsResponse = z.infer<typeof UsageStatsResponseSchema>;

// ============================================================================
// File Read Schemas
// ============================================================================

export const FileReadRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  filePath: z.string().min(1).describe("File path relative to repo root. Only non-indexed file types allowed."),
  maxBytes: z.number().int().min(1).max(512 * 1024).optional().describe("Max bytes to read. Default 512KB."),
  offset: z.number().int().min(0).optional().describe("Start reading from this line number (0-based). Omit for beginning of file."),
  limit: z.number().int().min(1).max(5000).optional().describe("Max lines to return. Omit for no line limit (maxBytes still applies)."),
  search: z.string().max(500).optional().describe("Return only lines matching this regex pattern (case-insensitive). Includes context lines."),
  searchContext: z.number().int().min(0).max(20).default(2).describe("Lines of context around each search match. Default 2."),
  jsonPath: z.string().max(200).optional().describe("For JSON/YAML files: dot-separated key path to extract (e.g. 'server.port' or 'dependencies')."),
});

export type FileReadRequest = z.infer<typeof FileReadRequestSchema>;

export interface FileReadResponse {
  filePath: string;
  content: string;
  bytes: number;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  truncatedAt?: number;
  matchCount?: number;
  extractedPath?: string;
}
