/**
 * Single subscription point for the observability service.
 *
 * `src/mcp/telemetry.ts` is OWNED by Agent C; this module exposes the tap
 * surface that Agent C will forward into from each `log<EventName>(event)`
 * call site (one line each). When no tap is installed, all forwards are
 * no-ops, so the host is unaffected when observability is disabled.
 *
 * Defensive contract:
 *   - Every method MUST be safe to call when no tap is installed.
 *   - Every method MUST swallow exceptions internally so a metrics bug
 *     never crashes the host.
 */

import type {
  EdgeResolutionTelemetryEvent,
  IndexEvent,
  PolicyDecisionEvent,
  PrefetchTelemetryEvent,
  RuntimeExecutionEvent,
  SemanticSearchTelemetryEvent,
  SetupPipelineEvent,
  SummaryGenerationEvent,
  SummaryQualityTelemetryEvent,
  ToolCallEvent,
  WatcherHealthTelemetryEvent,
} from "../mcp/telemetry.js";

export interface PprTapEvent {
  repoId: string;
  backend: string;
  computeMs: number;
  touched: number;
  seedCount: number;
  iterations?: number;
}

export interface ScipIngestTapEvent {
  repoId: string;
  edgesCreated: number;
  edgesUpgraded: number;
  durationMs: number;
  failed: boolean;
}

export interface PackedWireTapEvent {
  encoderId: string;
  jsonBytes: number;
  packedBytes: number;
  decision: "packed" | "fallback";
  axisHit: "bytes" | "tokens" | null;
}

export interface PoolSampleTapEvent {
  writeQueued: number;
  writeActive: number;
  drainQueueDepth: number;
  drainFailures: number;
}

export interface ResourceSampleTapEvent {
  cpuPct: number;
  rssMb: number;
  heapUsedMb: number;
  /** V8 currently-committed heap (process.memoryUsage().heapTotal), NOT the
   *  --max-old-space-size limit. See bottleneck-classifier.ts for why this
   *  alone is a poor pressure signal. */
  heapTotalMb: number;
  eventLoopLagMs: number;
}

export interface CacheLookupTapEvent {
  repoId?: string;
  source: "card" | "slice" | "summary" | "symbol-map" | "etag";
  /**
   * For single-lookup events, set `hit` and leave `count`/`hits` undefined.
   * For batch events, set `count` (total lookups) and `hits` (subset that hit);
   * `hit` is then ignored. `latencyMs` is the wall-clock for the full batch.
   */
  hit: boolean;
  latencyMs: number;
  count?: number;
  hits?: number;
}

export interface SliceBuildTapEvent {
  repoId?: string;
  durationMs: number;
  accepted: number;
  evicted: number;
  rejected: number;
}

export interface IndexPhaseTapEvent {
  phase: string;
  language?: string;
  durationMs: number;
}

export interface AuditBufferTapEvent {
  /** Current depth of the in-memory audit buffer. */
  depth: number;
  /** Cumulative drops since process start. */
  droppedTotal: number;
  /** True when a post-index write session is currently active. */
  sessionActive: boolean;
}

export interface PostIndexSessionTapEvent {
  sessionId: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ObservabilityTap {
  toolCall(event: ToolCallEvent): void;
  indexEvent(event: IndexEvent): void;
  semanticSearch(event: SemanticSearchTelemetryEvent): void;
  policyDecision(event: PolicyDecisionEvent): void;
  prefetch(event: PrefetchTelemetryEvent): void;
  watcherHealth(event: WatcherHealthTelemetryEvent): void;
  edgeResolution(event: EdgeResolutionTelemetryEvent): void;
  runtimeExecution(event: RuntimeExecutionEvent): void;
  setupPipeline(event: SetupPipelineEvent): void;
  summaryGeneration(event: SummaryGenerationEvent): void;
  summaryQuality(event: SummaryQualityTelemetryEvent): void;
  pprResult(event: PprTapEvent): void;
  scipIngest(event: ScipIngestTapEvent): void;
  packedWire(event: PackedWireTapEvent): void;
  poolSample(event: PoolSampleTapEvent): void;
  resourceSample(event: ResourceSampleTapEvent): void;
  indexPhase(event: IndexPhaseTapEvent): void;
  cacheLookup(event: CacheLookupTapEvent): void;
  sliceBuild(event: SliceBuildTapEvent): void;
  auditBufferSample(event: AuditBufferTapEvent): void;
  postIndexSession(event: PostIndexSessionTapEvent): void;
}

let installedTap: ObservabilityTap | null = null;

/**
 * Install the global observability tap. Replaces any previously installed tap.
 */
export function installObservabilityTap(tap: ObservabilityTap): void {
  installedTap = tap;
}

/**
 * Return the installed tap, or null when disabled.
 */
export function getObservabilityTap(): ObservabilityTap | null {
  return installedTap;
}

/**
 * Clear the installed tap (used by tests + service.stop()).
 */
export function resetObservabilityTap(): void {
  installedTap = null;
}

/**
 * Internal helper that runs a tap method inside try/catch so a metrics bug
 * never crashes the host. Also acts as a no-op when no tap is installed.
 *
 * Agent C should call this from each `log<EventName>` site, e.g.:
 *
 *     forwardToTap((tap) => tap.toolCall(event));
 *
 * to keep telemetry.ts free of inline try/catch boilerplate.
 */

