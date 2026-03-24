/**
 * graph/ barrel — re-exports the primary public API of the Graph Analysis layer.
 *
 * This module has many sub-modules with specialized exports.
 * Consumers MAY import from individual files for narrower deps,
 * which is the existing convention across the codebase.
 */

// Slice orchestration
export { buildSlice, type SliceBuildInternalResult } from "./slice.js";

// Overview
export { buildRepoOverview, clearOverviewCache } from "./overview.js";

// Symbol card cache
export {
  symbolCardCache,
  makeSymbolCardCacheKey,
  clearAllCaches,
} from "./cache.js";

// Slice cache
export {
  clearSliceCache,
  getCachedSlice,
  setCachedSlice,
  invalidateVersion,
  getSliceCacheStats,
} from "./sliceCache.js";

// Graph snapshot cache
export { invalidateGraphSnapshot } from "./graphSnapshotCache.js";

// Prefetch
export {
  configurePrefetch,
  enqueuePrefetchTask,
  prefetchSliceFrontier,
  prefetchCardsForSymbols,
  prefetchFileExports,
  warmPrefetchOnServeStart,
  consumePrefetchedKey,
  getPrefetchStats,
} from "./prefetch.js";

// Prefetch model
export { recordToolTrace } from "./prefetch-model.js";

// Score
export * as score from "./score.js";

// Clustering & processes
export { computeClustersTS } from "./cluster.js";
export type { ClusterAssignment } from "./cluster-types.js";
export type { ProcessTrace, ProcessTraceStep } from "./process-types.js";

// Metrics
export {
  updateMetricsForRepo,
  computeCanonicalTest,
  calculateRiskScore,
  calculateRiskScoresForSymbols,
  clearTestRefCache,
} from "./metrics.js";

// Graph construction
export {
  loadNeighborhood,
  getNeighbors,
  getPath,
  logGraphTelemetry,
} from "./buildGraph.js";
export type {
  Graph,
  NeighborhoodOptions,
  NeighborhoodEdge,
  NeighborhoodSubgraph,
  GraphLoadStats,
  GraphTelemetryEvent,
} from "./buildGraph.js";

// Min-heap (utility)
export { MinHeap } from "./minHeap.js";
