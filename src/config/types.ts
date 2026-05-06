import { z } from "zod";
import { RUNTIME_NAMES } from "../runtime/runtimes.js";
import {
  MAX_FILE_BYTES,
  DEFAULT_MAX_WINDOW_LINES,
  DEFAULT_MAX_WINDOW_TOKENS,
  DEFAULT_INDEXING_CONCURRENCY,
  MAX_INDEXING_CONCURRENCY,
  DEFAULT_PASS2_CONCURRENCY,
  MAX_PASS2_CONCURRENCY,
  DEFAULT_EMBEDDING_CONCURRENCY,
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_FILE_SUMMARY_EMBEDDING_BATCH_SIZE,
  DEFAULT_FILE_SUMMARY_EMBEDDING_MAX_CHARS,
  MAX_EMBEDDING_BATCH_SIZE,
  MAX_EMBEDDING_CONCURRENCY,
  MAX_FILE_SUMMARY_EMBEDDING_BATCH_SIZE,
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
  DEFAULT_MEMORY_SURFACE_LIMIT,
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

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  toolsEnabled: z.boolean().default(true),
  fileSyncEnabled: z.boolean().default(true),
  surfacingEnabled: z.boolean().default(true),
  hintsEnabled: z.boolean().default(true),
  defaultSurfaceLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(DEFAULT_MEMORY_SURFACE_LIMIT),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/** Partial schema for repo-level overrides — no defaults filled in. */
export const MemoryConfigOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  toolsEnabled: z.boolean().optional(),
  fileSyncEnabled: z.boolean().optional(),
  surfacingEnabled: z.boolean().optional(),
  hintsEnabled: z.boolean().optional(),
  defaultSurfaceLimit: z.number().int().min(1).max(50).optional(),
});

export type MemoryConfigOverride = z.infer<typeof MemoryConfigOverrideSchema>;

export const RepoConfigSchema = z.object({
  repoId: z.string().min(1),
  rootPath: z.string().min(1),
  ignore: z
    .array(z.string())
    .default([
      "**/.git/**",
      "**/dist/**",
      "**/dist-*/**",
      "**/build/**",
      "**/out/**",
      "**/target/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/vendor/**",
      "**/.next/**",
      "**/.nuxt/**",
      "**/__pycache__/**",
      "**/.pytest_cache/**",
      "**/*.pyc",
      "**/.venv/**",
      "**/venv/**",
      "**/.tmp/**",
      "**/.claude/**",
      "**/.codex/**",
      "**/.cursor/**",
      "**/.aider*/**",
      "**/.windsurf/**",
      "**/.continue/**",
      "**/.sdl-memory/**",
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
  memory: MemoryConfigOverrideSchema.optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const PolicyConfigSchema = z.object({
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
        .min(1)
        .default(DEFAULT_MAX_TOKENS_SLICE),
    })
    .optional(),
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
  workerPoolSize: z.number().int().min(1).max(32).nullish(),
  engine: z.enum(["typescript", "rust"]).default("rust"),
  watchDebounceMs: z.number().int().min(50).max(5000).default(300),
  /** Number of files to resolve concurrently in Pass 2. Default 1 (sequential). */
  pass2Concurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_PASS2_CONCURRENCY)
    .default(DEFAULT_PASS2_CONCURRENCY),
});

export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;

export const LiveIndexConfigSchema = z.object({
  enabled: z.boolean().default(true),
  debounceMs: z.number().int().min(25).max(5000).default(75),
  idleCheckpointMs: z.number().int().min(1000).max(300000).default(15_000),
  maxDraftFiles: z.number().int().min(1).max(10_000).default(200),
  reconcileConcurrency: z.number().int().min(1).max(16).default(1),
  clusterRefreshThreshold: z.number().int().min(1).max(1000).default(25),
});

export type LiveIndexConfig = z.infer<typeof LiveIndexConfigSchema>;

export const EdgeWeightsSchema = z.object({
  call: z.number().min(0).default(1.0),
  import: z.number().min(0).default(0.6),
  config: z.number().min(0).default(0.8),
  implements: z.number().min(0).default(0.9),
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
  "jina-embeddings-v2-base-code",
  "nomic-embed-text-v1.5",
] as const;

/**
 * Semantic retrieval configuration for hybrid FTS + vector search.
 * Controls the new hybrid retrieval pipeline introduced in v0.10.
 */
export const SemanticRetrievalFtsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  indexName: z.string().default("symbol_search_text_v1"),
  topK: z.number().int().min(1).default(75),
  conjunctive: z.boolean().default(false),
});

export const SemanticRetrievalVectorIndexSchema = z.object({
  indexName: z.string(),
});

export const SemanticRetrievalVectorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  topK: z.number().int().min(1).default(75),
  /** Build-time ef_construction for HNSW index creation. */
  efc: z.number().int().min(1).default(200),
  /** Query-time ef_search for HNSW similarity queries. @deprecated Use efs for query-time only. */
  efs: z.number().int().min(1).default(200),
  /** Per-model HNSW index config keyed by model name. */
  indexes: z.record(z.string(), SemanticRetrievalVectorIndexSchema).default({
    "jina-embeddings-v2-base-code": { indexName: "symbol_vec_jina_code_v2" },
    "nomic-embed-text-v1.5": { indexName: "symbol_vec_nomic_embed_v15" },
  }),
});

export const SemanticRetrievalFusionConfigSchema = z.object({
  strategy: z.enum(["rrf"]).default("rrf"),
  rrfK: z.number().int().min(1).default(60),
});

export const SemanticRetrievalConfigSchema = z.object({
  /** "legacy" = original semantic-only re-rank path; "hybrid" = FTS + vector fusion. */
  mode: z.enum(["legacy", "hybrid"]).default("hybrid"),
  /** When true, file-extension filtering is optional (not enforced during retrieval). */
  extensionsOptional: z.boolean().default(true),
  fts: SemanticRetrievalFtsConfigSchema.optional().default(() =>
    SemanticRetrievalFtsConfigSchema.parse({}),
  ),
  vector: SemanticRetrievalVectorConfigSchema.optional().default(() =>
    SemanticRetrievalVectorConfigSchema.parse({}),
  ),
  fusion: SemanticRetrievalFusionConfigSchema.optional().default(() =>
    SemanticRetrievalFusionConfigSchema.parse({}),
  ),
  /** Maximum candidate symbols to collect before fusion re-ranking. */
  candidateLimit: z.number().int().min(1).default(100),
});

export type SemanticRetrievalFtsConfig = z.infer<
  typeof SemanticRetrievalFtsConfigSchema
>;
export type SemanticRetrievalVectorConfig = z.infer<
  typeof SemanticRetrievalVectorConfigSchema
>;
export type SemanticRetrievalFusionConfig = z.infer<
  typeof SemanticRetrievalFusionConfigSchema
>;
export type SemanticRetrievalConfig = z.infer<
  typeof SemanticRetrievalConfigSchema
>;

export const SemanticConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * @deprecated Use `retrieval.fusion.rrfK` and the hybrid pipeline instead.
   * Legacy blend weight (0–1) for semantic vs. keyword score. Still honoured in
   * "legacy" mode; ignored when `retrieval.mode` is "hybrid".
   */
  alpha: z.number().min(0).max(1).default(0.6),
  provider: z.enum(["api", "local", "mock"]).default("local"),
  model: z.string().default("jina-embeddings-v2-base-code"),
  /* sdl.context: additional embedding models */
  /** Additional embedding models to populate at index time so multiple vector
   *  lanes can contribute to hybrid fusion. Primary `model` is always populated;
   *  each name listed here gets a separate pass. Unknown model names are skipped.
   *  Typical: `["nomic-embed-text-v1.5"]` alongside a jina primary. */
  additionalModels: z
    .array(z.string())
    .optional()
    .default(["nomic-embed-text-v1.5"]),
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
  summaryMaxConcurrency: z.number().int().min(1).max(32).default(5),
  summaryBatchSize: z.number().int().min(1).max(50).default(20),
  /**
   * Number of embedding batches to process concurrently during
   * `refreshSymbolEmbeddings()`. Defaults to 1 (sequential). Increasing
   * this can improve throughput on multi-core machines but ONNX Runtime's
   * internal thread pool is shared across all concurrent calls; consider
   * reducing `intraOpNumThreads` proportionally when raising above 1.
   * Capped at MAX_EMBEDDING_CONCURRENCY (8).
   */
  embeddingConcurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_EMBEDDING_CONCURRENCY)
    .default(DEFAULT_EMBEDDING_CONCURRENCY),
  /**
   * ONNX inference batch width for symbol embedding refresh. Default 32
   * matches `LocalEmbeddingProvider`'s tokenizer + session expectations.
   * Larger batches (64-128) amortise tokenizer + session bind/unbind costs
   * across more rows per round-trip but raise peak memory roughly with the
   * longest sequence in the batch. Length-bucketing before splitting keeps
   * tokenizer pad waste bounded. Capped at MAX_EMBEDDING_BATCH_SIZE (128).
   */
  embeddingBatchSize: z
    .number()
    .int()
    .min(1)
    .max(MAX_EMBEDDING_BATCH_SIZE)
    .default(DEFAULT_EMBEDDING_BATCH_SIZE),
  /**
   * FileSummary embedding batch width. File-level payloads are larger than
   * symbol payloads, so this defaults lower than `embeddingBatchSize` and is
   * used only by the hybrid FileSummary vector pass.
   */
  fileSummaryEmbeddingBatchSize: z
    .number()
    .int()
    .min(1)
    .max(MAX_FILE_SUMMARY_EMBEDDING_BATCH_SIZE)
    .default(DEFAULT_FILE_SUMMARY_EMBEDDING_BATCH_SIZE),
  /**
   * Maximum characters sent to the embedding provider for each FileSummary.
   * Stored summaries/search text are not truncated; this only bounds ONNX/DML
   * inference memory and tokenizer padding cost.
   */
  fileSummaryEmbeddingMaxChars: z
    .number()
    .int()
    .min(512)
    .max(32_768)
    .default(DEFAULT_FILE_SUMMARY_EMBEDDING_MAX_CHARS),
  /**
   * When two or more embedding models are configured (e.g. jina + nomic),
   * run them in series instead of via `Promise.all`. The default
   * (`false`) launches all models concurrently — best when ORT can truly
   * run two sessions on independent thread pools. On systems where the
   * sessions serialize at the ORT thread-pool layer (observed alternation
   * pattern), `true` typically wins by ~5-15%: each model holds the full
   * thread budget end-to-end, weights stay hot in L3 cache, and
   * model-handoff scheduling overhead disappears. Wall time becomes
   * `model_a_time + model_b_time` rather than the contended-parallel
   * worst-case.
   */
  embeddingsSequential: z.boolean().default(false),
  /**
   * Which ONNX file variant to load for each embedding model. Lets users
   * trade speed for accuracy without recompiling. Valid values depend on
   * what each model publishes — when a chosen variant is unavailable for
   * a given model, the registry falls back to that model's
   * `defaultVariant` with a warning.
   *
   * Common variants:
   *   - `"default"` / `"int8"`: HF's general-quantized file (~140-160MB).
   *     The current shipped default, balanced speed/accuracy.
   *   - `"fp16"`: half-precision (~270-320MB). ~30% faster than fp32 with
   *     <0.5% accuracy loss.
   *   - `"fp32"`: full precision (~550-650MB). Reference quality, slowest.
   *   - `"q4"`, `"q4f16"`, `"bnb4"`, `"uint8"`: aggressive quantization
   *     (~110-165MB), 2-4× faster than fp32 with 1-7% accuracy loss
   *     depending on workload. Availability per model varies — see
   *     `ModelInfo.variants` in `model-registry.ts`.
   *
   * Pass-through string so future variants land without a schema bump.
   */
  modelVariant: z.string().optional(),
  /**
   * ONNX Runtime execution providers, in priority order. ORT tries them
   * left-to-right and uses the first one that initialises successfully.
   *
   * Defaults to `["cpu"]`. The default `onnxruntime-node` npm package
   * ships these providers (no extra installation required):
   *
   *   - Windows x64: `"dml"` (DirectML — NVIDIA + AMD + Intel DX12 GPUs),
   *     `"webgpu"`.
   *   - macOS (x64 / arm64): `"coreml"` (Apple Silicon ANE/GPU + Intel
   *     Mac GPU).
   *   - Linux x64: `"cuda"`, `"tensorrt"`. CUDA EP requires an NVIDIA
   *     GPU plus CUDA 12 + cuDNN installed on the host system — the EP
   *     binaries ship with the package but won't initialise without the
   *     runtime libraries.
   *
   * Out of scope (need a custom ORT build): `"rocm"` (AMD on Linux),
   * `"openvino"` (Intel), `"qnn"` (Qualcomm). Users on AMD Linux can
   * substitute their own `onnxruntime-node` build at the package level
   * and sdl-mcp will pick up the extra providers — the filter only
   * drops entries known to be unavailable in the default package.
   *
   * Always include `"cpu"` somewhere so initialisation can fall back
   * when a GPU provider can't load — the helper auto-appends it if you
   * forget.
   */
  executionProviders: z.array(z.string()).default(["cpu"]),
  /**
   * ONNX Runtime thread-pool configuration for local embedding inference.
   *
   * ORT defaults `intra_op_num_threads` to **physical** core count, which on
   * SMT/HT CPUs (and on AMD CPUs whose Provider Driver pins the Node process
   * to a single CCD) leaves half the logical threads idle. Setting this
   * explicitly to `os.availableParallelism()` saturates available threads.
   *
   * Both fields default to 0 — the helper interprets 0 as "auto" and resolves
   * to `os.availableParallelism()` for `intraOpNumThreads`, 1 for
   * `interOpNumThreads`. Set explicit positive values to override.
   *
   * Notes:
   *   - Two embedding models run concurrently via Promise.all and share ORT's
   *     global thread pool, so the pool size is total, not per-model.
   *   - When raising `embeddingConcurrency` above 1, consider lowering
   *     `intraOpNumThreads` proportionally to avoid oversubscription.
   *   - `executionMode: "parallel"` allows ORT to run independent graph nodes
   *     concurrently within a single inference; usually a small win for
   *     transformer-style models.
   */
  onnx: z
    .object({
      intraOpNumThreads: z.number().int().min(0).max(256).default(0),
      interOpNumThreads: z.number().int().min(0).max(64).default(0),
      executionMode: z.enum(["sequential", "parallel"]).default("sequential"),
    })
    .optional(),
  /**
   * @deprecated Use `retrieval.vector` for HNSW index configuration instead.
   * Legacy HNSW ANN index settings. Still honoured when `retrieval.mode` is
   * "legacy"; ignored when "hybrid" retrieval is active.
   */
  ann: AnnConfigSchema.optional(),
  /** Hybrid retrieval pipeline configuration (FTS + vector fusion). */
  retrieval: SemanticRetrievalConfigSchema.optional(),
});

export type SemanticConfig = z.infer<typeof SemanticConfigSchema>;

export const PrefetchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxBudgetPercent: z.number().int().min(1).max(100).default(20),
  // Default 0 = no startup warming. Earlier default (50) marked all 50
  // entries as wasted prefetch when no caller consumed them within the
  // 5-minute stale window, producing repo.status `wasteRate: 1.0` on
  // workloads that don't follow the top-fan-in path. Set > 0 only when
  // the warm set is provably consumed.
  warmTopN: z.number().int().min(0).default(0),
});

export type PrefetchConfig = z.infer<typeof PrefetchConfigSchema>;

export const ObservabilityConfigSchema = z.object({
  enabled: z.boolean().default(true),
  sampleIntervalMs: z.number().int().min(250).max(60000).default(2000),
  retentionShortMinutes: z.number().int().min(1).max(60).default(15),
  retentionLongHours: z.number().int().min(1).max(168).default(24),
  pprMetricsEnabled: z.boolean().default(true),
  packedStatsEnabled: z.boolean().default(true),
  scipIngestMetrics: z.boolean().default(true),
  beamExplainCapacity: z.number().int().min(8).max(2048).default(128),
  beamExplainEntriesPerSlice: z.number().int().min(16).max(8192).default(512),
  sseHeartbeatMs: z.number().int().min(1000).max(60000).default(15000),
  sseMaxStreamMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1000)
    .default(60 * 60 * 1000),
});

export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

export const TracingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  serviceName: z.string().default("sdl-mcp"),
  exporterType: z.enum(["console", "otlp", "memory"]).default("console"),
  otlpEndpoint: z.string().nullish(),
  sampleRate: z.number().min(0).max(1).default(1.0),
});

export type TracingConfig = z.infer<typeof TracingConfigSchema>;

export const ParallelScorerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  poolSize: z.number().int().min(1).max(16).nullish(),
  minBatchSize: z.number().int().min(1).max(100).nullish(),
});

export type ParallelScorerConfig = z.infer<typeof ParallelScorerConfigSchema>;

export const GraphDatabaseConfigSchema = z.object({
  path: z.string().nullish(),
  // Optional override for the LadybugDB buffer-manager size in bytes.
  // Useful for stress tests / low-memory deployments where the auto-sized
  // 25%-of-RAM default is too aggressive.
  // Floor enforced at 1 GB by resolveLadybugBufferManagerSizeBytes().
  bufferPoolBytes: z.number().int().positive().nullish(),
});

export type GraphDatabaseConfig = z.infer<typeof GraphDatabaseConfigSchema>;

export const ConcurrencyConfigSchema = z.object({
  maxSessions: z.number().int().min(1).max(32).default(8),
  maxToolConcurrency: z.number().int().min(1).max(64).default(8),
  readPoolSize: z.number().int().min(1).max(16).default(4),
  writeQueueTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  toolQueueTimeoutMs: z.number().int().min(5000).max(120000).default(30000),
});

export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

export const RuntimeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  allowedRuntimes: z
    .array(z.enum(RUNTIME_NAMES))
    .default(["node", "typescript", "python", "shell"]),
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
  emitLegacyTools: z.boolean().default(false),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const CodeModeConfigSchema = z.object({
  /** Enable Code Mode tools (sdl.manual + sdl.workflow + sdl.context + sdl.file) */
  enabled: z.boolean().default(true),
  /** When true, suppress gateway and legacy tools - only register code-mode tools */
  exclusive: z.boolean().default(true),
  /** Maximum steps allowed in a single workflow */
  maxWorkflowSteps: z.number().int().min(1).max(50).default(20),
  /** Maximum total estimated tokens for a workflow's results */
  maxWorkflowTokens: z.number().int().min(100).max(500_000).default(50_000),
  /** Maximum wall-clock duration for a workflow in milliseconds */
  maxWorkflowDurationMs: z
    .number()
    .int()
    .min(1000)
    .max(300_000)
    .default(60_000),
  /** Context ladder validation: off, warn (add warnings), enforce (reject violations) */
  ladderValidation: z.enum(["off", "warn", "enforce"]).default("warn"),
  /** Auto-inject ifNoneMatch ETags for repeated symbol card requests within a workflow */
  etagCaching: z.boolean().default(true),
});

export type CodeModeConfig = z.infer<typeof CodeModeConfigSchema>;

export const HttpAuthConfigSchema = z.object({
  /** Enable bearer-token authentication for HTTP transport endpoints. */
  enabled: z.boolean().default(false),
  /** Static bearer token. When null/omitted a random token is generated at startup. */
  token: z.string().min(1).nullish().default(null),
  /** Per-client token bucket for protected HTTP routes before bearer-token compare. */
  rateLimit: z
    .object({
      bucketSize: z.number().int().min(1).max(10_000).default(30),
      refillPerSec: z.number().positive().max(1_000).default(0.5),
    })
    .default({ bucketSize: 30, refillPerSec: 0.5 }),
});

export type HttpAuthConfig = z.infer<typeof HttpAuthConfigSchema>;

export const HttpConfigSchema = z.object({
  allowRemote: z.boolean().default(false),
});

export type HttpConfig = z.infer<typeof HttpConfigSchema>;

export const SecurityConfigSchema = z.object({
  allowedRepoRoots: z.array(z.string()).default([]),
});

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export const ScipExternalSymbolsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxPerIndex: z.number().int().min(100).max(100_000).default(10_000),
});

export const ScipIndexEntrySchema = z.object({
  path: z.string(),
  label: z.string().optional(),
});

/**
 * Configuration for the scip-io CLI integration that auto-generates the
 * SCIP index before each refresh. When enabled (and `scip.enabled` is also
 * true), `indexRepo` runs `scip-io index` in the repo root before its own
 * indexing pass; the existing post-refresh ingest then picks up the freshly
 * written `index.scip`.
 *
 * If the binary is not found in PATH and `autoInstall` is true, sdl-mcp
 * downloads the platform-matched binary directly from the scip-io GitHub
 * releases (with SHA-256 verification) into `~/.sdl-mcp/bin/`.
 *
 * All failures are non-fatal: a warning is logged and the indexer continues
 * with whatever `index.scip` is on disk (or none).
 */
export const ScipGeneratorConfigSchema = z.object({
  /** Master enable for the generator. Has no effect unless `scip.enabled` is also true. */
  enabled: z.boolean().default(false),
  /** Override the binary name. Default 'scip-io' (or 'scip-io.exe' on Windows). */
  binary: z.string().default("scip-io"),
  /** Extra args appended after `index` (e.g. ["--no-clean"]). Default []. */
  args: z.array(z.string()).default([]),
  /** Auto-download scip-io from GitHub releases if not found in PATH. */
  autoInstall: z.boolean().default(true),
  /** Hard timeout for the `scip-io index` command. */
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(30 * 60 * 1000)
    .default(10 * 60 * 1000),
  /**
   * Delete the generator-produced `<repoRoot>/index.scip` after the post-
   * refresh ingest has consumed it. The file is regenerated on every
   * refresh so keeping it around just clutters the working tree (and
   * shows up in `git status`). Set to `false` if you want to inspect
   * the file out-of-band or have other tooling that consumes it.
   *
   * Only the default output location is cleaned up — if you pass
   * `--output <custom-path>` via `args` you are on the hook for managing
   * that file's lifecycle yourself.
   */
  cleanupAfterIngest: z.boolean().default(true),
});

export type ScipGeneratorConfig = z.infer<typeof ScipGeneratorConfigSchema>;

export const ScipConfigSchema = z.object({
  enabled: z.boolean().default(false),
  indexes: z.array(ScipIndexEntrySchema).default([]),
  externalSymbols: ScipExternalSymbolsConfigSchema.default({
    enabled: true,
    maxPerIndex: 10_000,
  }),
  confidence: z.number().min(0.5).max(1.0).default(0.95),
  autoIngestOnRefresh: z.boolean().default(true),
  ingestConcurrency: z.number().int().min(1).max(8).default(1),
  generator: ScipGeneratorConfigSchema.default({
    enabled: false,
    binary: "scip-io",
    args: [],
    autoInstall: true,
    timeoutMs: 10 * 60 * 1000,
    cleanupAfterIngest: true,
  }),
});

export type ScipConfig = z.infer<typeof ScipConfigSchema>;

export const PerformanceTierSchema = z.enum(["mid", "high", "extreme", "auto"]);

export const PackedEncoderToggleSchema = z.object({
  enabled: z.boolean().default(true),
});

export const PackedConfigSchema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().min(0).max(1).default(0.1),
  tokenThreshold: z.number().min(0).max(1).default(0.2),
  defaultFormat: z.enum(["packed", "auto", "compact"]).default("auto"),
  encoders: z.record(z.string(), PackedEncoderToggleSchema).optional(),
});
export type PackedConfig = z.infer<typeof PackedConfigSchema>;

export const WireConfigSchema = z.object({
  packed: PackedConfigSchema.optional(),
});
export type WireConfig = z.infer<typeof WireConfigSchema>;
export type PerformanceTier = z.infer<typeof PerformanceTierSchema>;

export const AppConfigSchema = z.object({
  repos: z.array(RepoConfigSchema),
  /**
   * CPU performance tier for auto-tuning concurrency defaults.
   *
   * - "auto" (default): detect hardware at startup and select a tier.
   * - "mid":    conservative defaults (1–8 logical cores).
   * - "high":   moderate scaling (9–20 logical cores).
   * - "extreme": aggressive scaling (21+ logical cores).
   *
   * Presets only affect fields that are NOT explicitly set by the user.
   * Set this to "mid" to opt out of auto-scaling on large machines.
   */
  performanceTier: PerformanceTierSchema.default("auto"),
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
  codeMode: CodeModeConfigSchema.optional(),
  http: HttpConfigSchema.optional(),
  security: SecurityConfigSchema.optional(),
  httpAuth: HttpAuthConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
  scip: ScipConfigSchema.optional(),
  wire: WireConfigSchema.optional(),
  observability: ObservabilityConfigSchema.optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
