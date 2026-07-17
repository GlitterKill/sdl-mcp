import { z } from "zod";
// =============================================================================
// mcp/tools.ts — Zod schemas + types for MCP tool I/O contracts.
//
// This file is the source-of-truth for tool request/response shapes consumed by
// the gateway router, dispatch tables, and 29 internal callers. ~71 schema exports
// + ~76 type/interface exports across 14 banner-marked sections.
//
// Public sections (search by `// === SECTION ===` banners below):
//   - Repo                  (RepoRegister*, RepoStatus*)
//   - Index                 (IndexRefresh*, plus telemetry payloads)
//   - Buffer                (BufferPush*, BufferCheckpoint*, BufferStatus*)
//   - Symbol                (SymbolSearch*, SymbolGetCard*, SymbolRef)
//   - Slice                 (SliceBuild*, SliceRefresh*, SliceSpilloverGet*)
//   - Delta                 (DeltaGet*, blast-radius payloads)
//   - Code                  (CodeGetSkeleton*, CodeGetHotPath*, CodeNeedWindow*)
//   - Policy                (PolicyGet*, PolicySet*, policy-patch shapes)
//   - RepoOverview          (RepoOverview* directories/full)
//   - PR Risk               (PrRiskAnalyze*)
//   - AgentContext          (sdl.context request/response, ladder rungs)
//   - AgentFeedback         (AgentFeedback*, AgentFeedbackQuery*)
//   - Runtime               (RuntimeExecute*, RuntimeQueryOutput*)
//   - Memory                (Memory*, opt-in)
//   - UsageStats            (UsageStats*)
//   - FileRead / FileWrite  (file gateway ops)
//   - SearchEdit            (cross-file batched edits)
//
// Shared primitives lifted to ./tools/schemas/_shared.ts candidates: Range,
// Signature, Card, Slice, Compact V1/V2/V3, Delta, CodeWindow.
// =============================================================================

import type { RetrievalEvidence } from "../retrieval/types.js";
import type { Range } from "../domain/types.js";
import { RUNTIME_NAMES } from "../runtime/runtimes.js";
import { MAX_RESPONSE_EXCERPT_BYTES } from "../runtime/response-artifacts.js";
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
import { LanguageSchema } from "../config/types.js";

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
  imports: z.array(z.string()).optional(),
  calls: z.array(z.string()).optional(),
  callsNote: z.string().optional(),
});

const SliceDepRefSchema = z.object({
  symbolId: z.string(),
  confidence: z.number().min(0).max(1),
});

const SliceSymbolDepsSchema = z.object({
  imports: z.array(SliceDepRefSchema).optional(),
  calls: z.array(SliceDepRefSchema).optional(),
  callsNote: z.string().optional(),
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
  summaryProvenance: z.enum(["llm", "heuristic"]).optional(),
  invariants: z.array(z.string()).optional(),
  sideEffects: z.array(z.string()).optional(),
  cluster: SymbolClusterInfoSchema.optional(),
  processes: z.array(SymbolProcessInfoSchema).optional(),
  callResolution: CallResolutionSchema.optional(),
  deps: SymbolDepsSchema.optional(),
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
  deps: SliceSymbolDepsSchema.optional(),
  version: SliceSymbolCardVersionSchema,
});

const CompressedEdgeSchema = z.tuple([
  z.number().int().min(0),
  z.number().int().min(0),
  z.enum(["import", "call", "config", "implements"]),
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

const MemoryTypeSchema = z.enum([
  "decision",
  "bugfix",
  "task_context",
  "pattern",
  "convention",
  "architecture",
  "performance",
  "security",
]);

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

const SliceBuildWireFormatSchema = z.enum([
  "json",
  "standard",
  "readable",
  "compact",
  "agent",
  "packed",
  "auto",
]);
/**
 * Compact wire-format version selector. Versions 1 and 2 were retired in
 * 0.11.0; only version 3 is accepted. Ignored when wireFormat is "packed"
 * (header carries its own version). Schema-level rejection of v1/v2 produces
 * a clear validation message instead of a runtime error after parse.
 */
const SliceBuildWireFormatVersionSchema = z.literal(3);

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

const CompactRangeTupleSchema = z.tuple([
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
]);
const CompactRangeSchema = z.union([CompactRangeTupleSchema, z.string()]);

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
  sid: z.string().optional(),
  e: z.string(),
  dl: CardDetailLevelSchema.optional(),
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

export { CompactGroupedEdgeV3Schema, CompactGraphSliceV3Schema };

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
  expectedLines: z.number().int().min(1).max(100000),
  identifiersToFind: z.array(z.string().min(1).max(256)).max(50),
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
  languages: z
    .array(LanguageSchema)
    .optional()
    .describe(
      "SDL language/extension keys. Omit to use the repository registration default language set.",
    ),
  maxFileBytes: z.number().int().min(1).optional(),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, validate and report the proposed registration diff without writing repo config, versions, or enforcement assets.",
    ),
  updateExisting: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Required to apply config changes to an already registered repo. Exact re-registers remain no-ops.",
    ),
  detail: z
    .enum(["compact", "full"])
    .optional()
    .default("compact")
    .describe("Use full to include dry-run current/proposed config snapshots."),
});

export const RepoRegisterResponseSchema = z.object({
  ok: z.boolean(),
  repoId: z.string().min(1),
  dryRun: z.boolean().optional(),
  changed: z.boolean().optional(),
  requiresUpdateExisting: z.boolean().optional(),
  message: z.string().optional(),
  configChanges: z
    .array(
      z.object({
        field: z.string(),
        before: z.unknown().optional(),
        after: z.unknown().optional(),
      }),
    )
    .optional(),
  currentConfig: z.record(z.string(), z.unknown()).optional(),
  proposedConfig: z.record(z.string(), z.unknown()).optional(),
});

export const RepoUnregisterRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  confirmRepoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  discardDrafts: z.boolean().optional().default(false),
});

export const RepoUnregisterResponseSchema = z.object({
  ok: z.literal(true),
  repoId: z.string().min(1),
  removed: z.literal(true),
});

export const RepoStatusRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  surfaceMemories: z.boolean().optional().default(false),
  /** "minimal" is compact/default. "standard" includes health/watcher/prefetch. "full" adds live-index. */
  detail: z
    .enum(["minimal", "standard", "full"])
    .optional()
    .default("minimal"),
  includeTelemetry: z.boolean().optional().default(false),
});

const RepoRootAvailabilitySchema = z.object({
  status: z.enum(["available", "missing", "unreadable"]),
  nextBestAction: z.string().optional(),
});

const RepoStatusRawResponseSchema = z.object({
  repoId: z.string().min(1),
  rootPath: z.string(),
  rootAvailability: RepoRootAvailabilitySchema,
  latestVersionId: z.string().nullable(),
  filesIndexed: z.number().int(),
  symbolsIndexed: z.number().int(),
  countNotes: z
    .object({
      filesIndexed: z.string(),
      symbolsIndexed: z.string(),
    })
    .optional(),
  lastIndexedAt: z.string().nullable(),
  healthScore: z.number().int().min(0).max(100).nullable().optional(),
  healthComponents: z
    .object({
      freshness: z.number().min(0).max(1),
      coverage: z.number().min(0).max(1),
      errorRate: z.number().min(0).max(1),
      edgeQuality: z.number().min(0).max(1),
      callResolution: z.number().min(0).max(1).optional(),
      embeddingFailures: z.number().int().min(0).optional(),
    })
    .optional(),
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
      provider: z.enum(["watchman", "chokidar", "fsWatch"]).nullable(),
      configuredProvider: z.enum(["auto", "watchman", "chokidar", "fsWatch"]),
      fallbackReason: z.string().nullable(),
      errors: z.number().int().min(0),
      queueDepth: z.number().int().min(0),
      stale: z.boolean(),
      lastEventAt: z.string().nullable().optional(),
      lastSuccessfulReindexAt: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  watcherNote: z.string().optional(),
  prefetchStats: z
    .object({
      enabled: z.boolean(),
      queueDepth: z.number().int().min(0),
      running: z.boolean(),
      hitRate: z.number().min(0).max(1),
      wasteRate: z.number().min(0),
      avgLatencyReductionMs: z.number().min(0),
      lastRunAt: z.string().nullable(),
      policyMode: z.enum(["disabled", "observe", "safe"]),
      suppressedPrefetch: z.number().int().min(0),
      acceptedPrefetch: z.number().int().min(0),
    })
    .optional(),
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
  /**
   * Derived-state freshness. When `stale` is true, at least one of the
   * downstream computations (clusters, processes, graph algorithms,
   * semantic summaries/embeddings) lagged behind the latest index, usually
   * because a previous post-index derived computation was interrupted or
   * failed. See `nextBestAction` for the recovery command.
   */
  derivedState: z
    .object({
      stale: z.boolean(),
      clustersDirty: z.boolean(),
      processesDirty: z.boolean(),
      algorithmsDirty: z.boolean(),
      summariesDirty: z.boolean(),
      embeddingsDirty: z.boolean(),
      targetVersionId: z.string().nullable(),
      computedVersionId: z.string().nullable(),
      updatedAt: z.string().nullable(),
      lastError: z.string().nullable().optional(),
      graphIntegrityState: z.enum([
        "unknown",
        "verifying",
        "verified",
        "failed",
      ]),
      graphIntegrityVersionId: z.string().nullable(),
      graphIntegrityDigest: z.string().nullable(),
      nextBestAction: z.string().optional(),
    })
    .optional(),
  serverInfo: z
    .object({
      version: z.string(),
      node: z.string(),
      startedAt: z.string(),
      modulePath: z.string().optional(),
      driftWarnings: z.array(z.string()),
    })
    .optional(),

});

/**
 * `structuredContent` is the model projection, not the raw handler object.
 * Keep a static schema that explicitly admits the compact privacy-preserving
 * shape without requiring rootPath or volatile timestamps.
 */
const RepoStatusCompactResponseSchema = z.object({
  repoId: z.string().min(1),
  rootAvailability: RepoRootAvailabilitySchema,
  latestVersionId: z.string().nullable(),
  filesIndexed: z.number().int(),
  symbolsIndexed: z.number().int(),
  healthScore: z.number().int().min(0).max(100).nullable().optional(),
  healthAvailable: z.boolean().optional(),
  watcherHealth: z
    .object({
      enabled: z.boolean().optional(),
      running: z.boolean().optional(),
      provider: z.enum(["watchman", "chokidar", "fsWatch"]).nullable().optional(),
      fallbackReason: z.string().nullable().optional(),
      errors: z.number().int().min(0).optional(),
      queueDepth: z.number().int().min(0).optional(),
      stale: z.boolean().optional(),
    })
    .optional(),
  derivedState: z
    .object({
      stale: z.boolean().optional(),
      clustersDirty: z.boolean().optional(),
      processesDirty: z.boolean().optional(),
      algorithmsDirty: z.boolean().optional(),
      summariesDirty: z.boolean().optional(),
      embeddingsDirty: z.boolean().optional(),
      lastError: z.string().nullable().optional(),
      graphIntegrityState: z
        .enum(["unknown", "verifying", "verified", "failed"])
        .optional(),
      graphIntegrityVersionId: z.string().nullable().optional(),
      graphIntegrityDigest: z.string().nullable().optional(),
      nextBestAction: z.string().optional(),
    })
    .optional(),
  nextBestAction: z.string().optional(),
  diagnostics: z.unknown().optional(),
  retrievalEvidence: z.unknown().optional(),
});

export const RepoStatusResponseSchema = z.union([
  RepoStatusRawResponseSchema,
  RepoStatusCompactResponseSchema,
]);

export const IndexRefreshRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  mode: z.enum(["full", "incremental"]),
  reason: z.string().optional(),
  includeDiagnostics: z.boolean().optional(),
  async: z
    .boolean()
    .optional()
    .describe(
      "If true, return immediately with operationId and run indexing in background",
    ),
});

export const IndexRefreshResponseSchema = z.object({
  ok: z.boolean(),
  repoId: z.string().min(1),
  versionId: z.string().optional(),
  changedFiles: z.number().int().optional(),
  async: z.boolean().optional(),
  operationId: z.string().optional(),
  message: z.string().optional(),
  diagnostics: z
    .object({
      timings: z.object({
        totalMs: z.number(),
        phases: z.record(z.string(), z.number()),
      }),
    })
    .optional(),
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
    .refine((p) => !p.split(/[\/\\]/).some((seg) => seg === ".."), {
      message: "filePath must not contain path traversal segments",
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
  pending: z
    .boolean()
    .describe(
      "True when checkpoint work is still in flight (pendingBuffers > 0). Poll buffer.status until pending=false to confirm completion.",
    ),
  pendingBuffers: z.number().int().min(0),
  checkpointedFiles: z.number().int().min(0),
  failedFiles: z.number().int().min(0),
  lastCheckpointAt: z.string().nullable(),
  message: z.string().optional(),
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
  /** First 16 chars of symbolId for easier reference in workflows */
  shortId: z.string().length(16).optional(),
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

const SymbolSearchNearMissSchema = z.object({
  name: z.string(),
  kind: SymbolKindEnumSchema,
  file: z.string(),
});

const SymbolSearchNextBestActionSchema = z.object({
  tool: z.literal("sdl.context"),
  args: z.object({
    repoId: z.string().min(1),
    taskType: z.literal("explain"),
    taskText: z.string().min(1),
    options: z.object({
      focusPaths: z.array(z.string().min(1)).length(1),
      contextMode: z.literal("precise"),
    }),
  }),
  rationale: z.string().min(1),
});

export const SymbolSearchRequestSchema = z
  .object({
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    /** Search query string. Use `pattern` as an alias for this field. */
    query: z.string().min(1).max(1000).optional(),
    /** Alias for `query` - accepts the same search pattern. */
    pattern: z.string().min(1).max(1000).optional(),
    kinds: z.array(SymbolKindEnumSchema).optional(),
    limit: z.number().int().min(1).max(SYMBOL_SEARCH_MAX_RESULTS).optional(),
    semantic: z.boolean().optional(),
    /** When true, include per-result retrieval evidence (FTS score, vector score, fusion rank). */
    includeRetrievalEvidence: z.boolean().optional(),
    /** When true, exclude external symbols (from SCIP) from search results. */
    excludeExternal: z.boolean().optional(),
    /** Identifiers / symbol names / IDs the user just mentioned in chat. Seeds Personalized PageRank for chat-aware re-ranking. */
    chatMentions: z.array(z.string().min(1).max(200)).max(20).optional(),
    /** Optional per-mention weight overrides; missing entries default to uniform 1.0. */
    chatMentionWeights: z
      .record(z.string(), z.number().min(0).max(10))
      .optional(),
    /** Walk direction across the dependency graph. Default: "both". */
    pprDirection: z.enum(["out", "in", "both"]).optional(),
    /** PPR coefficient: final multiplier is `1 + pprWeight × pprScore`, capped per call at 2× and across stacked boosts at 4× the original RRF score. Default: 2.0 (tuned 2026-04-27). */
    pprWeight: z.number().min(0).max(2).optional(),
    /** Wire format for the response payload. "packed" emits the SDL-MCP packed wire format (gate-protected); "auto" picks the smaller of packed vs JSON; "json" forces legacy JSON. Falls back to JSON below the savings threshold. Default: "auto". */
    wireFormat: z.enum(["json", "packed", "auto"]).optional().default("auto"),
  })
  .refine((data) => data.query || data.pattern, {
    message: "Either 'query' or 'pattern' must be provided",
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
  results: z.union([z.array(SymbolSearchResultSchema), z.string()]),
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
  /** Personalized PageRank diagnostics, populated when chatMentions triggered the boost. Useful for tuning + debugging. */
  pprBoosts: z
    .object({
      resolvedSeeds: z.array(z.string()),
      unresolvedMentions: z.array(z.string()),
      ambiguousMentions: z.array(z.string()),
      symbolsBoosted: z.number().int().nonnegative(),
      latencyMs: z.number().int().nonnegative(),
      backend: z.enum(["native", "js", "fallback-bfs"]),
    })
    .optional(),
  /** Whether any result had a high-confidence exact match (relevance >= 0.85). */
  exactMatchFound: z.boolean().optional(),
  /** Suggestion text when results are weak or empty. */
  suggestion: z.string().optional(),
  /** Closest symbol names returned on miss paths, intentionally omitting symbolIds to keep retries compact. */
  nearMisses: z.array(SymbolSearchNearMissSchema).max(3).optional(),
  /** Callable path-scoped recovery emitted only when an empty query result looks like a repository path. */
  nextBestAction: SymbolSearchNextBestActionSchema.optional(),
  /** Packed wire-format telemetry. Only populated when symbol-search ran the packed gate. */
  _packedStats: z
    .object({
      encoderId: z.string(),
      jsonBytes: z.number().int().nonnegative(),
      packedBytes: z.number().int().nonnegative(),
      jsonTokens: z.number().int().nonnegative().optional(),
      packedTokens: z.number().int().nonnegative().optional(),
      savedRatio: z.number(),
      tokenSavedRatio: z.number().optional(),
      axisHit: z.enum(["bytes", "tokens"]).optional(),
      candidateDecision: z.enum(["packed", "fallback"]).optional(),
      gateDecision: z.enum(["packed", "fallback"]),
      payloadAttached: z.boolean().optional(),
      returnFormat: z.enum(["json", "packed"]).optional(),
    })
    .optional(),
});

const NotModifiedResponseSchema = z.object({
  notModified: z.literal(true),
  etag: z.string(),
  ledgerVersion: z.string(),
});

const ConditionalNotModifiedResponseSchema = z.object({
  notModified: z.literal(true),
  etag: z.string(),
});

export const ResponseModeSchema = z
  .enum(["inline", "auto", "handle"])
  .optional()
  .default("inline");

export const SessionDeltaModeSchema = z
  .enum(["off", "auto"])
  .optional()
  .default("off");

const ResponseArtifactMetadataSchema = z.object({
  id: z.string(),
  handle: z.string(),
  repoId: z.string(),
  toolName: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  estimatedOriginalTokens: z.number().int(),
  originalBytes: z.number().int(),
  storedBytes: z.number().int(),
  sha256: z.string(),
  etag: z.string(),
  contentKind: z.enum(["json", "text"]),
  requiresSameSession: z.boolean().optional(),
  sessionKeyHash: z.string().optional(),
});

const ResponseArtifactPublicMetadataSchema = ResponseArtifactMetadataSchema.omit({
  estimatedOriginalTokens: true,
});

export const ToolTimingDiagnosticsSchema = z.object({
  timings: z.object({
    totalMs: z.number(),
    phases: z.record(z.string(), z.number()),
  }),
});

export const ResponseArtifactReferenceSchema = z.object({
  responseMode: z.literal("handle"),
  kind: z.literal("responseArtifact"),
  handle: z.string(),
  action: z.literal("response.get"),
  metadata: ResponseArtifactPublicMetadataSchema,
});

const SessionDeltaMetadataSchema = z.object({
  cacheHit: z.boolean(),
  deltaApplied: z.boolean(),
  stableKey: z.string(),
  currentContentHash: z.string(),
  previousContentHash: z.string().optional(),
  etag: z.string().optional(),
  estimatedFullTokens: z.number().int().nonnegative(),
  estimatedDeltaTokens: z.number().int().nonnegative(),
  estimatedTokensAvoided: z.number().int().nonnegative(),
  reason: z
    .enum([
      "delta-off",
      "no-session",
      "cache-miss",
      "content-too-large",
      "delta-too-large",
    ])
    .optional(),
});

const SessionDeltaPayloadSchema = z.object({
  format: z.literal("unified-line-diff"),
  status: z.enum(["unchanged", "changed"]),
  excerpt: z.string().optional(),
  changedLineCount: z.number().int().nonnegative(),
  maxDeltaLines: z.number().int().positive(),
  truncated: z.boolean(),
});

export const SymbolRefSchema = z.object({
  name: z.string().min(1),
  file: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  exportedOnly: z.boolean().optional(),
});

export const SymbolEditOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("replaceSymbol"),
    content: z.string().max(512 * 1024),
  }),
  z.object({
    kind: z.literal("replaceBody"),
    content: z
      .string()
      .max(512 * 1024)
      .describe(
        "Logical body text. SDL normalizes common caller indentation and applies the target body's local indentation without formatting surrounding source.",
      ),
  }),
  z.object({
    kind: z.literal("replaceSignature"),
    content: z.string().max(512 * 1024),
  }),
  z.object({
    kind: z.literal("insertBefore"),
    content: z.string().max(512 * 1024),
  }),
  z.object({
    kind: z.literal("insertAfter"),
    content: z.string().max(512 * 1024),
  }),
  z.object({
    kind: z.literal("renameLocal"),
    name: z.string().min(1).max(200),
    replacement: z.string().min(1).max(200),
  }),
]);

const SymbolEditPreviewRequestSchema = z
  .object({
    mode: z.literal("preview"),
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    symbolId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH).optional(),
    symbolRef: SymbolRefSchema.optional(),
    operation: SymbolEditOperationSchema,
    createBackup: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const targetCount =
      Number(value.symbolId !== undefined) +
      Number(value.symbolRef !== undefined);
    if (targetCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of symbolId or symbolRef.",
        path: ["symbolId"],
      });
    }
  });

const SymbolEditApplyRequestSchema = z.object({
  mode: z.literal("apply"),
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  planHandle: z.string().min(1).max(200),
  createBackup: z.boolean().optional(),
});

const SymbolEditApplyNowRequestSchema = z.object({
  mode: z.literal("applyNow"),
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  symbolId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH),
  expectedAstFingerprint: z.string().min(1),
  expectedRange: RangeSchema,
  operation: SymbolEditOperationSchema,
  createBackup: z.boolean().optional(),
});

export const SymbolEditRequestSchema = z.discriminatedUnion("mode", [
  SymbolEditPreviewRequestSchema,
  SymbolEditApplyRequestSchema,
  SymbolEditApplyNowRequestSchema,
]);

export type SymbolEditOperation = z.infer<typeof SymbolEditOperationSchema>;
export type SymbolEditRequest = z.infer<typeof SymbolEditRequestSchema>;

export interface SymbolEditPreconditions {
  symbol: {
    symbolId: string;
    astFingerprint: string;
    range: Range;
  };
  file: {
    path: string;
    sha256: string | null;
    mtimeMs: number | null;
  };
  draft?: {
    version: number;
    sha256: string;
  };
}

export interface SymbolEditValidationSummary {
  parseBefore: boolean;
  parseAfter: boolean;
  targetSymbolResolved: boolean;
  warnings?: string[];
}

export interface SymbolEditPreviewResponse {
  mode: "preview";
  planHandle: string;
  symbolId: string;
  symbolName: string;
  operation: SymbolEditOperation["kind"];
  file: string;
  writeTarget: "file" | "draft";
  requiresApply: boolean;
  expiresAt: string;
  validation: SymbolEditValidationSummary;
  fileEntries: Array<{
    file: string;
    matchCount: number;
    editMode: FileWriteResponse["mode"];
    snippets: DiffPreviewSnippets;
    indexedSource: boolean;
  }>;
}

export interface SymbolEditApplyResponse {
  mode: "apply";
  planHandle: string;
  symbolId: string;
  symbolName: string;
  operation: SymbolEditOperation["kind"];
  file: string;
  writeTarget: "file" | "draft";
  validation: SymbolEditValidationSummary;
  filesAttempted: number;
  filesWritten: number;
  filesSkipped: number;
  filesFailed: number;
  results: Array<{
    file: string;
    status: "written" | "skipped" | "failed" | "rolled-back";
    bytes?: number;
    reason?: string;
    indexUpdate?: FileWriteResponse["indexUpdate"];
  }>;
  rollback: {
    triggered: boolean;
    restoredFiles: string[];
  };
  draftUpdate?: {
    accepted: boolean;
    overlayVersion: number;
    parseScheduled: boolean;
    warnings: string[];
  };
}

export type SymbolEditResponse =
  | SymbolEditPreviewResponse
  | SymbolEditApplyResponse;

/**
 * Unified symbol card request schema - supports both single and batch retrieval.
 * Provide exactly one of: symbolId, symbolIds, symbolRef, or symbolRefs.
 */
export const SymbolGetCardRequestSchema = z
  .object({
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    // Single symbol lookup
    symbolId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH).optional(),
    symbolRef: SymbolRefSchema.optional(),
    // Batch symbol lookup
    symbolIds: z
      .array(z.string().max(MAX_SYMBOL_ID_LENGTH))
      .min(1)
      .max(100)
      .describe("Array of symbol IDs to fetch (max 100)")
      .optional(),
    symbolRefs: z.array(SymbolRefSchema).min(1).max(100).optional(),
    // Shared options
    ifNoneMatch: z.string().optional(),
    minCallConfidence: z.number().min(0).max(1).optional(),
    includeResolutionMetadata: z.boolean().optional(),
    /**
     * When true, include the per-card `processes` array. Default false —
     * processes add ~100 tokens per high-fan-in helper and are rarely
     * decision-relevant.
     */
    includeProcesses: z.boolean().optional(),
    /**
     * Map of symbolId → known ETag for batch requests.
     * Matching symbols return notModified instead of full card.
     */
    knownEtags: z
      .record(z.string(), z.string())
      .refine((obj) => Object.keys(obj).length <= 1000, {
        message: "knownEtags exceeds maximum of 1000 entries",
      })
      .optional(),
    refsMode: z.enum(["auto", "off"]).optional().default("auto"),
  })
  .superRefine((value, ctx) => {
    const singleProvided =
      Number(value.symbolId !== undefined) +
      Number(value.symbolRef !== undefined);
    const batchProvided =
      Number(value.symbolIds !== undefined) +
      Number(value.symbolRefs !== undefined);
    const totalProvided = singleProvided + batchProvided;
    if (totalProvided !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide exactly one of: symbolId, symbolIds, symbolRef, or symbolRefs.",
        path: ["symbolId"],
      });
    }
  });

const SessionContentRefSchema = z.object({
  key: z.string(),
  etag: z.string().optional(),
});

const SessionContentRefResponseSchema = z.object({
  ref: SessionContentRefSchema,
  unchanged: z.literal(true),
});

const CardWithETagSchema = SymbolCardSchema.extend({
  etag: z.string(),
  changedSincePrior: z.boolean().optional(),
});

// Batch card response (when symbolIds/symbolRefs used)
const BatchCardResponseSchema = z.object({
  cards: z.array(
    z.union([
      CardWithETagSchema,
      NotModifiedResponseSchema,
      SessionContentRefResponseSchema,
    ]),
  ),
  partial: z.boolean().optional(),
  succeeded: z.array(z.string()).optional(),
  failed: z.array(z.string()).optional(),
  failures: z
    .array(
      z.object({
        input: z.string(),
        message: z.string(),
        code: z.string().optional(),
        classification: z.string().optional(),
        retryable: z.boolean().optional(),
        fallbackTools: z.array(z.string()).optional(),
        fallbackRationale: z.string().optional(),
        candidates: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
    )
    .optional(),
});

// Single card response (when symbolId/symbolRef used)
const SingleCardResponseSchema = z.object({
  card: z.union([CardWithETagSchema, SessionContentRefResponseSchema]),
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
});

/**
 * Unified response schema - supports both single and batch responses.
 * Single: { card: CardWithETag, truncation?: {...} }
 * Batch: { cards: [...], partial?: boolean, succeeded?: [...], failed?: [...], failures?: [...] }
 */
export const SymbolGetCardResponseSchema = z.union([
  SingleCardResponseSchema,
  BatchCardResponseSchema,
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
  knownCardEtags: z
    .record(z.string(), z.string())
    .refine((obj) => Object.keys(obj).length <= 1000, {
      message: "knownCardEtags exceeds maximum of 1000 entries",
    })
    .optional(),
  cardDetail: CardDetailLevelSchema.optional(),
  adaptiveDetail: z.boolean().optional(),
  wireFormat: SliceBuildWireFormatSchema.optional().default("auto"),
  wireFormatVersion: SliceBuildWireFormatVersionSchema.optional(),
  budget: SliceBudgetSchema.optional(),
  minConfidence: z.number().min(0).max(1).default(0.5),
  minCallConfidence: z.number().min(0).max(1).optional(),
  includeResolutionMetadata: z.boolean().optional(),
  includeMemories: z.boolean().optional(),
  memoryLimit: z.number().int().min(0).max(20).optional(),
  /** When true, include retrieval evidence in the slice response. */
  includeRetrievalEvidence: z.boolean().optional(),
  /**
   * Controls emission of the compact-wire-format _legend field.
   * - false: never emit (for callers that already understand the format)
   * - true: always emit, even after the session's first slice response
   * - undefined (default): emit once per session, suppressed thereafter
   */
  includeLegend: z.boolean().optional(),
  /**
   * When true, include the per-card `processes` array on symbol cards in
   * the slice. Default false — processes add ~100 tokens per high-fan-in
   * helper and are rarely decision-relevant.
   */
  includeProcesses: z.boolean().optional(),
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
  sliceHandle: z.string().min(1).max(256),
  knownVersion: z
    .string()
    .optional()
    .describe("Known version. Defaults to the slice handle's maxVersion."),
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
      CompactGraphSliceV3Schema,
      z.object({
        wireFormat: z.literal("agent"),
        version: z.string(),
        budget: z.object({ maxCards: z.number(), maxTokens: z.number() }),
        seedSymbols: z.array(z.string()),
        cards: z.array(z.unknown()),
        edges: z.array(z.unknown()),
      }),
      z.string(),
    ]),
    /** Per-symbol retrieval evidence. Only populated when includeRetrievalEvidence is true. */
    retrievalEvidence: z.array(RetrievalEvidenceItemSchema).optional(),
    /** Symptom type classification. Only populated when includeRetrievalEvidence is true. */
    symptomType: z
      .enum(["stackTrace", "failingTest", "taskText", "editedFiles"])
      .optional(),
    /** Packed wire-format telemetry. Only populated when slice was emitted in packed format. */
    _packedStats: z
      .object({
        encoderId: z.string(),
        jsonBytes: z.number().int().nonnegative(),
        packedBytes: z.number().int().nonnegative(),
        jsonTokens: z.number().int().nonnegative().optional(),
        packedTokens: z.number().int().nonnegative().optional(),
        savedRatio: z.number(),
        tokenSavedRatio: z.number().optional(),
        axisHit: z.enum(["bytes", "tokens"]).optional(),
        gateDecision: z.enum(["packed", "fallback"]),
      })
      .optional(),
  }),
  NotModifiedResponseSchema,
  SliceErrorResponseSchema,
]);

export const DeltaGetRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  fromVersion: z
    .string()
    .optional()
    .describe("Start version. Defaults to previous version."),
  toVersion: z
    .string()
    .optional()
    .describe("End version. Defaults to latest version."),
  budget: SliceBudgetSchema.optional(),
  /**
   * Fix #1 — fast count-only preview mode. Returns just the changed-symbol
   * counts and the first N enriched changes, skipping the (expensive)
   * blast-radius governor loop entirely. Use this to probe the size of a
   * delta before committing to a full computation.
   */
  preview: z
    .boolean()
    .optional()
    .describe(
      "If true, skip blast-radius computation and return only changed-symbol " +
        "counts plus a small sample (previewSampleSize). Much faster for large deltas.",
    ),
  previewSampleSize: z
    .number()
    .int()
    .min(0)
    .max(200)
    .optional()
    .describe(
      "Number of enriched changes to return when preview=true. Default 20.",
    ),
  /**
   * Skip the blast-radius computation even when not in preview mode. Useful
   * when the caller only needs changed-symbol details and wants to avoid
   * the governor loop latency.
   */
  skipBlastRadius: z.boolean().optional(),
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

export const SliceSpilloverGetRequestSchema = z
  .object({
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    spilloverHandle: z.string().min(1).max(256).optional(),
    sliceHandle: z.string().min(1).max(256).optional(),
    cursor: z.string().optional(),
    pageSize: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
    limit: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
  })
  .transform(({ limit, ...request }) => ({
    ...request,
    // `limit` is the public paging name used by retrieve-style callers;
    // `pageSize` stays canonical for the existing handler and CLI paths.
    pageSize: request.pageSize ?? limit,
  }))
  .refine((d) => d.spilloverHandle != null || d.sliceHandle != null, {
    message: "Either spilloverHandle or sliceHandle is required",
  });

export const SliceSpilloverGetResponseSchema = z.object({
  spilloverHandle: z.string(),
  cursor: z.string().optional(),
  hasMore: z.boolean(),
  symbols: z.array(SymbolCardSchema),
});

export const CodeNeedWindowRequestObjectSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  symbolId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH).optional(),
  symbolRef: SymbolRefSchema.optional(),
  reason: z.string().min(1).max(10000),
  expectedLines: z.number().int().min(1).max(100000),
  identifiersToFind: z.array(z.string().min(1).max(256)).max(50),
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
  cursor: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Resume from this line number (for continuation after truncation)",
    ),
  responseMode: ResponseModeSchema.describe(
    "Large-response handling: inline preserves legacy output; auto/handle returns response.get handles for large payloads.",
  ),
  deltaMode: SessionDeltaModeSchema.describe(
    "Same-session delta mode for repeated raw windows. Default off preserves legacy output.",
  ),
  maxDeltaLines: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Maximum diff lines when deltaMode=auto returns changed content.",
    ),
});
export const CodeNeedWindowRequestSchema = CodeNeedWindowRequestObjectSchema
  .superRefine((value, ctx) => {
    const targetCount =
      Number(value.symbolId !== undefined) +
      Number(value.symbolRef !== undefined);
    if (targetCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of symbolId or symbolRef.",
        path: targetCount === 0 ? ["symbolId"] : ["symbolRef"],
      });
    }
  });

const CodeWindowResponseApprovedSchema = z.object({
  approved: z.literal(true),
  status: z.enum(["approvedRaw", "downgraded"]).optional(),
  contentKind: z.enum(["raw", "skeleton", "hotPath"]),
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
      suggestedNextCall: z
        .object({
          tool: z.string(),
          description: z.string(),
          args: z.record(z.string(), z.unknown()),
        })
        .optional()
        .describe("Copy these args to continue reading"),
    })
    .optional(),
  matchedIdentifiers: z.array(z.string()).optional(),
  matchedLineNumbers: z.array(z.number().int()).optional(),
  downgradeGuidance: z.string().optional(),
  sessionDelta: SessionDeltaMetadataSchema.optional(),
  delta: SessionDeltaPayloadSchema.optional(),
});

const CodeWindowResponseDeniedSchema = z.object({
  approved: z.literal(false),
  status: z.literal("denied").optional(),
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

export const CodeNeedWindowResponseSchema = z.union([
  z.discriminatedUnion("approved", [
    CodeWindowResponseApprovedSchema,
    CodeWindowResponseDeniedSchema,
  ]),
  ResponseArtifactReferenceSchema,
]);

export const GetSkeletonRequestSchema = z
  .object({
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    symbolId: z.string().max(MAX_SYMBOL_ID_LENGTH).optional(),
    symbolRef: SymbolRefSchema.optional(),
    file: z
      .string()
      .refine((p) => !p.includes(".."), {
        message: "Path traversal (..) is not allowed",
      })
      .refine((p) => !/^[/\\]/.test(p) && !/^[a-zA-Z]:/.test(p), {
        message: "filePath must be relative",
      })
      .refine((p) => !p.includes("\0"), {
        message: "filePath must not contain null bytes",
      })
      .optional(),
    exportedOnly: z.boolean().optional(),
    maxLines: z.number().int().min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    identifiersToFind: z.array(z.string().min(1).max(256)).max(50).optional(),
    skeletonOffset: z.number().int().min(0).optional(),
    ifNoneMatch: z.string().optional(),
    refsMode: z.enum(["auto", "off"]).optional().default("auto"),
  })
  .refine(
    (data) =>
      data.symbolId !== undefined ||
      data.symbolRef !== undefined ||
      data.file !== undefined,
    {
      message: "Either symbolId, symbolRef, or file must be provided",
    },
  );
const GetSkeletonPayloadSchema = z.object({
  skeleton: z.string().optional(),
  ref: SessionContentRefSchema.optional(),
  unchanged: z.literal(true).optional(),
  changedSincePrior: z.boolean().optional(),
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

export const GetSkeletonResponseSchema = z.union([
  GetSkeletonPayloadSchema.extend({
    etag: z.string(),
  }),
  ConditionalNotModifiedResponseSchema,
]);

export const GetHotPathRequestSchema = z
  .object({
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    symbolId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH).optional(),
    symbolRef: SymbolRefSchema.optional(),
    identifiersToFind: z.array(z.string().min(1).max(256)).min(1).max(50),
    maxLines: z.number().int().min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    contextLines: z.number().int().min(0).optional(),
    ifNoneMatch: z.string().optional(),
    refsMode: z.enum(["auto", "off"]).optional().default("auto"),
  })
  .superRefine((value, ctx) => {
    const targetCount =
      Number(value.symbolId !== undefined) +
      Number(value.symbolRef !== undefined);
    if (targetCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of symbolId or symbolRef.",
        path: targetCount === 0 ? ["symbolId"] : ["symbolRef"],
      });
    }
  });

const GetHotPathPayloadSchema = z.object({
  excerpt: z.string().optional(),
  ref: SessionContentRefSchema.optional(),
  unchanged: z.literal(true).optional(),
  changedSincePrior: z.boolean().optional(),
  file: z.string(),
  range: RangeSchema,
  estimatedTokens: z.number().int(),
  matchedIdentifiers: z.array(z.string()),
  matchedLineNumbers: z.array(z.number().int()),
  missedIdentifiers: z.array(z.string()).optional(),
  truncated: z.boolean(),
});

export const GetHotPathResponseSchema = z.union([
  GetHotPathPayloadSchema.extend({
    etag: z.string(),
  }),
  ConditionalNotModifiedResponseSchema,
]);

const PolicyConfigSchema = z.object({
  maxWindowLines: z.number().int().min(1).default(DEFAULT_MAX_WINDOW_LINES),
  maxWindowTokens: z.number().int().min(1).default(DEFAULT_MAX_WINDOW_TOKENS),
  requireIdentifiers: z.boolean().default(true),
  allowBreakGlass: z.boolean().default(false),
  defaultMinCallConfidence: z.number().min(0).max(1).optional(),
  defaultDenyRaw: z.boolean().default(true),
  budgetCaps: z
    .object({
      maxCards: z.number().int().min(1).default(DEFAULT_MAX_CARDS),
      maxEstimatedTokens: z
        .number()
        .int()
        .min(100)
        .default(DEFAULT_MAX_TOKENS_SLICE),
    })
    .optional(),
});

export const PolicyPatchSchema = z
  .object({
    maxWindowLines: z.number().int().min(1).optional(),
    maxWindowTokens: z.number().int().min(1).optional(),
    requireIdentifiers: z.boolean().optional(),
    allowBreakGlass: z.boolean().optional(),
    defaultMinCallConfidence: z.number().min(0).max(1).optional(),
    defaultDenyRaw: z.boolean().optional(),
    budgetCaps: z
      .object({
        maxCards: z.number().int().min(1).optional(),
        maxEstimatedTokens: z.number().int().min(100).optional(),
      })
      .optional(),
  })
  .strict();

export const PolicyGetRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
});

export const PolicyGetResponseSchema = z.object({
  policy: PolicyConfigSchema,
});

// Accepts both shapes:
//   { repoId, policyPatch: { maxWindowLines: 200, ... } }   (canonical)
//   { repoId, maxWindowLines: 200, ... }                    (flat aliases)
// Flat keys are merged into policyPatch; explicit policyPatch wins on overlap.
export const PolicySetRequestSchema = z
  .object({
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    policyPatch: PolicyPatchSchema.optional(),
  })
  .merge(PolicyPatchSchema)
  .transform(({ repoId, policyPatch, ...flat }) => {
    const mergedPatch = { ...flat, ...(policyPatch ?? {}) };
    return { repoId, policyPatch: mergedPatch };
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
  countNotes: z
    .object({
      symbolCount: z.string(),
      exportedSymbolCount: z.string(),
    })
    .optional(),
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
  ifNoneMatch: z.string().optional(),
});

const RepoOverviewPayloadSchema = z.object({
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

export const RepoOverviewResponseSchema = z.union([
  RepoOverviewPayloadSchema.extend({
    etag: z.string(),
  }),
  ConditionalNotModifiedResponseSchema,
]);

// ============================================================================
// Context Summary Schemas
// ============================================================================

export type RepoRegisterRequest = z.infer<typeof RepoRegisterRequestSchema>;
export type RepoRegisterResponse = z.infer<typeof RepoRegisterResponseSchema>;
export type RepoUnregisterRequest = z.infer<typeof RepoUnregisterRequestSchema>;
export type RepoUnregisterResponse = z.infer<typeof RepoUnregisterResponseSchema>;
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
export type SliceBuildRequest = z.infer<typeof SliceBuildRequestSchema>;
export type SliceBuildResponse = z.infer<typeof SliceBuildResponseSchema>;
export type SliceBuildWireFormat = z.infer<typeof SliceBuildWireFormatSchema>;
export type CardDetailLevelSchemaType = z.infer<typeof CardDetailLevelSchema>;
export type LegacyCardDetailLevelSchemaType = z.infer<
  typeof _LegacyCardDetailLevelSchema
>;

export type CompactGroupedEdgeV3 = z.infer<typeof CompactGroupedEdgeV3Schema>;
export type CompactGraphSliceV3 = z.infer<typeof CompactGraphSliceV3Schema>;
// SliceLease, SliceEtag, NotModifiedResponse — canonical types in domain/types.ts
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

const EnrichedSymbolBaseSchema = z.object({
  symbolId: z.string(),
  name: z.string().optional(),
  kind: z.string().optional(),
  file: z.string().optional(),
});

const EnrichedChangedSymbolSchema = EnrichedSymbolBaseSchema.extend({
  changeType: z.string().optional(),
  tiers: z.unknown().optional(),
});

const EnrichedBlastRadiusItemSchema = EnrichedSymbolBaseSchema.extend({
  reason: z.string().optional(),
  distance: z.number().optional(),
  rank: z.number().optional(),
  signal: z.unknown().optional(),
  fanInTrend: z.unknown().optional(),
});

const PaginatedSectionSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    totalCount: z.number().int().min(0),
    truncated: z.boolean(),
  });

const ChangedSymbolsSectionSchema = PaginatedSectionSchema(
  EnrichedChangedSymbolSchema,
).extend({
  unfilteredTotal: z.number().int().min(0).optional(),
  filteredByRiskThreshold: z.boolean().optional(),
});

const PRRiskAnalysisSchema = z.object({
  repoId: z.string().min(1),
  fromVersion: z.string(),
  toVersion: z.string(),
  riskScore: z.number().int().min(0).max(100),
  riskLevel: z.enum(["low", "medium", "high"]),
  changedSymbols: ChangedSymbolsSectionSchema,
  blastRadius: PaginatedSectionSchema(EnrichedBlastRadiusItemSchema),
  findings: PaginatedSectionSchema(FindingSchema),
  evidence: PaginatedSectionSchema(EvidenceSchema),
  recommendedTests: PaginatedSectionSchema(RecommendedTestSchema),
  changedSymbolsCount: z.number().int().min(0),
  blastRadiusCount: z.number().int().min(0),
  preflight: z
    .object({
      skipped: z.array(z.string()),
      message: z.string(),
    })
    .optional(),
});

const PRRiskSummarySchema = z.object({
  riskScore: z.number().int().min(0).max(100),
  riskLevel: z.enum(["low", "medium", "high"]),
  changedCount: z.number().int().min(0),
  filteredCount: z.number().int().min(0),
  blastRadiusCount: z.number().int().min(0),
  topRiskItem: z.string().optional(),
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
  riskThreshold: z.number().min(0).max(100).optional(),
  preflight: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Return changed-symbol counts and risk summary without blast-radius or metadata expansion.",
    ),
  detail: z.enum(["compact", "full"]).optional().default("compact"),
  limit: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .default(5)
    .describe("Default compact item limit for changed symbols and blast radius."),
  budget: z
    .object({
      maxChangedSymbols: z.number().int().min(1).max(200).optional(),
      maxBlastRadius: z.number().int().min(1).max(200).optional(),
      maxFindings: z.number().int().min(0).max(50).optional(),
      maxEvidenceItems: z.number().int().min(0).max(50).optional(),
      maxRecommendedTests: z.number().int().min(0).max(50).optional(),
      maxNestedSymbols: z.number().int().min(0).max(200).optional(),
    })
    .optional(),
});

export const PRRiskAnalysisResponseSchema = z.object({
  summary: PRRiskSummarySchema,
  analysis: PRRiskAnalysisSchema,
  escalationRequired: z.boolean(),
  policyDecision: PolicyDecisionSummarySchema.optional(),
  truncationWarning: z.string().optional(),
});

export type PRRiskAnalysisRequest = z.infer<typeof PRRiskAnalysisRequestSchema>;
export type PRRiskAnalysisResponse = z.infer<
  typeof PRRiskAnalysisResponseSchema
>;

// ============================================================================
// Agent Context Schemas
// ============================================================================

const AgentContextBudgetSchema = z
  .object({
    maxTokens: z.number().optional().describe("Maximum tokens to consume"),
    maxEstimatedTokens: z
      .number()
      .optional()
      .describe("Alias for maxTokens, accepted for slice.build compatibility"),
    maxActions: z
      .number()
      .optional()
      .describe("Maximum number of actions to execute"),
    maxDurationMs: z
      .number()
      .optional()
      .describe("Maximum duration in milliseconds"),
  })
  .passthrough()
  .superRefine((budget, ctx) => {
    if ("maxCards" in budget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxCards"],
        message:
          "sdl.context budget does not support maxCards; use maxTokens/maxEstimatedTokens or call slice.build for card-count budgets",
      });
    }
  })
  .transform((budget) => ({
    ...(budget.maxTokens !== undefined ||
    budget.maxEstimatedTokens !== undefined
      ? { maxTokens: budget.maxTokens ?? budget.maxEstimatedTokens }
      : {}),
    ...(budget.maxActions !== undefined
      ? { maxActions: budget.maxActions }
      : {}),
    ...(budget.maxDurationMs !== undefined
      ? { maxDurationMs: budget.maxDurationMs }
      : {}),
  }));

export const AgentContextRequestSchema = z.object({
  /** Wire format for the response payload. "packed" emits packed wire format (gate-protected); "auto" picks the smaller of packed vs JSON; "json" forces legacy JSON. Default: "auto". */
  wireFormat: z.enum(["json", "packed", "auto"]).optional().default("auto"),
  refsMode: z.enum(["auto", "off"]).optional().default("auto"),
  responseMode: ResponseModeSchema.describe(
    "Large-response handling: inline preserves legacy output; auto/handle stores full responses behind response.get handles.",
  ),
  repoId: z
    .string()
    .min(1)
    .max(MAX_REPO_ID_LENGTH)
    .describe("Repository ID to work with"),
  taskType: z
    .enum(["debug", "review", "implement", "explain"])
    .describe("Type of task to perform"),
  taskText: z.string().min(1).max(2000).describe("Task description or prompt"),
  budget: AgentContextBudgetSchema.optional().describe(
    "Budget constraints for the task",
  ),
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
        .describe(
          "Context breadth: precise returns minimal workflow-efficient context, broad returns richer surrounding context. Default: broad",
        ),
      semantic: z.boolean().optional().describe(
        "Use hybrid (FTS + vector) retrieval for context seeding. Omitted: broad mode uses hybrid retrieval and precise mode uses lexical retrieval; true forces hybrid retrieval; false disables it.",
      ),
      includeRetrievalEvidence: z
        .boolean()
        .optional()
        .describe(
          "Include retrieval evidence (which lanes contributed, per-source counts) in the response. Default: true.",
        ),
      evidenceOptimization: z
        .enum(["off", "dedupe", "budgeted", "global"] as const)
        .optional()
        .describe(
          "Experimental finalEvidence optimizer. dedupe removes exact duplicates and subsumed ladder evidence; budgeted also greedily selects evidence by value per token under budget.maxTokens while preserving required card support for selected hot paths; global applies broad-mode response optimization so summary/answer/finalEvidence are selected together under the response budget. Default: off.",
        ),
      chatMentions: z
        .array(z.string().min(1).max(200))
        .max(20)
        .optional()
        .describe(
          "Identifiers / symbol names / IDs the user just mentioned in chat. Seeds Personalized PageRank for chat-aware re-ranking.",
        ),
      chatMentionWeights: z
        .record(z.string(), z.number().min(0).max(10))
        .optional()
        .describe(
          "Optional per-mention weight overrides; missing entries default to uniform 1.0.",
        ),
      pprDirection: z
        .enum(["out", "in", "both"])
        .optional()
        .describe(
          "Walk direction across the dependency graph for chat-aware re-ranking. Default: both.",
        ),
      pprWeight: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe(
          "PPR coefficient: final multiplier is `1 + pprWeight × pprScore`, capped per call at 2× and across stacked boosts at 4× the original RRF score. Default: 2.0 (tuned 2026-04-27).",
        ),
      cardDetail: z
        .enum(["task", "full"])
        .optional()
        .describe(
          "Context card detail: task applies task-conditioned card projection; full returns unprojected cards. Default: task.",
        ),
      answerFirst: z
        .boolean()
        .optional()
        .describe(
          "Experimental: for explain/debug tasks, return a compact answer plus evidence handles when summary provenance coverage is sufficient.",
        ),
    })
    .optional()
    .describe("Task-specific options"),
  includeDiagnostics: z
    .boolean()
    .optional()
    .describe(
      "Include phase timing diagnostics for performance investigation.",
    ),
  ifNoneMatch: z.string().optional(),
});

const AgentContextPayloadSchema = z.object({
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
  contextModeHint: z
    .string()
    .optional()
    .describe(
      "Explanation of how contextMode (precise/broad) affected the results",
    ),
  finalEvidence: z
    .array(
      z.object({
        type: z.string(),
        reference: z.string(),
        summary: z.string().optional(),
        timestamp: z.number().optional(),
        ref: SessionContentRefSchema.optional(),
        unchanged: z.literal(true).optional(),
        changedSincePrior: z.boolean().optional(),
      }),
    )
    .describe("Evidence collected during execution"),
  sessionDelta: z
    .object({
      newCards: z.number().int().min(0),
      changedCards: z.number().int().min(0),
      unchangedRefs: z.number().int().min(0),
    })
    .optional(),
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
  answerFirstFallback: z
    .literal("insufficient-summary-coverage")
    .optional()
    .describe("Why answerFirst fell back to normal card mode"),
  nextBestAction: z
    .string()
    .optional()
    .describe(
      "Suggested next action based on execution results and policy decisions",
    ),
  /* sdl.context: enriched retrieval evidence */
  retrievalEvidence: z
    .object({
      symptomType: z
        .enum(["stackTrace", "failingTest", "taskText", "editedFiles"])
        .optional(),
      sources: z.array(z.string()).optional(),
      candidateCountPerSource: z.record(z.string(), z.number()).optional(),
      topRanksPerSource: z.record(z.string(), z.array(z.number())).optional(),
      fusionLatencyMs: z.number().optional(),
      diagnosticTimings: z.record(z.string(), z.number()).optional(),
      fallbackReason: z.string().optional(),
      ftsAvailable: z.boolean().optional(),
      vectorAvailable: z.boolean().optional(),
      feedbackBoosts: z
        .object({
          feedbackMatchCount: z.number(),
          symbolsBoosted: z.number(),
          feedbackIds: z.array(z.string()),
        })
        .optional(),
    })
    .optional(),
  diagnostics: ToolTimingDiagnosticsSchema.optional(),
  /** Packed wire-format payload. Populated when wireFormat=packed and gate decision was "packed". */
  _packedPayload: z.string().optional(),
  /** Packed wire-format telemetry. Populated when sdl.context ran the packed gate. */
  _packedStats: z
    .object({
      encoderId: z.string(),
      jsonBytes: z.number().int().nonnegative(),
      packedBytes: z.number().int().nonnegative(),
      jsonTokens: z.number().int().nonnegative().optional(),
      packedTokens: z.number().int().nonnegative().optional(),
      savedRatio: z.number(),
      tokenSavedRatio: z.number().optional(),
      axisHit: z.enum(["bytes", "tokens"]).optional(),
      candidateDecision: z.enum(["packed", "fallback"]).optional(),
      gateDecision: z.enum(["packed", "fallback"]),
      payloadAttached: z.boolean().optional(),
      returnFormat: z.enum(["json", "packed"]).optional(),
    })
    .optional(),
});

const AgentContextAnswerFirstResponseSchema = z.object({
  answer: z.string(),
  confidence: z.enum(["high", "medium"]),
  evidence: z
    .array(
      z.object({
        symbolId: z.string(),
        name: z.string(),
        file: z.string(),
        why: z.string(),
      }),
    )
    .max(8),
  expand: z.object({
    hint: z.string(),
  }),
});

export const AgentContextResponseSchema = z.union([
  AgentContextAnswerFirstResponseSchema.extend({
    etag: z.string(),
  }),
  AgentContextPayloadSchema.extend({
    etag: z.string(),
  }),
  ConditionalNotModifiedResponseSchema,
  ResponseArtifactReferenceSchema,
]);

export type AgentContextRequest = z.infer<typeof AgentContextRequestSchema>;
export type AgentContextResponse = z.infer<typeof AgentContextResponseSchema>;

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
    .optional()
    .describe("Version identifier — auto-resolves to latest if omitted"),
  sliceHandle: z
    .string()
    .min(1)
    .optional()
    .describe("Slice handle — defaults to 'none' if not from a slice workflow"),
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

const RUNTIME_MAX_STDIN_LENGTH = 512 * 1024;
const RuntimeStdinSchema = z
  .string()
  .max(RUNTIME_MAX_STDIN_LENGTH)
  .refine(
    (value) => Buffer.byteLength(value, "utf-8") <= RUNTIME_MAX_STDIN_LENGTH,
    "stdin must be at most 512 KiB when encoded as UTF-8",
  );

const RuntimeExecuteRequestObjectSchema = z
  .object({
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    runtime: z.enum(RUNTIME_NAMES),
    executable: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Override executable; defaults to runtime's default (node, python3, bash/cmd)",
      ),
    command: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Friendly alias for `executable`. Use either field; `executable` wins on conflict.",
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
        "Code mode: execute inline source via runtime-safe stdin/temp handling. Mutually exclusive with args-only mode.",
      ),
    stdin: RuntimeStdinSchema.optional().describe(
      "UTF-8 text written to the child process stdin and then closed (max 512 KiB).",
    ),
    relativeCwd: z
      .string()
      .default(".")
      .refine((s) => !s.includes("\0"), "Path must not contain null bytes")
      .refine(
        (s) => !(/^[A-Za-z]:/.test(s) || s.startsWith("/")),
        "Path must be relative, not absolute",
      )
      .refine(
        (s) => !s.split(/[/\\]/).some((seg) => seg === ".."),
        "Path must not contain traversal sequences (..)",
      )
      .describe(
        "Working directory relative to repo root. Must not escape repo.",
      ),
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
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe("Context lines around queryTerms matches when outputMode='intent'"),
    maxResponseLines: z
      .number()
      .int()
      .min(5)
      .max(1000)
      .default(RUNTIME_DEFAULT_MAX_RESPONSE_LINES)
      .describe("Max lines in stdout/stderr summaries (5-1000, default 100)"),
    persistOutput: z
      .boolean()
      .default(true)
      .describe("Whether to persist full output as a gzip artifact"),
    outputMode: z
      .enum(["minimal", "summary", "intent", "digest"])
      .default("minimal")
      .describe(
        "Response verbosity: 'minimal' returns only status/exitCode/duration/artifactHandle (~50 tokens); " +
          "'summary' returns head+tail output excerpts (legacy behavior); " +
          "'intent' returns only queryTerms-matched excerpts, no head/tail summary; " +
          "'digest' parses tsc/node:test/eslint/npm output into a structured failure digest",
      ),
    includeDiagnostics: z
      .boolean()
      .optional()
      .describe(
        "Include phase timing diagnostics for performance investigation.",
      ),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.runtime === "shell" && !val.code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["code"],
        message:
          "Shell runtime requires the code parameter. Direct args execution is not supported for security reasons.",
      });
    }
  });

// Public schema accepts `command` as a friendly alias for `executable`.
// Either field may be set; if both are present, `executable` wins.
export const RuntimeExecuteRequestSchema =
  RuntimeExecuteRequestObjectSchema.transform((val) => {
    const aliased = val as typeof val & { command?: string };
    if (aliased.command && !aliased.executable) {
      return { ...val, executable: aliased.command };
    }
    return val;
  });

const RuntimeDigestFailureSchema = z.object({
  name: z.string().optional().describe("Test name when known"),
  file: z.string().optional().describe("Repo-relative file path when parseable"),
  line: z.number().int().optional(),
  message: z.string().describe("First line of the error, trimmed to 200 chars"),
});

export const RuntimeOutputDigestSchema = z.object({
  kind: z.enum(["tsc", "node-test", "eslint", "npm", "generic"]),
  ok: z.boolean(),
  summary: z.string().describe("One-line failure summary"),
  failures: z.array(RuntimeDigestFailureSchema),
  truncatedFailures: z.number().int().optional(),
  excerpt: z
    .string()
    .optional()
    .describe("Generic fallback only: bounded excerpt around the first error"),
});

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
    .describe("Deprecated; minimal mode no longer inlines stdout content"),
  stderrSummary: z.string().describe("Tail, truncated"),
  artifactHandle: z.string().nullable(),
  stdinBytes: z.number().int().nonnegative().optional(),
  stdinSha256: z.string().length(64).optional(),
  quotingWarnings: z.array(z.string()).optional(),
  runtimeHints: z.array(z.string()).optional(),
  serverDriftWarnings: z.array(z.string()).optional(),
  nextAction: z
    .object({
      kind: z.enum(["queryOutput", "increaseTimeout", "retry", "inspectPolicy"]),
      message: z.string(),
      action: z.string().optional(),
      queryTerms: z.array(z.string()).optional(),
    })
    .optional(),
  excerpts: z
    .array(RuntimeExecuteExcerptSchema)
    .optional()
    .describe("Keyword-matched line windows from queryTerms"),
  digest: RuntimeOutputDigestSchema.optional().describe(
    "Structured failure digest when outputMode='digest'",
  ),
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
  diagnostics: ToolTimingDiagnosticsSchema.optional(),
});

export type RuntimeExecuteRequest = z.infer<typeof RuntimeExecuteRequestSchema>;
export type RuntimeExecuteResponse = z.infer<
  typeof RuntimeExecuteResponseSchema
>;

// Runtime Query Output Schemas
// ============================================================================

export const RuntimeQueryOutputCursorSchema = z.object({
  stream: z.enum(["stdout", "stderr"]),
  afterLine: z.number().int().min(0),
});

export const RuntimeQueryOutputLineRangeSchema = z
  .object({
    stream: z.enum(["stdout", "stderr"]),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  })
  .superRefine((val, ctx) => {
    if (val.endLine < val.startLine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endLine"],
        message: "endLine must be greater than or equal to startLine",
      });
    }
  });

export const RuntimeQueryOutputRequestSchema = z
  .object({
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    artifactHandle: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/, {
        message:
          "artifactHandle must contain only alphanumerics, dashes, and underscores",
      })
      .describe("Artifact handle from a previous runtime.execute call"),
    queryTerms: z
      .array(z.string())
      .max(RUNTIME_MAX_QUERY_TERMS)
      .default([])
      .describe("Keywords to search for in stored output"),
    cursor: RuntimeQueryOutputCursorSchema.optional(),
    lineRange: RuntimeQueryOutputLineRangeSchema.optional(),
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
  })
  .superRefine((val, ctx) => {
    if (val.queryTerms.length === 0 && !val.lineRange) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["queryTerms"],
        message: "queryTerms are required unless lineRange is provided",
      });
    }
    if (val.cursor && val.stream !== "both" && val.stream !== val.cursor.stream) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stream"],
        message: "stream must match cursor.stream when both are provided",
      });
    }
  });

export const RuntimeQueryOutputResponseSchema = z.object({
  artifactHandle: z.string(),
  excerpts: z.array(RuntimeExecuteExcerptSchema),
  totalLines: z.number().int().describe("Total lines in stored output"),
  totalBytes: z.number().int().describe("Total bytes in stored output"),
  searchedStreams: z.array(z.enum(["stdout", "stderr"])),
  matchStatus: z.enum(["matched", "noMatchFallback", "lineRange"]),
  matchCount: z.number().int().nonnegative(),
  nextCursor: RuntimeQueryOutputCursorSchema.optional(),
});

export type RuntimeQueryOutputRequest = z.infer<
  typeof RuntimeQueryOutputRequestSchema
>;
export type RuntimeQueryOutputResponse = z.infer<
  typeof RuntimeQueryOutputResponseSchema
>;

export const ResponseGetRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  handle: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/, {
      message:
        "handle must contain only alphanumerics, dashes, and underscores",
    })
    .describe("Response artifact handle returned by a large-response tool"),
  full: z
    .boolean()
    .default(false)
    .describe("Return the full stored response instead of a bounded excerpt"),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESPONSE_EXCERPT_BYTES)
    .optional()
    .describe("Maximum bytes to return when full=false"),
  maxTokens: z
    .number()
    .int()
    .min(1)
    .max(250_000)
    .optional()
    .describe("Token bound enforced on returned content when full=false (estimate-based); use maxBytes for an exact byte cap"),
  offsetBytes: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Byte offset for excerpt retrieval when full=false"),
  jsonPath: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Dot or bracket path to extract from JSON artifacts before serialization or array paging"),
  raw: z
    .boolean()
    .optional()
    .default(false)
    .describe("Return raw text excerpts for JSON artifacts; required for byte slicing JSON without jsonPath"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Array item offset after jsonPath extraction"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum array items to return after jsonPath extraction"),
});

export const ResponseGetResponseSchema = z.object({
  handle: z.string(),
  full: z.boolean(),
  truncated: z.boolean(),
  contentKind: z.enum(["json", "text"]),
  content: z.unknown(),
  metadata: ResponseArtifactPublicMetadataSchema,
  range: z.object({
    offsetBytes: z.number().int(),
    returnedBytes: z.number().int(),
    totalBytes: z.number().int(),
  }),
  pagination: z
    .object({
      offset: z.number().int().min(0),
      limit: z.number().int().min(1),
      total: z.number().int().min(0),
      returned: z.number().int().min(0),
      hasMore: z.boolean(),
      nextOffset: z.number().int().min(0).optional(),
    })
    .optional(),
});

export type ResponseGetRequest = z.infer<typeof ResponseGetRequestSchema>;
export type ResponseGetResponse = z.infer<typeof ResponseGetResponseSchema>;
export type ResponseArtifactReference = z.infer<
  typeof ResponseArtifactReferenceSchema
>;

// ============================================================================
// Memory Schemas
// ============================================================================

export const MemoryStoreRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  type: MemoryTypeSchema,
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(50000),
  tags: z.array(z.string().min(1).max(100)).max(20).optional(),
  confidence: z.number().min(0).max(1).optional(),
  symbolIds: z
    .array(z.string().min(1).max(MAX_SYMBOL_ID_LENGTH))
    .max(100)
    .optional(),
  fileRelPaths: z.array(z.string().min(1).max(1024)).max(100).optional(),
  memoryId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH).optional(),
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
  tags: z.array(z.string().min(1).max(100)).max(20).optional(),
  symbolIds: z
    .array(z.string().min(1).max(MAX_SYMBOL_ID_LENGTH))
    .max(100)
    .optional(),
  staleOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(10000).optional(),
  sortBy: z.enum(["recency", "confidence"]).optional(),
});

export const MemoryQueryResponseSchema = z.object({
  repoId: z.string(),
  memories: z.array(SurfacedMemorySchema),
  total: z.number().int().min(0),
  hasMore: z.boolean().optional(),
  // Continuation offset for the next page. Non-null when hasMore is true,
  // null (or omitted) when the caller has reached the end of the result set.
  nextOffset: z.number().int().min(0).nullable().optional(),
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
  symbolIds: z
    .array(z.string().min(1).max(MAX_SYMBOL_ID_LENGTH))
    .max(500)
    .optional(),
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

const PackedEncoderUsageEntrySchema = z.object({
  count: z.number().int().nonnegative(),
  bytesSaved: z.number().nonnegative(),
  avgRatio: z.number(),
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
  packedEncodings: z.number().int().nonnegative().optional(),
  packedFallbacks: z.number().int().nonnegative().optional(),
  packedBytesSaved: z.number().nonnegative().optional(),
  packedByEncoder: z
    .record(z.string(), PackedEncoderUsageEntrySchema)
    .optional(),
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
  scope: z.enum(["session", "history", "lifetime", "both", "all"]).default("both"),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  persist: z.boolean().optional(),
  detail: z.enum(["compact", "full"]).optional().default("compact"),
});

const PackedEncoderUsageSchema = z.object({
  count: z.number().int().nonnegative(),
  bytesSaved: z.number().nonnegative(),
  avgRatio: z.number(),
});

const WirePackedSummarySchema = z.object({
  encodings: z.number().int().nonnegative(),
  fallbacks: z.number().int().nonnegative(),
  bytesSaved: z.number().nonnegative(),
  byEncoder: z.record(z.string(), PackedEncoderUsageSchema),
});

const SignalDensityToolSchema = z.object({
  tool: z.string(),
  deliveredIds: z.number().int().nonnegative(),
  referencedIds: z.number().int().nonnegative(),
  deliveredTokens: z.number().nonnegative(),
  signalDensity: z.number(),
});

const SignalDensitySummarySchema = z.object({
  tools: z.array(SignalDensityToolSchema),
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
  wire: z
    .object({
      packed: WirePackedSummarySchema,
    })
    .optional(),
  signalDensity: SignalDensitySummarySchema.optional(),
  formattedSummary: z.string().optional(),
});

export type UsageStatsRequest = z.infer<typeof UsageStatsRequestSchema>;
export type UsageStatsResponse = z.infer<typeof UsageStatsResponseSchema>;

// ============================================================================
// File Read Schemas
// ============================================================================

export const FileReadRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  filePath: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => !value.includes("\0"), {
      message: "filePath must not contain null bytes",
    })
    .describe(
      "File path relative to repo root. Only non-indexed file types allowed.",
    ),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(512 * 1024)
    .optional()
    .describe("Max bytes to read. Default 512KB."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Start reading from this line number (0-based). Omit for beginning of file.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe(
      "Max lines to return. Omit for no line limit (maxBytes still applies).",
    ),
  search: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Return only lines matching this regex pattern (case-insensitive). Includes context lines.",
    ),
  searchContext: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(2)
    .describe("Lines of context around each search match. Default 2."),
  jsonPath: z
    .string()
    .max(200)
    .optional()
    .describe(
      "For JSON/YAML files: dot-separated key path to extract (e.g. 'server.port' or 'dependencies').",
    ),
  responseMode: ResponseModeSchema.describe(
    "Large-response handling: inline preserves legacy output; auto/handle stores full responses behind response.get handles.",
  ),
  deltaMode: SessionDeltaModeSchema.describe(
    "Same-session delta mode for repeated file windows. Default off preserves legacy output.",
  ),
  maxDeltaLines: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Maximum diff lines when deltaMode=auto returns changed content.",
    ),
});

export type FileReadRequest = z.infer<typeof FileReadRequestSchema>;

export interface FileReadInlineResponse {
  filePath: string;
  content: string;
  bytes: number;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  truncatedAt?: number;
  matchCount?: number;
  extractedPath?: string;
  sessionDelta?: z.infer<typeof SessionDeltaMetadataSchema>;
  delta?: z.infer<typeof SessionDeltaPayloadSchema>;
  hint?: string;
  diagnostics?: z.infer<typeof ToolTimingDiagnosticsSchema>;
}

export type FileReadResponse =
  | FileReadInlineResponse
  | ResponseArtifactReference;

// ============================================================================
// Semantic Enrichment Schemas
// ============================================================================

const SemanticEnrichmentLanguageListSchema = z
  .array(z.string().min(1))
  .max(32)
  .optional()
  .describe(
    "Optional language IDs to refresh/status-check. Defaults to all tree-sitter-backed languages.",
  );

export const SemanticEnrichmentRefreshRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  dryRun: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  install: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Allow verified provider download only when semanticEnrichment.installPolicy is 'verified'. Package-manager installs are never executed.",
    ),
  languages: SemanticEnrichmentLanguageListSchema,
});

export type SemanticEnrichmentRefreshRequest = z.infer<
  typeof SemanticEnrichmentRefreshRequestSchema
>;

export const SemanticEnrichmentStatusRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  languages: SemanticEnrichmentLanguageListSchema,
  detail: z.enum(["compact", "full"]).optional().default("compact"),
  limit: z.number().int().min(0).max(100).optional().default(5),
});

export type SemanticEnrichmentStatusRequest = z.infer<
  typeof SemanticEnrichmentStatusRequestSchema
>;

// ============================================================================
// File Write Schemas
// ============================================================================

export const FileWriteReplaceLinesSchema = z.object({
  start: z
    .number()
    .int()
    .min(0)
    .describe("Start line number (0-based, inclusive)"),
  end: z.number().int().min(0).describe("End line number (0-based, exclusive)"),
  content: z
    .string()
    .max(512 * 1024)
    .describe("New content to replace the line range (max 512KB)"),
});

export const FileWriteReplacePatternSchema = z.object({
  pattern: z.string().min(1).max(500).describe("Regex pattern to find"),
  replacement: z
    .string()
    .describe("Replacement string (supports capture groups)"),
  global: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace all occurrences (default: first only)"),
});

export const FileWriteInsertAtSchema = z.object({
  line: z.number().int().min(0).describe("Line number to insert at (0-based)"),
  content: z
    .string()
    .max(512 * 1024)
    .describe("Content to insert (max 512KB)"),
});

export const FileWriteRequestSchema = z.object({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  filePath: z
    .string()
    .min(1)
    .max(1024)
    .refine((p) => !p.includes("\0"), {
      message: "filePath must not contain null bytes",
    })
    .describe("File path relative to repo root"),

  // Write modes (mutually exclusive - use exactly one)
  content: z
    .string()
    .max(512 * 1024)
    .optional()
    .describe("Full file content for create/overwrite mode (max 512KB)"),
  replaceLines: FileWriteReplaceLinesSchema.optional().describe(
    "Replace a line range with new content",
  ),
  replacePattern:
    FileWriteReplacePatternSchema.optional().describe("Regex find/replace"),
  jsonPath: z
    .string()
    .max(200)
    .optional()
    .describe("Dot-separated path to update in JSON/YAML"),
  jsonValue: z
    .unknown()
    .optional()
    .describe("New value for jsonPath (required if jsonPath is set)"),
  insertAt: FileWriteInsertAtSchema.optional().describe(
    "Insert content at a specific line",
  ),
  append: z
    .string()
    .max(512 * 1024)
    .optional()
    .describe("Content to append to end of file (max 512KB)"),

  // Options
  createBackup: z
    .boolean()
    .optional()
    .default(true)
    .describe("Create .bak backup before modifying (default: true)"),
  createIfMissing: z
    .boolean()
    .optional()
    .default(false)
    .describe("Create file if it doesn't exist"),
});

export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;

export interface DiffPreviewSnippets {
  before: string;
  after: string;
  beforeStartLine: number;
  beforeEndLine: number;
  afterStartLine: number;
  afterEndLine: number;
}

export interface FileWriteResponse {
  filePath: string;
  bytesWritten: number;
  linesWritten: number;
  mode:
    | "create"
    | "overwrite"
    | "replaceLines"
    | "replacePattern"
    | "jsonPath"
    | "insertAt"
    | "append";
  backupPath?: string;
  replacementCount?: number;
  snippets?: DiffPreviewSnippets;
  /** Live-index sync result when writing an indexed source file. */
  indexUpdate?: {
    applied: boolean;
    /** Symbols that existed before and were updated in place. */
    symbolsMatched?: number;
    symbolsAdded?: number;
    symbolsRemoved?: number;
    edgesUpserted?: number;
    error?: string;
  };
  diagnostics?: z.infer<typeof ToolTimingDiagnosticsSchema>;
}

// ============================================================================
// Search/Edit (sdl.search.edit) Schemas
// ============================================================================

const SearchEditCaptureNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
const SearchEditCaptureValueSchema = z.string().max(500);
const MAX_SEARCH_EDIT_REQUIRED_CAPTURES = 32;
const BLOCKED_SEARCH_EDIT_CAPTURE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const SearchEditRequiredCapturesRecordSchema = z
  .record(SearchEditCaptureNameSchema, SearchEditCaptureValueSchema)
  .superRefine((value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length > MAX_SEARCH_EDIT_REQUIRED_CAPTURES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `requiredCaptures may include at most ${MAX_SEARCH_EDIT_REQUIRED_CAPTURES} entries.`,
      });
    }
    for (const key of keys) {
      if (BLOCKED_SEARCH_EDIT_CAPTURE_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Blocked requiredCaptures key: ${key}`,
        });
      }
    }
  });
const SearchEditRequiredCapturesSchema = z
  .any()
  .superRefine((value, ctx) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (BLOCKED_SEARCH_EDIT_CAPTURE_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Blocked requiredCaptures key: ${key}`,
        });
      }
    }
  })
  .pipe(SearchEditRequiredCapturesRecordSchema);

export const SearchEditQuerySchema = z.object({
  literal: z.string().min(1).max(500).optional(),
  regex: z.string().min(1).max(500).optional(),
  replacement: z.string().max(5000).optional(),
  global: z.boolean().optional(),
  structural: z
    .object({
      language: z.string().min(1).max(80).optional(),
      treeSitterQuery: z.string().min(1).max(5000),
      capture: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/)
        .optional(),
      requiredCaptures: SearchEditRequiredCapturesSchema.optional(),
      replacement: z.string().max(5000).optional(),
    })
    .optional(),
  symbolRef: z
    .object({
      name: z.string().min(1).max(200),
      file: z.string().max(500).optional(),
      kind: z.string().max(50).optional(),
    })
    .optional(),
  symbolIds: z.array(z.string().min(1)).max(200).optional(),
  rename: z
    .object({
      newName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
      minConfidence: z.number().min(0).max(1).optional(),
      includeTextOnlyMatches: z.boolean().optional(),
    })
    .optional(),
  signature: z
    .object({
      add: z
        .array(z.object({
          name: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
          typeText: z.string().max(500).optional(),
          defaultText: z.string().max(500).optional(),
          index: z.number().int().min(0).optional(),
          argText: z.string().max(5000).optional(),
        }))
        .optional(),
      remove: z.array(z.object({ name: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/) })).optional(),
      renameParam: z.array(z.object({ from: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/), to: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/) })).optional(),
    })
    .optional(),
  replaceLines: z
    .object({
      start: z.number().int().min(0),
      end: z.number().int().min(0),
      content: z.string().max(512 * 1024),
    })
    .refine((v) => v.end >= v.start, {
      message: "replaceLines.end must be >= replaceLines.start",
    })
    .optional(),
  insertAt: z
    .object({
      line: z.number().int().min(0),
      content: z.string().max(512 * 1024),
    })
    .optional(),
  content: z
    .string()
    .max(512 * 1024)
    .optional(),
  append: z
    .string()
    .max(512 * 1024)
    .optional(),
});

export const SearchEditFiltersSchema = z.object({
  include: z.array(z.string().max(500)).max(50).optional(),
  exclude: z.array(z.string().max(500)).max(50).optional(),
  extensions: z.array(z.string().max(20)).max(50).optional(),
});

export const SearchEditEditMode = z.enum([
  "replacePattern",
  "replaceLines",
  "insertAt",
  "append",
  "overwrite",
]);

const SearchEditBatchOperationSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  targeting: z.enum(["text", "symbol", "identifier", "structural"]),
  query: SearchEditQuerySchema,
  filters: SearchEditFiltersSchema.optional(),
  editMode: SearchEditEditMode,
  maxFiles: z.number().int().min(1).max(500).optional(),
  maxMatchesPerFile: z.number().int().min(1).max(5000).optional(),
  maxTotalMatches: z.number().int().min(1).max(50000).optional(),
});

const SearchEditPreviewRequestSchema = z
  .object({
    mode: z.literal("preview"),
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    targeting: z
      .enum(["text", "symbol", "identifier", "structural", "rename", "signature"])
      .optional(),
    query: SearchEditQuerySchema.optional(),
    filters: SearchEditFiltersSchema.optional(),
    editMode: SearchEditEditMode.optional(),
    operations: z
      .array(SearchEditBatchOperationSchema)
      .min(1)
      .max(50)
      .optional(),
    previewContextLines: z.number().int().min(0).max(20).optional(),
    maxFiles: z.number().int().min(1).max(500).optional(),
    maxMatchesPerFile: z.number().int().min(1).max(5000).optional(),
    maxTotalMatches: z.number().int().min(1).max(50000).optional(),
    createBackup: z.boolean().optional(),
    responseMode: z
      .enum(["inline", "auto", "handle"])
      .optional()
      .describe(
        'Large-preview handling: inline preserves legacy output; auto/handle stores full previews behind response.get handles. Previews default to "auto" (spills to a response artifact past the token threshold); pass "inline" to force full inline previews.',
      ),
  })
  .superRefine((value, ctx) => {
    const operations = value.operations;
    if (operations !== undefined) {
      const seenOperationIds = new Map<string, number>();
      operations.forEach((operation, index) => {
        const trimmed = operation.id?.trim();
        const operationId =
          trimmed && trimmed.length > 0 ? trimmed : `op-${index + 1}`;
        const firstIndex = seenOperationIds.get(operationId);
        if (firstIndex !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["operations", index, "id"],
            message: `Duplicate search.edit operation id "${operationId}" at operations[${index}] (first used at operations[${firstIndex}]).`,
          });
        } else {
          seenOperationIds.set(operationId, index);
        }
      });
      for (const field of ["targeting", "query", "editMode"] as const) {
        if (value[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message:
              "operations[] is mutually exclusive with top-level targeting, query, and editMode.",
          });
        }
      }
      return;
    }
    for (const field of ["targeting", "query", "editMode"] as const) {
      if (value[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "Required when operations[] is not provided.",
        });
      }
    }
    if (value.targeting === "rename") {
      if (value.editMode !== undefined && value.editMode !== "replacePattern") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["editMode"], message: "rename targeting supports only editMode=replacePattern." });
      }
      if (value.query?.rename === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["query", "rename"], message: "rename targeting requires query.rename." });
      }
      const symbolIdCount = value.query?.symbolIds?.length ?? 0;
      const hasOneSymbolId = symbolIdCount === 1;
      const hasSymbolRef = value.query?.symbolRef !== undefined;
      if (hasOneSymbolId === hasSymbolRef) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["query"], message: "rename targeting requires exactly one of query.symbolIds[0] or query.symbolRef." });
      }
    }
    if (value.targeting === "signature") {
      if (value.editMode !== undefined && value.editMode !== "replacePattern") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["editMode"], message: "signature targeting supports only editMode=replacePattern." });
      }
      const sig = value.query?.signature;
      if (sig === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["query", "signature"], message: "signature targeting requires query.signature." });
      } else if (!sig.add?.length && !sig.remove?.length && !sig.renameParam?.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["query", "signature"], message: "signature targeting requires at least one operation." });
      }
      const symbolIdCount = value.query?.symbolIds?.length ?? 0;
      const hasOneSymbolId = symbolIdCount === 1;
      const hasSymbolRef = value.query?.symbolRef !== undefined;
      if (hasOneSymbolId === hasSymbolRef) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["query"], message: "signature targeting requires exactly one of query.symbolIds[0] or query.symbolRef." });
      }
    }
  });

const SearchEditApplyRequestSchema = z.object({
  mode: z.literal("apply"),
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  planHandle: z.string().min(1).max(200),
  createBackup: z.boolean().optional(),
});

export const SearchEditRequestSchema = z.discriminatedUnion("mode", [
  SearchEditPreviewRequestSchema,
  SearchEditApplyRequestSchema,
]);

export type SearchEditRequest = z.infer<typeof SearchEditRequestSchema>;

export interface SearchEditPreviewResponse {
  mode: "preview";
  planHandle: string;
  defaultCreateBackup: boolean;
  applyArgs: {
    mode: "apply";
    repoId: string;
    planHandle: string;
    createBackup: boolean;
  };
  filesMatched: number;
  matchesFound: number;
  filesEligible: number;
  filesSkipped: Array<{ path: string; reason: string; operationId?: string }>;
  filesSkippedTotal?: number;
  filesSkippedTruncated?: boolean;
  filesSkippedByReason?: Array<{ reason: string; count: number }>;
  fileEntries: Array<{
    file: string;
    matchCount: number;
    editMode: FileWriteResponse["mode"];
    snippets: DiffPreviewSnippets;
    indexedSource: boolean;
    astMatches?: Array<{
      target: {
        name: string;
        nodeType: string;
        text: string;
      };
      captures: Array<{
        name: string;
        nodeType: string;
        text: string;
      }>;
    }>;
    operationIds?: string[];
    operations?: Array<{
      id: string;
      matchCount: number;
      editMode: FileWriteResponse["mode"];
    }>;
  }>;
  requiresApply: boolean;
  expiresAt: string;
  partial?: boolean;
  retrievalEvidence?: RetrievalEvidence;
  diagnostics?: z.infer<typeof ToolTimingDiagnosticsSchema>;
}

export interface SearchEditApplyResponse {
  mode: "apply";
  planHandle: string;
  filesAttempted: number;
  filesWritten: number;
  filesSkipped: number;
  filesFailed: number;
  results: Array<{
    file: string;
    status: "written" | "skipped" | "failed" | "rolled-back";
    bytes?: number;
    reason?: string;
    indexUpdate?: FileWriteResponse["indexUpdate"];
  }>;
  fileEntries?: Array<{
    file: string;
    matchCount: number;
    editMode: FileWriteResponse["mode"];
    snippets: DiffPreviewSnippets;
    indexedSource: boolean;
    astMatches?: SearchEditPreviewResponse["fileEntries"][number]["astMatches"];
    operationIds?: string[];
    operations?: Array<{
      id: string;
      matchCount: number;
      editMode: FileWriteResponse["mode"];
    }>;
  }>;
  rollback: {
    triggered: boolean;
    restoredFiles: string[];
  };
  diagnostics?: z.infer<typeof ToolTimingDiagnosticsSchema>;
}

export type SearchEditResponse =
  | SearchEditPreviewResponse
  | SearchEditApplyResponse
  | ResponseArtifactReference;
