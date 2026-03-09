/**
 * kuzu-queries.ts — Barrel re-export for backward compatibility
 *
 * This file was split into domain-specific modules as part of the v0.8.0 refactor.
 * All 62 importers continue to work unchanged via this barrel.
 *
 * Domain modules:
 *   kuzu-core.ts       — Shared helpers (exec, queryAll, querySingle, toNumber, etc.)
 *   kuzu-repos.ts      — Repository & File operations
 *   kuzu-symbols.ts    — Symbol operations
 *   kuzu-edges.ts      — Edge (dependency) operations
 *   kuzu-versions.ts   — Version & snapshot operations
 *   kuzu-slices.ts     — Slice handle operations
 *   kuzu-metrics.ts    — Metrics operations
 *   kuzu-feedback.ts   — Audit & agent feedback operations
 *   kuzu-embeddings.ts — Symbol embeddings, summary cache, sync artifacts, symbol references
 *   kuzu-config.ts     — Tool policy & tsconfig hash operations
 *   kuzu-clusters.ts   — Cluster operations
 *   kuzu-processes.ts  — Process operations
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
} from "./kuzu-core.js";

// Repository & File operations
export * from "./kuzu-repos.js";

// Symbol operations
export * from "./kuzu-symbols.js";

// Edge operations
export * from "./kuzu-edges.js";

// Version operations
export * from "./kuzu-versions.js";

// Slice handle operations
export * from "./kuzu-slices.js";

// Metrics operations
export * from "./kuzu-metrics.js";

// Audit & agent feedback operations
export * from "./kuzu-feedback.js";

// Symbol embeddings, summary cache, sync artifacts, symbol references
export * from "./kuzu-embeddings.js";

// Tool policy & tsconfig hash operations
export * from "./kuzu-config.js";

// Cluster operations
export * from "./kuzu-clusters.js";

// Process operations
export * from "./kuzu-processes.js";
