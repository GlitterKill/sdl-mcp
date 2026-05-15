/**
 * Gateway tool schemas — 4 namespace-scoped discriminated unions with
 * shared-param envelope (repoId hoisted).
 *
 * Each schema accepts { repoId, action, ...actionParams }.
 * The `action` field discriminates which handler receives the call.
 */
import { z } from "zod";
import {
  SYMBOL_SEARCH_MAX_RESULTS,
  PAGE_SIZE_MAX,
  DEFAULT_MAX_WINDOW_LINES,
  DEFAULT_MAX_WINDOW_TOKENS,
  RUNTIME_MIN_TIMEOUT_MS,
  RUNTIME_MAX_TIMEOUT_MS,
  RUNTIME_MAX_ARG_COUNT,
  RUNTIME_MAX_CODE_LENGTH,
  RUNTIME_MAX_QUERY_TERMS,
  RUNTIME_DEFAULT_MAX_RESPONSE_LINES,
} from "../config/constants.js";
import { MAX_RESPONSE_EXCERPT_BYTES } from "../runtime/response-artifacts.js";

// ============================================================================
// Shared sub-schemas (reused across actions to reduce duplication)
// ============================================================================

const SliceBudgetFields = z.object({
  maxCards: z.number().int().min(1).max(500).optional(),
  maxEstimatedTokens: z.number().int().min(1).max(200000).optional(),
});

// ============================================================================
// sdl.query — Read-only intelligence queries
// ============================================================================

const SymbolSearchAction = z.object({
  action: z.literal("symbol.search"),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(SYMBOL_SEARCH_MAX_RESULTS).optional(),
  semantic: z.boolean().optional(),
});

const SymbolRefFields = z.object({
  name: z.string().min(1),
  file: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  exportedOnly: z.boolean().optional(),
});

const SymbolGetCardAction = z
  .object({
    action: z.literal("symbol.getCard"),
    symbolId: z.string().optional(),
    symbolRef: SymbolRefFields.optional(),
    ifNoneMatch: z.string().optional(),
    minCallConfidence: z.number().min(0).max(1).optional(),
    includeResolutionMetadata: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const provided =
      Number(value.symbolId !== undefined) +
      Number(value.symbolRef !== undefined);
    if (provided !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of symbolId or symbolRef.",
        path: ["symbolId"],
      });
    }
  });

const SymbolEditOperationFields = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("replaceSymbol"), content: z.string() }),
  z.object({ kind: z.literal("replaceBody"), content: z.string() }),
  z.object({ kind: z.literal("replaceSignature"), content: z.string() }),
  z.object({ kind: z.literal("insertBefore"), content: z.string() }),
  z.object({ kind: z.literal("insertAfter"), content: z.string() }),
  z.object({
    kind: z.literal("renameLocal"),
    name: z.string().min(1),
    replacement: z.string().min(1),
  }),
]);

const SymbolEditAction = z
  .object({
    action: z.literal("symbol.edit"),
    mode: z.enum(["preview", "apply", "applyNow"]),
    symbolId: z.string().optional(),
    symbolRef: SymbolRefFields.optional(),
    operation: SymbolEditOperationFields.optional(),
    expectedAstFingerprint: z.string().optional(),
    expectedRange: z
      .object({
        startLine: z.number().int().min(0),
        startCol: z.number().int().min(0),
        endLine: z.number().int().min(0),
        endCol: z.number().int().min(0),
      })
      .optional(),
    planHandle: z.string().min(1).max(200).optional(),
    createBackup: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "preview") {
      const targetCount =
        Number(value.symbolId !== undefined) +
        Number(value.symbolRef !== undefined);
      if (targetCount !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "symbol.edit preview requires exactly one of symbolId or symbolRef.",
          path: ["symbolId"],
        });
      }
      if (value.operation === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "symbol.edit preview requires operation.",
          path: ["operation"],
        });
      }
    }
    if (value.mode === "apply" && value.planHandle === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "symbol.edit apply requires planHandle.",
        path: ["planHandle"],
      });
    }
    if (value.mode === "applyNow") {
      for (const field of [
        "symbolId",
        "operation",
        "expectedAstFingerprint",
        "expectedRange",
      ] as const) {
        if (value[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `symbol.edit applyNow requires ${field}.`,
            path: [field],
          });
        }
      }
    }
  });

const SliceBuildAction = z.object({
  action: z.literal("slice.build"),
  taskText: z.string().min(1).optional(),
  stackTrace: z.string().optional(),
  failingTestPath: z.string().optional(),
  editedFiles: z.array(z.string()).max(100).optional(),
  entrySymbols: z.array(z.string()).max(100).optional(),
  knownCardEtags: z
    .record(z.string(), z.string())
    .refine((obj) => Object.keys(obj).length <= 1000, {
      message: "knownCardEtags exceeds maximum of 1000 entries",
    })
    .optional(),
  cardDetail: z
    .enum(["minimal", "signature", "deps", "compact", "full"])
    .optional(),
  adaptiveDetail: z.boolean().optional(),
  wireFormat: z
    .enum(["standard", "compact", "agent", "packed", "auto"])
    .optional(),
  wireFormatVersion: z.literal(3).optional(),
  budget: SliceBudgetFields.optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  minCallConfidence: z.number().min(0).max(1).optional(),
  includeResolutionMetadata: z.boolean().optional(),
});

const SliceRefreshAction = z.object({
  action: z.literal("slice.refresh"),
  sliceHandle: z.string(),
  knownVersion: z.string(),
});

const SliceSpilloverGetAction = z.object({
  action: z.literal("slice.spillover.get"),
  spilloverHandle: z.string(),
  cursor: z.string().optional(),
  pageSize: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
});

const DeltaGetAction = z.object({
  action: z.literal("delta.get"),
  fromVersion: z.string(),
  toVersion: z.string(),
  budget: SliceBudgetFields.optional(),
});

const PRRiskAnalyzeAction = z.object({
  action: z.literal("pr.risk.analyze"),
  fromVersion: z.string(),
  toVersion: z.string(),
  riskThreshold: z.number().int().min(0).max(100).optional(),
});

const ResponseGetAction = z.object({
  action: z.literal("response.get"),
  handle: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  full: z.boolean().default(false).optional(),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESPONSE_EXCERPT_BYTES)
    .optional(),
  maxTokens: z.number().int().min(1).max(250_000).optional(),
  offsetBytes: z.number().int().min(0).default(0).optional(),
});

const ResponseModeField = {
  responseMode: z.enum(["inline", "auto", "handle"]).optional().default("inline"),
};

const SessionDeltaFields = {
  deltaMode: z.enum(["off", "auto"]).optional().default("off"),
  maxDeltaLines: z.number().int().min(1).max(1000).optional(),
};

export const QueryGatewaySchema = z
  .object({
    repoId: z.string().min(1),
  })
  .and(
    z.union([
      SymbolSearchAction,
      SymbolGetCardAction,
      SliceBuildAction,
      SliceRefreshAction,
      SliceSpilloverGetAction,
      DeltaGetAction,
      PRRiskAnalyzeAction,
      ResponseGetAction,
    ]),
  );

// ============================================================================
// sdl.code — Gated raw code access
// ============================================================================

const CodeNeedWindowAction = z.object({
  action: z.literal("code.needWindow"),
  symbolId: z.string(),
  reason: z.string().min(1),
  expectedLines: z.number().int().min(1),
  identifiersToFind: z.array(z.string()).max(50),
  granularity: z.enum(["symbol", "block", "fileWindow"]).optional(),
  maxTokens: z.number().int().min(1).optional(),
  sliceContext: z
    .object({
      taskText: z.string().min(1),
      stackTrace: z.string().optional(),
      failingTestPath: z.string().optional(),
      editedFiles: z.array(z.string()).max(100).optional(),
      entrySymbols: z.array(z.string()).max(100).optional(),
      budget: SliceBudgetFields.optional(),
    })
    .optional(),
  ...ResponseModeField,
  ...SessionDeltaFields,
});

const GetSkeletonAction = z.object({
  action: z.literal("code.getSkeleton"),
  symbolId: z.string().optional(),
  file: z.string().optional(),
  exportedOnly: z.boolean().optional(),
  maxLines: z.number().int().min(1).optional(),
  maxTokens: z.number().int().min(1).optional(),
  identifiersToFind: z.array(z.string()).max(50).optional(),
  ifNoneMatch: z.string().optional(),
});

const GetHotPathAction = z.object({
  action: z.literal("code.getHotPath"),
  symbolId: z.string(),
  identifiersToFind: z.array(z.string()).min(1).max(50),
  maxLines: z.number().int().min(1).optional(),
  maxTokens: z.number().int().min(1).optional(),
  contextLines: z.number().int().min(0).optional(),
  ifNoneMatch: z.string().optional(),
});

export const CodeGatewaySchema = z
  .object({
    repoId: z.string().min(1),
  })
  .and(
    z.discriminatedUnion("action", [
      CodeNeedWindowAction,
      GetSkeletonAction,
      GetHotPathAction,
    ]),
  );

// ============================================================================
// sdl.repo — Repository lifecycle
// ============================================================================

const RepoRegisterAction = z.object({
  action: z.literal("repo.register"),
  rootPath: z.string().min(1),
  ignore: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  maxFileBytes: z.number().int().min(1).optional(),
});

const RepoStatusAction = z.object({
  action: z.literal("repo.status"),
});

const RepoOverviewAction = z.object({
  action: z.literal("repo.overview"),
  level: z.enum(["stats", "directories", "full"]),
  includeHotspots: z.boolean().optional(),
  directories: z.array(z.string()).optional(),
  maxDirectories: z.number().int().min(1).max(200).optional(),
  maxExportsPerDirectory: z.number().int().min(1).max(50).optional(),
  ifNoneMatch: z.string().optional(),
});

const IndexRefreshAction = z.object({
  action: z.literal("index.refresh"),
  mode: z.enum(["full", "incremental"]),
  reason: z.string().optional(),
});

const PolicyGetAction = z.object({
  action: z.literal("policy.get"),
});

const PolicySetAction = z.object({
  action: z.literal("policy.set"),
  policyPatch: z.object({
    maxWindowLines: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_MAX_WINDOW_LINES)
      .optional(),
    maxWindowTokens: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_MAX_WINDOW_TOKENS)
      .optional(),
    requireIdentifiers: z.boolean().optional(),
    allowBreakGlass: z.boolean().optional(),
    defaultMinCallConfidence: z.number().min(0).max(1).optional(),
    defaultDenyRaw: z.boolean().optional(),
    budgetCaps: z
      .object({
        maxCards: z.number().int().min(1).optional(),
        maxEstimatedTokens: z.number().int().min(1).optional(),
      })
      .refine(
        (caps) =>
          caps.maxCards !== undefined && caps.maxEstimatedTokens !== undefined,
        {
          message:
            "budgetCaps patch must include both maxCards and maxEstimatedTokens",
        },
      )
      .optional(),
  }),
});

const UsageStatsAction = z.object({
  action: z.literal("usage.stats"),
  scope: z.enum(["session", "history", "both"]).default("both"),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  persist: z.boolean().optional(),
});

const FileReadAction = z.object({
  action: z.literal("file.read"),
  filePath: z.string().min(1),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(512 * 1024)
    .optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  search: z.string().max(500).optional(),
  searchContext: z.number().int().min(0).max(20).optional(),
  jsonPath: z.string().max(200).optional(),
  ...ResponseModeField,
  ...SessionDeltaFields,
});

const SearchEditAction = z
  .object({
    action: z.literal("search.edit"),
    mode: z.enum(["preview", "apply"]),
    targeting: z.enum(["text", "symbol"]).optional(),
    query: z
      .object({
        literal: z.string().optional(),
        regex: z.string().optional(),
        replacement: z.string().optional(),
        global: z.boolean().optional(),
        symbolRef: SymbolRefFields.optional(),
        symbolIds: z.array(z.string()).optional(),
      })
      .optional(),
    editMode: z
      .enum([
        "replacePattern",
        "replaceLines",
        "insertAt",
        "append",
        "overwrite",
      ])
      .optional(),
    filters: z
      .object({
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        extensions: z.array(z.string()).optional(),
      })
      .optional(),
    previewContextLines: z.number().int().min(0).max(20).optional(),
    maxFiles: z.number().int().min(1).max(1000).optional(),
    maxMatchesPerFile: z.number().int().min(1).max(5000).optional(),
    maxTotalMatches: z.number().int().min(1).max(50000).optional(),
    planHandle: z.string().min(1).max(200).optional(),
    createBackup: z.boolean().optional(),
    ...ResponseModeField,
  })
  .superRefine((value, ctx) => {
    if (value.mode === "preview") {
      if (value.targeting === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "search.edit preview requires targeting",
          path: ["targeting"],
        });
      }
      if (value.query === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "search.edit preview requires query",
          path: ["query"],
        });
      }
      if (value.editMode === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "search.edit preview requires editMode",
          path: ["editMode"],
        });
      }
    } else if (value.planHandle === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "search.edit apply requires planHandle",
        path: ["planHandle"],
      });
    }
  });

const ScipIngestAction = z.object({
  action: z.literal("scip.ingest"),
  indexPath: z
    .string()
    .min(1)
    .describe(
      "Path to the SCIP protobuf index file (.scip). " +
        "Can be absolute or relative to the repository root.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, validate and parse the SCIP index without writing to the graph database.",
    ),
});

const SemanticEnrichmentRefreshAction = z.object({
  action: z.literal("semantic.enrichment.refresh"),
  dryRun: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  install: z.boolean().optional().default(false),
  languages: z.array(z.string().min(1)).max(32).optional(),
});

const SemanticEnrichmentStatusAction = z.object({
  action: z.literal("semantic.enrichment.status"),
  languages: z.array(z.string().min(1)).max(32).optional(),
});

export const RepoGatewaySchema = z
  .object({
    repoId: z.string().min(1),
  })
  .and(
    z.discriminatedUnion("action", [
      RepoRegisterAction,
      RepoStatusAction,
      RepoOverviewAction,
      IndexRefreshAction,
      PolicyGetAction,
      PolicySetAction,
      UsageStatsAction,
      FileReadAction,
      SearchEditAction,
      SymbolEditAction,
      ScipIngestAction,
      SemanticEnrichmentRefreshAction,
      SemanticEnrichmentStatusAction,
    ]),
  );

// ============================================================================
// sdl.agent — Agentic + live-edit operations
// ============================================================================

const AgentFeedbackAction = z.object({
  action: z.literal("agent.feedback"),
  versionId: z.string().min(1),
  sliceHandle: z.string().min(1),
  usefulSymbols: z.array(z.string()).min(1),
  missingSymbols: z.array(z.string()).optional(),
  taskTags: z.array(z.string()).optional(),
  taskType: z.enum(["debug", "review", "implement", "explain"]).optional(),
  taskText: z.string().optional(),
});

const AgentFeedbackQueryAction = z.object({
  action: z.literal("agent.feedback.query"),
  versionId: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  since: z.string().optional(),
});

const BufferPushAction = z.object({
  action: z.literal("buffer.push"),
  eventType: z.enum(["open", "change", "save", "close", "checkpoint"]),
  filePath: z
    .string()
    .min(1)
    .refine(
      (p) => !p.includes("..") && !/^[\/]/.test(p) && !/^[A-Za-z]:/.test(p),
      {
        message: "filePath must be a relative path without traversal sequences",
      },
    )
    .refine((p) => !p.includes("\0"), {
      message: "filePath must not contain null bytes",
    }),
  content: z.string().max(5_242_880),
  language: z.string().optional(),
  version: z.number().int().min(0),
  dirty: z.boolean(),
  timestamp: z.string(),
  cursor: z
    .object({
      line: z.number().int().min(0),
      col: z.number().int().min(0),
    })
    .optional(),
  selections: z
    .array(
      z.object({
        startLine: z.number().int().min(0),
        startCol: z.number().int().min(0),
        endLine: z.number().int().min(0),
        endCol: z.number().int().min(0),
      }),
    )
    .optional(),
});

const BufferCheckpointAction = z.object({
  action: z.literal("buffer.checkpoint"),
  reason: z.string().optional(),
});

const BufferStatusAction = z.object({
  action: z.literal("buffer.status"),
});

const RuntimeExecuteAction = z.object({
  action: z.literal("runtime.execute"),
  runtime: z.enum(["node", "python", "shell"]),
  executable: z.string().min(1).optional(),
  args: z.array(z.string()).max(RUNTIME_MAX_ARG_COUNT).default([]),
  code: z.string().max(RUNTIME_MAX_CODE_LENGTH).optional(),
  relativeCwd: z.string().default("."),
  timeoutMs: z
    .number()
    .int()
    .min(RUNTIME_MIN_TIMEOUT_MS)
    .max(RUNTIME_MAX_TIMEOUT_MS)
    .optional(),
  queryTerms: z.array(z.string()).max(RUNTIME_MAX_QUERY_TERMS).optional(),
  maxResponseLines: z
    .number()
    .int()
    .min(10)
    .max(1000)
    .default(RUNTIME_DEFAULT_MAX_RESPONSE_LINES),
  persistOutput: z.boolean().default(true),
  outputMode: z
    .enum(["minimal", "summary", "intent"])
    .default("minimal")
    .optional(),
});

const RuntimeQueryOutputAction = z.object({
  action: z.literal("runtime.queryOutput"),
  artifactHandle: z.string().min(1),
  queryTerms: z.array(z.string()).min(1).max(10),
  maxExcerpts: z.number().int().min(1).max(50).default(10).optional(),
  contextLines: z.number().int().min(0).max(10).default(3).optional(),
  stream: z.enum(["stdout", "stderr", "both"]).default("both").optional(),
});

const MemoryTypeGateway = z.enum(["decision", "bugfix", "task_context"]);

const MemoryStoreAction = z.object({
  action: z.literal("memory.store"),
  type: MemoryTypeGateway,
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(50000),
  tags: z.array(z.string()).max(20).optional(),
  confidence: z.number().min(0).max(1).optional(),
  symbolIds: z.array(z.string()).max(100).optional(),
  fileRelPaths: z.array(z.string()).max(100).optional(),
  memoryId: z.string().optional(),
});

const MemoryQueryAction = z.object({
  action: z.literal("memory.query"),
  query: z.string().max(1000).optional(),
  types: z.array(MemoryTypeGateway).optional(),
  tags: z.array(z.string()).max(20).optional(),
  symbolIds: z.array(z.string()).max(100).optional(),
  staleOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  sortBy: z.enum(["recency", "confidence"]).optional(),
});

const MemoryRemoveAction = z.object({
  action: z.literal("memory.remove"),
  memoryId: z.string().min(1),
  deleteFile: z.boolean().optional(),
});

const MemorySurfaceAction = z.object({
  action: z.literal("memory.surface"),
  symbolIds: z.array(z.string()).max(500).optional(),
  taskType: MemoryTypeGateway.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const AgentGatewaySchema = z
  .object({
    repoId: z.string().min(1),
  })
  .and(
    z.discriminatedUnion("action", [
      AgentFeedbackAction,
      AgentFeedbackQueryAction,
      BufferPushAction,
      BufferCheckpointAction,
      BufferStatusAction,
      RuntimeExecuteAction,
      RuntimeQueryOutputAction,
      MemoryStoreAction,
      MemoryQueryAction,
      MemoryRemoveAction,
      MemorySurfaceAction,
    ]),
  );

// ============================================================================
// Constants — all valid action names for enumeration tests
// ============================================================================

export const QUERY_ACTIONS = [
  "symbol.search",
  "symbol.getCard",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  "delta.get",
  "pr.risk.analyze",
  "response.get",
] as const;

export const CODE_ACTIONS = [
  "code.needWindow",
  "code.getSkeleton",
  "code.getHotPath",
] as const;

export const REPO_ACTIONS = [
  "repo.register",
  "repo.status",
  "repo.overview",
  "index.refresh",
  "scip.ingest",
  "policy.get",
  "policy.set",
  "usage.stats",
  "file.read",
  "search.edit",
  "symbol.edit",
  "semantic.enrichment.refresh",
  "semantic.enrichment.status",
] as const;

export const AGENT_ACTIONS = [
  "agent.feedback",
  "agent.feedback.query",
  "buffer.push",
  "buffer.checkpoint",
  "buffer.status",
  "runtime.execute",
  "runtime.queryOutput",
  "memory.store",
  "memory.query",
  "memory.remove",
  "memory.surface",
] as const;

export const ALL_ACTIONS = [
  ...QUERY_ACTIONS,
  ...CODE_ACTIONS,
  ...REPO_ACTIONS,
  ...AGENT_ACTIONS,
] as const;
