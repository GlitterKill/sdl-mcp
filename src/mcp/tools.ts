import { z } from "zod";
import {
  SYMBOL_SEARCH_MAX_RESULTS,
  PAGE_SIZE_MAX,
  DEFAULT_MAX_WINDOW_LINES,
  DEFAULT_MAX_WINDOW_TOKENS,
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

const SymbolMetricsSchema = z.object({
  fanIn: z.number().int().min(0).optional(),
  fanOut: z.number().int().min(0).optional(),
  churn30d: z.number().int().min(0).optional(),
  testRefs: z.array(z.string()).optional(),
});

const SymbolCardVersionSchema = z.object({
  ledgerVersion: z.string(),
  astFingerprint: z.string(),
});

const SymbolCardSchema = z.object({
  symbolId: z.string(),
  repoId: z.string(),
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
  deps: SymbolDepsSchema,
  metrics: SymbolMetricsSchema.optional(),
  version: SymbolCardVersionSchema,
});

const CompressedEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(["import", "call", "config"]),
  weight: z.number(),
});

const SliceBudgetSchema = z.object({
  maxCards: z.number().int().min(1).optional(),
  maxEstimatedTokens: z.number().int().min(1).optional(),
});

const RequiredSliceBudgetSchema = z.object({
  maxCards: z.number().int().min(1),
  maxEstimatedTokens: z.number().int().min(1),
});

const FrontierItemSchema = z.object({
  symbolId: z.string(),
  score: z.number(),
  why: z.string(),
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

const GraphSliceSchema = z.object({
  repoId: z.string(),
  versionId: z.string(),
  budget: RequiredSliceBudgetSchema,
  startSymbols: z.array(z.string()),
  cards: z.array(SymbolCardSchema),
  edges: z.array(CompressedEdgeSchema),
  frontier: z.array(FrontierItemSchema).optional(),
  truncation: SliceTruncationSchema.optional(),
});

const DeltaSymbolChangeSchema = z.object({
  symbolId: z.string(),
  changeType: z.enum(["added", "removed", "modified"]),
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
});

const BlastRadiusItemSchema = z.object({
  symbolId: z.string(),
  reason: z.string(),
  distance: z.number(),
  rank: z.number(),
  signal: z.enum(["diagnostic", "directDependent", "graph"]),
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
  repoId: z.string(),
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
  repoId: z.string(),
  symbolId: z.string(),
  reason: z.string(),
  expectedLines: z.number().int().min(1),
  identifiersToFind: z.array(z.string()),
  granularity: z.enum(["symbol", "block", "fileWindow"]).optional(),
  maxTokens: z.number().int().min(1).optional(),
  sliceContext: z
    .object({
      taskText: z.string().min(1),
      stackTrace: z.string().optional(),
      failingTestPath: z.string().optional(),
      editedFiles: z.array(z.string()).optional(),
      entrySymbols: z.array(z.string()).optional(),
      budget: SliceBudgetSchema.optional(),
    })
    .optional(),
});

export const RepoRegisterRequestSchema = z.object({
  repoId: z.string().min(1),
  rootPath: z.string().min(1),
  ignore: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  maxFileBytes: z.number().int().min(1).optional(),
});

export const RepoRegisterResponseSchema = z.object({
  ok: z.boolean(),
  repoId: z.string(),
});

export const RepoStatusRequestSchema = z.object({
  repoId: z.string(),
});

export const RepoStatusResponseSchema = z.object({
  repoId: z.string(),
  rootPath: z.string(),
  latestVersionId: z.string().nullable(),
  filesIndexed: z.number().int(),
  symbolsIndexed: z.number().int(),
  lastIndexedAt: z.string().nullable(),
});

export const IndexRefreshRequestSchema = z.object({
  repoId: z.string(),
  mode: z.enum(["full", "incremental"]),
  reason: z.string().optional(),
});

export const IndexRefreshResponseSchema = z.object({
  ok: z.boolean(),
  repoId: z.string(),
  versionId: z.string(),
  changedFiles: z.number().int(),
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
});

export const SymbolSearchRequestSchema = z.object({
  repoId: z.string(),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(SYMBOL_SEARCH_MAX_RESULTS).optional(),
});

export const SymbolSearchResponseSchema = z.object({
  repoId: z.string(),
  results: z.array(SymbolSearchResultSchema),
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

const NotModifiedResponseSchema = z.object({
  notModified: z.literal(true),
  etag: z.string(),
  ledgerVersion: z.string(),
});

export const SymbolGetCardRequestSchema = z.object({
  repoId: z.string(),
  symbolId: z.string(),
  ifNoneMatch: z.string().optional(),
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
  repoId: z.string(),
  taskText: z.string().min(1),
  stackTrace: z.string().optional(),
  failingTestPath: z.string().optional(),
  editedFiles: z.array(z.string()).optional(),
  entrySymbols: z.array(z.string()).optional(),
  budget: SliceBudgetSchema.optional(),
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
  knownVersion: z.string(),
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
    DeltaSymbolChangeSchema.extend({
      tiers: z
        .object({
          interfaceStable: z.boolean(),
          behaviorStable: z.boolean(),
          sideEffectsStable: z.boolean(),
          riskScore: z.number(),
        })
        .optional(),
    }),
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

export const SliceBuildResponseSchema = z.union([
  z.object({
    sliceHandle: z.string(),
    ledgerVersion: z.string(),
    lease: SliceLeaseSchema,
    sliceEtag: SliceEtagSchema.optional(),
    slice: GraphSliceSchema,
  }),
  NotModifiedResponseSchema,
]);

export const DeltaGetRequestSchema = z.object({
  repoId: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  budget: SliceBudgetSchema.optional(),
});

export const DeltaGetResponseSchema = z.object({
  delta: DeltaPackSchema,
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
  repoId: z.string(),
  symbolId: z.string(),
  reason: z.string().min(1),
  expectedLines: z.number().int().min(1),
  identifiersToFind: z.array(z.string()),
  granularity: z.enum(["symbol", "block", "fileWindow"]).optional(),
  maxTokens: z.number().int().min(1).optional(),
  sliceContext: z
    .object({
      taskText: z.string().min(1),
      stackTrace: z.string().optional(),
      failingTestPath: z.string().optional(),
      editedFiles: z.array(z.string()).optional(),
      entrySymbols: z.array(z.string()).optional(),
      budget: SliceBudgetSchema.optional(),
    })
    .optional(),
});

const CodeWindowResponseApprovedSchema = z.object({
  approved: z.literal(true),
  repoId: z.string(),
  symbolId: z.string(),
  file: z.string(),
  range: RangeSchema,
  code: z.string(),
  whyApproved: z.array(z.string()),
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
        })
        .nullable(),
    })
    .optional(),
  matchedIdentifiers: z.array(z.string()).optional(),
  matchedLineNumbers: z.array(z.number().int()).optional(),
});

const CodeWindowResponseDeniedSchema = z.object({
  approved: z.literal(false),
  whyDenied: z.array(z.string()),
  suggestedNextRequest: CodeWindowRequestSchema.partial().optional(),
});

export const CodeNeedWindowResponseSchema = z.discriminatedUnion("approved", [
  CodeWindowResponseApprovedSchema,
  CodeWindowResponseDeniedSchema,
]);

export const GetSkeletonRequestSchema = z
  .object({
    repoId: z.string(),
    symbolId: z.string().optional(),
    file: z.string().optional(),
    exportedOnly: z.boolean().optional(),
    maxLines: z.number().int().min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    identifiersToFind: z.array(z.string()).optional(),
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
        })
        .nullable(),
    })
    .optional(),
});

export const GetHotPathRequestSchema = z.object({
  repoId: z.string(),
  symbolId: z.string(),
  identifiersToFind: z.array(z.string()).min(1),
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
  truncated: z.boolean(),
});

const PolicyConfigSchema = z.object({
  maxWindowLines: z.number().int().min(1).default(DEFAULT_MAX_WINDOW_LINES),
  maxWindowTokens: z.number().int().min(1).default(DEFAULT_MAX_WINDOW_TOKENS),
  requireIdentifiers: z.boolean().default(true),
  allowBreakGlass: z.boolean().default(true),
});

export const PolicyGetRequestSchema = z.object({
  repoId: z.string(),
});

export const PolicyGetResponseSchema = z.object({
  policy: PolicyConfigSchema,
});

export const PolicySetRequestSchema = z.object({
  repoId: z.string(),
  policyPatch: PolicyConfigSchema.partial(),
});

export const PolicySetResponseSchema = z.object({
  ok: z.boolean(),
  repoId: z.string(),
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
  repoId: z.string(),
  level: z.enum(["stats", "directories", "full"]),
  includeHotspots: z.boolean().optional(),
  directories: z.array(z.string()).optional(),
  maxDirectories: z.number().int().min(1).max(200).optional(),
  maxExportsPerDirectory: z.number().int().min(1).max(50).optional(),
});

export const RepoOverviewResponseSchema = z.object({
  repoId: z.string(),
  versionId: z.string(),
  generatedAt: z.string(),
  stats: RepoStatsSchema,
  directories: z.array(DirectorySummarySchema),
  hotspots: CodebaseHotspotsSchema.optional(),
  layers: z.array(z.string()).optional(),
  entryPoints: z.array(z.string()).optional(),
  tokenMetrics: TokenMetricsSchema,
});

export type RepoRegisterRequest = z.infer<typeof RepoRegisterRequestSchema>;
export type RepoRegisterResponse = z.infer<typeof RepoRegisterResponseSchema>;
export type RepoStatusRequest = z.infer<typeof RepoStatusRequestSchema>;
export type RepoStatusResponse = z.infer<typeof RepoStatusResponseSchema>;
export type IndexRefreshRequest = z.infer<typeof IndexRefreshRequestSchema>;
export type IndexRefreshResponse = z.infer<typeof IndexRefreshResponseSchema>;
export type SymbolSearchRequest = z.infer<typeof SymbolSearchRequestSchema>;
export type SymbolSearchResponse = z.infer<typeof SymbolSearchResponseSchema>;
export type SymbolGetCardRequest = z.infer<typeof SymbolGetCardRequestSchema>;
export type SymbolGetCardResponse = z.infer<typeof SymbolGetCardResponseSchema>;
export type SliceBuildRequest = z.infer<typeof SliceBuildRequestSchema>;
export type SliceBuildResponse = z.infer<typeof SliceBuildResponseSchema>;
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

const FindingSchema = z.object({
  type: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  message: z.string(),
  affectedSymbols: z.array(z.string()),
  metadata: z.record(z.unknown()).optional(),
});

const EvidenceSchema = z.object({
  type: z.string(),
  description: z.string(),
  symbolId: z.string().optional(),
  data: z.record(z.unknown()).optional(),
});

const RecommendedTestSchema = z.object({
  type: z.string(),
  description: z.string(),
  targetSymbols: z.array(z.string()),
  priority: z.enum(["high", "medium", "low"]),
});

const PRRiskAnalysisSchema = z.object({
  repoId: z.string(),
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
  repoId: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  riskThreshold: z.number().int().min(0).max(100).optional(),
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

export const AgentOrchestrateRequestSchema = z.object({
  repoId: z.string().describe("Repository ID to work with"),
  taskType: z
    .enum(["debug", "review", "implement", "explain"])
    .describe("Type of task to perform"),
  taskText: z.string().describe("Task description or prompt"),
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
    })
    .optional()
    .describe("Task-specific options"),
});

export const AgentOrchestrateResponseSchema = z.object({
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
        input: z.record(z.any()),
        output: z.any().optional(),
        error: z.string().optional(),
        timestamp: z.number(),
        durationMs: z.number(),
        evidence: z.array(z.any()),
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
});

export type AgentOrchestrateRequest = z.infer<
  typeof AgentOrchestrateRequestSchema
>;
export type AgentOrchestrateResponse = z.infer<
  typeof AgentOrchestrateResponseSchema
>;
