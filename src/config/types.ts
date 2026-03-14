import { z } from "zod";
import {
  MAX_FILE_BYTES,
  DEFAULT_MAX_WINDOW_LINES,
  DEFAULT_MAX_WINDOW_TOKENS,
  DEFAULT_INDEXING_CONCURRENCY,
  MAX_INDEXING_CONCURRENCY,
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  TS_DIAGNOSTICS_MAX_ERRORS,
  DEFAULT_OPERATION_TIMEOUT_MS,
  MIN_OPERATION_TIMEOUT_MS,
  DEFAULT_SYMBOL_CARD_CACHE_MAX_ENTRIES,
  DEFAULT_SYMBOL_CARD_CACHE_MAX_SIZE_BYTES,
  DEFAULT_GRAPH_SLICE_CACHE_MAX_ENTRIES,
  DEFAULT_GRAPH_SLICE_CACHE_MAX_SIZE_BYTES,
  WATCHER_DEFAULT_MAX_WATCHED_FILES,
  RUNTIME_DEFAULT_TIMEOUT_MS,
  RUNTIME_MIN_TIMEOUT_MS,
  RUNTIME_MAX_TIMEOUT_MS,
  RUNTIME_DEFAULT_MAX_STDOUT_BYTES,
  RUNTIME_DEFAULT_MAX_STDERR_BYTES,
  RUNTIME_DEFAULT_MAX_ARTIFACT_BYTES,
  RUNTIME_DEFAULT_ARTIFACT_TTL_HOURS,
  RUNTIME_DEFAULT_MAX_CONCURRENT_JOBS,
  RUNTIME_MAX_CONCURRENT_JOBS,
  RUNTIME_MIN_BYTES,
} from "./constants.js";

export const LanguageSchema = z.enum([
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "go",
  "java",
  "cs",
  "c",
  "cpp",
  "php",
  "rs",
  "kt",
  "sh",
]);

export const RepoConfigSchema = z.object({
  repoId: z.string().min(1),
  rootPath: z.string().min(1),
  ignore: z
    .array(z.string())
    .default([
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/build/**",
    ]),
  languages: z
    .array(LanguageSchema)
    .default([
      "ts",
      "tsx",
      "js",
      "jsx",
      "py",
      "go",
      "java",
      "cs",
      "c",
      "cpp",
      "php",
      "rs",
      "kt",
      "sh",
    ]),
  maxFileBytes: z.number().int().min(1).default(MAX_FILE_BYTES),
  includeNodeModulesTypes: z.boolean().default(true),
  packageJsonPath: z.string().nullish(),
  tsconfigPath: z.string().nullish(),
  workspaceGlobs: z.array(z.string()).nullish(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const PolicyConfigSchema = z.object({
  maxWindowLines: z.number().int().min(1).default(DEFAULT_MAX_WINDOW_LINES),
  maxWindowTokens: z.number().int().min(1).default(DEFAULT_MAX_WINDOW_TOKENS),
  requireIdentifiers: z.boolean().default(true),
  allowBreakGlass: z.boolean().default(true),
  defaultMinCallConfidence: z.number().min(0).max(1).optional(),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export const RedactionPatternSchema = z.object({
  name: z.string().min(1).optional(),
  pattern: z.string().min(1),
  flags: z.string().optional(),
});

export const RedactionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  includeDefaults: z.boolean().default(true),
  patterns: z.array(RedactionPatternSchema).default([]),
});

export type RedactionConfig = z.infer<typeof RedactionConfigSchema>;

export const IndexingConfigSchema = z.object({
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_INDEXING_CONCURRENCY)
    .default(DEFAULT_INDEXING_CONCURRENCY),
  enableFileWatching: z.boolean().default(true),
  maxWatchedFiles: z
    .number()
    .int()
    .min(1)
    .default(WATCHER_DEFAULT_MAX_WATCHED_FILES),
  workerPoolSize: z.number().int().min(1).max(16).nullish(),
  engine: z.enum(["typescript", "rust"]).default("rust"),
  watchDebounceMs: z.number().int().min(50).max(5000).default(300),
});

export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;

export const LiveIndexConfigSchema = z.object({
  enabled: z.boolean().default(true),
  debounceMs: z.number().int().min(25).max(5000).default(75),
  idleCheckpointMs: z.number().int().min(1000).max(300000).default(15_000),
  maxDraftFiles: z.number().int().min(1).max(10_000).default(200),
  reconcileConcurrency: z.number().int().min(1).max(8).default(1),
  clusterRefreshThreshold: z.number().int().min(1).max(1000).default(25),
});

export type LiveIndexConfig = z.infer<typeof LiveIndexConfigSchema>;

export const EdgeWeightsSchema = z.object({
  call: z.number().min(0).default(1.0),
  import: z.number().min(0).default(0.6),
  config: z.number().min(0).default(0.8),
});

export const SliceConfigSchema = z.object({
  defaultMaxCards: z.number().int().min(1).default(DEFAULT_MAX_CARDS),
  defaultMaxTokens: z.number().int().min(1).default(DEFAULT_MAX_TOKENS_SLICE),
  edgeWeights: EdgeWeightsSchema,
});

export type SliceConfig = z.infer<typeof SliceConfigSchema>;

export const DiagnosticsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(["tsLS", "tsc"]).default("tsLS"),
  maxErrors: z.number().int().min(1).default(TS_DIAGNOSTICS_MAX_ERRORS),
  timeoutMs: z
    .number()
    .int()
    .min(MIN_OPERATION_TIMEOUT_MS)
    .default(DEFAULT_OPERATION_TIMEOUT_MS),
  scope: z.enum(["changedFiles", "workspace"]).default("changedFiles"),
});

export type DiagnosticsConfig = z.infer<typeof DiagnosticsConfigSchema>;

export const CacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  symbolCardMaxEntries: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_SYMBOL_CARD_CACHE_MAX_ENTRIES),
  symbolCardMaxSizeBytes: z
    .number()
    .int()
    .min(1024)
    .default(DEFAULT_SYMBOL_CARD_CACHE_MAX_SIZE_BYTES),
  graphSliceMaxEntries: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_GRAPH_SLICE_CACHE_MAX_ENTRIES),
  graphSliceMaxSizeBytes: z
    .number()
    .int()
    .min(1024)
    .default(DEFAULT_GRAPH_SLICE_CACHE_MAX_SIZE_BYTES),
});

export type CacheConfig = z.infer<typeof CacheConfigSchema>;

export const PluginConfigSchema = z.object({
  paths: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  strictVersioning: z.boolean().default(true),
});

export type PluginConfig = z.infer<typeof PluginConfigSchema>;

export const AnnConfigSchema = z.object({
  enabled: z.boolean().default(true),
  m: z.number().int().min(4).max(64).default(16),
  efConstruction: z.number().int().min(16).max(500).default(200),
  efSearch: z.number().int().min(8).max(256).default(50),
  maxElements: z.number().int().min(1000).max(1000000).default(200000),
});

export type AnnConfig = z.infer<typeof AnnConfigSchema>;

export const SUPPORTED_EMBEDDING_MODELS = [
  "all-MiniLM-L6-v2",
  "nomic-embed-text-v1.5",
] as const;

export const SemanticConfigSchema = z.object({
  enabled: z.boolean().default(true),
  alpha: z.number().min(0).max(1).default(0.6),
  provider: z.enum(["api", "local", "mock"]).default("local"),
  model: z.enum(SUPPORTED_EMBEDDING_MODELS).default("all-MiniLM-L6-v2"),
  modelCacheDir: z.string().nullish(),
  generateSummaries: z.boolean().default(false),
  /** Summary LLM backend — independent from embedding provider.
   *  "api" = Anthropic, "local" = OpenAI-compatible (Ollama), "mock" = deterministic.
   *  Defaults to the embedding `provider` value for backward compatibility. */
  summaryProvider: z.enum(["api", "local", "mock"]).nullish(),
  /** Model name for summary generation. Defaults per-provider:
   *  "api" → "claude-haiku-4-5-20251001", "local" → "gpt-4o-mini" (OpenAI-compatible). */
  summaryModel: z.string().nullish(),
  summaryApiKey: z.string().nullish(),
  summaryApiBaseUrl: z.string().nullish(),
  summaryMaxConcurrency: z.number().int().min(1).max(20).default(5),
  summaryBatchSize: z.number().int().min(1).max(50).default(20),
  ann: AnnConfigSchema.optional(),
});

export type SemanticConfig = z.infer<typeof SemanticConfigSchema>;

export const PrefetchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxBudgetPercent: z.number().int().min(1).max(100).default(20),
  warmTopN: z.number().int().min(1).default(50),
});

export type PrefetchConfig = z.infer<typeof PrefetchConfigSchema>;

export const TracingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  serviceName: z.string().default("sdl-mcp"),
  exporterType: z.enum(["console", "otlp", "memory"]).default("console"),
  otlpEndpoint: z.string().nullish(),
  sampleRate: z.number().min(0).max(1).default(1.0),
});

export type TracingConfig = z.infer<typeof TracingConfigSchema>;

export const ParallelScorerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  poolSize: z.number().int().min(1).max(8).nullish(),
  minBatchSize: z.number().int().min(1).max(100).nullish(),
});

export type ParallelScorerConfig = z.infer<typeof ParallelScorerConfigSchema>;

export const GraphDatabaseConfigSchema = z.object({
  path: z.string().nullish(),
});

export type GraphDatabaseConfig = z.infer<typeof GraphDatabaseConfigSchema>;

export const ConcurrencyConfigSchema = z.object({
  maxSessions: z.number().int().min(1).max(16).default(8),
  maxToolConcurrency: z.number().int().min(1).max(32).default(8),
  readPoolSize: z.number().int().min(1).max(8).default(4),
  writeQueueTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  toolQueueTimeoutMs: z.number().int().min(5000).max(120000).default(30000),
});

export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

export const RuntimeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowedRuntimes: z.array(z.string()).default(["node", "python"]),
  allowedExecutables: z.array(z.string()).default([]),
  maxDurationMs: z
    .number()
    .int()
    .min(RUNTIME_MIN_TIMEOUT_MS)
    .max(RUNTIME_MAX_TIMEOUT_MS)
    .default(RUNTIME_DEFAULT_TIMEOUT_MS),
  maxStdoutBytes: z
    .number()
    .int()
    .min(RUNTIME_MIN_BYTES)
    .default(RUNTIME_DEFAULT_MAX_STDOUT_BYTES),
  maxStderrBytes: z
    .number()
    .int()
    .min(RUNTIME_MIN_BYTES)
    .default(RUNTIME_DEFAULT_MAX_STDERR_BYTES),
  maxArtifactBytes: z
    .number()
    .int()
    .min(RUNTIME_MIN_BYTES)
    .default(RUNTIME_DEFAULT_MAX_ARTIFACT_BYTES),
  artifactTtlHours: z
    .number()
    .int()
    .min(1)
    .default(RUNTIME_DEFAULT_ARTIFACT_TTL_HOURS),
  maxConcurrentJobs: z
    .number()
    .int()
    .min(1)
    .max(RUNTIME_MAX_CONCURRENT_JOBS)
    .default(RUNTIME_DEFAULT_MAX_CONCURRENT_JOBS),
  envAllowlist: z.array(z.string()).default([]),
  artifactBaseDir: z.string().nullish(),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export const GatewayConfigSchema = z.object({
  enabled: z.boolean().default(true),
  emitLegacyTools: z.boolean().default(true),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const AppConfigSchema = z.object({
  repos: z.array(RepoConfigSchema),
  /**
   * Deprecated legacy SQLite path (v0.7.x). Only used by the one-time
   * SQLite→Ladybug migration script in v0.8.
   */
  dbPath: z.string().min(1).optional(),
  graphDatabase: GraphDatabaseConfigSchema.optional(),
  policy: PolicyConfigSchema,
  redaction: RedactionConfigSchema.optional(),
  indexing: IndexingConfigSchema.optional(),
  liveIndex: LiveIndexConfigSchema.optional(),
  slice: SliceConfigSchema.optional(),
  diagnostics: DiagnosticsConfigSchema.optional(),
  cache: CacheConfigSchema.optional(),
  plugins: PluginConfigSchema.optional(),
  semantic: SemanticConfigSchema.optional(),
  prefetch: PrefetchConfigSchema.optional(),
  tracing: TracingConfigSchema.optional(),
  parallelScorer: ParallelScorerConfigSchema.optional(),
  concurrency: ConcurrencyConfigSchema.optional(),
  runtime: RuntimeConfigSchema.optional(),
  gateway: GatewayConfigSchema.optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
