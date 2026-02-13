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
  packageJsonPath: z.string().optional(),
  tsconfigPath: z.string().optional(),
  workspaceGlobs: z.array(z.string()).optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const PolicyConfigSchema = z.object({
  maxWindowLines: z.number().int().min(1).default(DEFAULT_MAX_WINDOW_LINES),
  maxWindowTokens: z.number().int().min(1).default(DEFAULT_MAX_WINDOW_TOKENS),
  requireIdentifiers: z.boolean().default(true),
  allowBreakGlass: z.boolean().default(true),
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
  enableFileWatching: z.boolean().default(false),
  workerPoolSize: z.number().int().min(1).max(16).optional(),
});

export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;

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

export const AppConfigSchema = z.object({
  repos: z.array(RepoConfigSchema),
  dbPath: z.string().min(1),
  policy: PolicyConfigSchema,
  redaction: RedactionConfigSchema.optional(),
  indexing: IndexingConfigSchema.optional(),
  slice: SliceConfigSchema.optional(),
  diagnostics: DiagnosticsConfigSchema.optional(),
  cache: CacheConfigSchema.optional(),
  plugins: PluginConfigSchema.optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
