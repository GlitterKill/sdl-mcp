/**
 * Public surface of the observability dashboard module.
 *
 * Only public types, the service class/factory, the event-tap surface, and
 * the bottleneck classifier are re-exported here. Internal aggregator state,
 * ring-buffer internals, and helper utilities deliberately stay private.
 */
export type {
  BeamDecision,
  BeamEdgeType,
  BeamExplainEntry,
  BeamExplainResponse,
  BeamScoreComponents,
  BeamSummary,
  BottleneckClass,
  BottleneckSummary,
  CacheMetrics,
  CacheSourceMetrics,
  HealthMetrics,
  IndexingMetrics,
  LatencyMetrics,
  LatencyPerTool,
  ObservabilitySnapshot,
  PackedWireMetrics,
  PoolMetrics,
  PprMetrics,
  ResourceMetrics,
  RetrievalMetrics,
  ScipMetrics,
  TimeseriesPoint,
  TimeseriesResponse,
  TimeseriesWindow,
  TokenEfficiencyMetrics,
  ToolVolume,
} from "./types.js";
export { BEAM_EXPLAIN_MAX_ENTRIES } from "./types.js";

export type {
  CacheLookupTapEvent,
  IndexPhaseTapEvent,
  ObservabilityTap,
  PackedWireTapEvent,
  PoolSampleTapEvent,
  PprTapEvent,
  ResourceSampleTapEvent,
  ScipIngestTapEvent,
  SliceBuildTapEvent,
} from "./event-tap.js";
export {
  getObservabilityTap,
  installObservabilityTap,
  resetObservabilityTap,
} from "./event-tap.js";

export { classifyBottleneck } from "./bottleneck-classifier.js";

export type { BeamExplainStoreLike } from "./service.js";
export { ObservabilityService, createObservabilityService } from "./service.js";


// ---- Beam-explain store registry (Agent B) ----
//
// The slice-build path needs a lightweight way to discover the active
// BeamExplainStore without taking a hard dependency on the
// ObservabilityService construction order. The MCP server startup wires
// the store via setBeamExplainStore(); slice.ts reads via
// getBeamExplainStore(). Lookups MUST never throw — callers expect null
// when observability is disabled or not yet initialized.

import type { BeamExplainStore } from "./beam-explain-store.js";

export { BeamExplainStore } from "./beam-explain-store.js";
export type { BeamExplainStoreConfig } from "./beam-explain-store.js";

let beamExplainStoreSingleton: BeamExplainStore | null = null;

/** Register the active beam-explain store (called once at MCP server startup). */
export function setBeamExplainStore(store: BeamExplainStore | null): void {
  beamExplainStoreSingleton = store;
}

/** Best-effort lookup; returns null when observability is disabled or not yet initialized. */
export function getBeamExplainStore(): BeamExplainStore | null {
  return beamExplainStoreSingleton;
}

// ---- Runtime probes (Agent C) ----
export { startRuntimeProbes, stopRuntimeProbes } from "./probes.js";
