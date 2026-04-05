/**
 * ladybug-queries.ts � Barrel re-export for backward compatibility
 *
 * This file was split into domain-specific modules as part of the v0.8.0 refactor.
 * All 62 importers continue to work unchanged via this barrel.
 *
 * Domain modules:
 *   ladybug-core.ts       � Shared helpers (exec, queryAll, querySingle, toNumber, etc.)
 *   ladybug-repos.ts      � Repository & File operations
 *   ladybug-symbols.ts    � Symbol operations
 *   ladybug-edges.ts      � Edge (dependency) operations
 *   ladybug-versions.ts   � Version & snapshot operations
 *   ladybug-slices.ts     � Slice handle operations
 *   ladybug-metrics.ts    � Metrics operations
 *   ladybug-feedback.ts   � Audit & agent feedback operations
 *   ladybug-embeddings.ts � Symbol embeddings, summary cache, sync artifacts, symbol references
 *   ladybug-config.ts     � Tool policy & tsconfig hash operations
 *   ladybug-clusters.ts   � Cluster operations
 *   ladybug-processes.ts   Process operations
 *   ladybug-file-summaries.ts FileSummary operations
 *   ladybug-scip.ts          SCIP ingestion operations
 */

// Core helpers
export {
  exec,
  queryAll,
  querySingle,
  toNumber,
  toBoolean,
  withTransaction,
  assertSafeInt,
  getPreparedStatement,
} from "./ladybug-core.js";

// Repository & File operations
export * from "./ladybug-repos.js";

// Symbol operations
export * from "./ladybug-symbols.js";

// Edge operations
export * from "./ladybug-edges.js";

// Version operations
export * from "./ladybug-versions.js";

// Slice handle operations
export * from "./ladybug-slices.js";

// Metrics operations
export * from "./ladybug-metrics.js";

// Audit & agent feedback operations
export * from "./ladybug-feedback.js";

// Symbol embeddings, summary cache, sync artifacts, symbol references
export * from "./ladybug-embeddings.js";

// Model-aware Symbol node embedding helpers (replaces SymbolEmbedding table access)
export * from "./ladybug-symbol-embeddings.js";

// Tool policy & tsconfig hash operations
export * from "./ladybug-config.js";

// Cluster operations
export * from "./ladybug-clusters.js";

// Process operations
export * from "./ladybug-processes.js";

// Memory operations
export * from "./ladybug-memory.js";

// Usage snapshot operations
export * from "./ladybug-usage.js";

// FileSummary operations
export * from "./ladybug-file-summaries.js";

// SCIP ingestion operations
export * from "./ladybug-scip.js";
