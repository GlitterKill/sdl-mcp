import * as crypto from "crypto";

import type { RepoId, SymbolId } from "../domain/types.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { getActivePostIndexSession } from "../db/write-session.js";
import { bufferAuditEvent } from "./audit-buffer.js";
import { logger } from "../util/logger.js";
import { getObservabilityTap } from "../observability/event-tap.js";
import { getCurrentTimestamp } from "../util/time.js";
import type { PolicyRequestContext } from "../policy/types.js";
import type { NextBestAction, RequiredFieldsForNext } from "./types.js";
import type { DecisionEvidence } from "./types.js";
import { DB_QUERY_LIMIT_MAX } from "../config/constants.js";
import { safeJsonParse } from "../util/safeJson.js";
import { z } from "zod";

export type ToolRequest = Record<string, unknown>;
export type ToolResponse = {
  error?: { message: string };
} & Record<string, unknown>;

export interface ToolCallEvent {
  tool: string;
  request: ToolRequest;
  response: ToolResponse;
  durationMs: number;
  repoId?: RepoId;
  symbolId?: SymbolId;
  tokensUsed?: number;
  tokensSaved?: number;
}

export interface CodeWindowDecisionEvent {
  symbolId: SymbolId;
  approved: boolean;
  reason: string[];
}

export interface IndexStats {
  filesScanned: number;
  symbolsExtracted: number;
  edgesExtracted: number;
  durationMs: number;
  errors: number;
  /**
   * Phase 1 Task 1.12 — Per-language Pass-1 engine telemetry.
   *
   * Counts which Pass-1 engine processed each file. Optional so existing
   * call sites (and historical audit events) remain valid. When present,
   * `rustFiles + tsFiles` equals the number of files Pass-1 attempted,
   * and `rustFallbackFiles` is the subset of files routed from the Rust
   * engine to the TypeScript engine because of an unsupported language.
   * `perLanguageFallback` breaks that subset down by file extension.
   */
  pass1Engine?: {
    rustFiles: number;
    tsFiles: number;
    rustFallbackFiles: number;
    perLanguageFallback: Record<string, number>;
  };
}

export interface IndexEvent {
  repoId: RepoId;
  versionId: string;
  stats: IndexStats;
}

export interface PolicyDecisionEvent {
  requestType: string;
  repoId: RepoId;
  symbolId?: SymbolId;
  decision: string;
  auditHash: string;
  evidenceUsed: DecisionEvidence[];
  deniedReasons?: string[];
  nextBestAction?: NextBestAction;
  requiredFieldsForNext?: RequiredFieldsForNext;
  downgradeTarget?: {
    type: "skeleton" | "hotpath";
    symbolId: string;
    repoId: string;
  };
  context?: PolicyRequestContext;
}

export interface SetupPipelineEvent {
  repoId: RepoId;
  nonInteractive: boolean;
  autoIndex: boolean;
  dryRun: boolean;
  durationMs: number;
  languages: string[];
  configPath: string;
}

export interface SummaryGenerationEvent {
  repoId: RepoId;
  query: string;
  scope: string;
  format: string;
  budget: number;
  summaryTokens: number;
  truncated: boolean;
  durationMs: number;
}

export interface WatcherHealthTelemetryEvent {
  repoId: RepoId;
  enabled: boolean;
  running: boolean;
  stale: boolean;
  errors: number;
  queueDepth: number;
  eventsReceived: number;
  eventsProcessed: number;
  /** Cumulative restarts since service start. */
  restartCount?: number;
}

export interface EdgeResolutionTelemetryEvent {
  repoId: RepoId;
  language: string;
  precision: number;
  recall: number;
  f1: number;
  strategyAccuracy: number;
}

export interface SemanticSearchTelemetryEvent {
  repoId: RepoId;
  semanticEnabled: boolean;
  latencyMs: number;
  candidateCount: number;
  alpha: number;
  /** Retrieval mode used: "legacy" (rerank) or "hybrid" (FTS+vector+RRF) */
  retrievalMode?: "legacy" | "hybrid";
  /** Per-source candidate counts before fusion (e.g. { fts: 50, "vector:jinacode": 30 }) */
  candidateCountPerSource?: Record<string, number>;
  /** Time spent in RRF fusion step (ms) */
  fusionLatencyMs?: number;
  /** Whether FTS extension was available */
  ftsAvailable?: boolean;
  /** Whether vector extension was available */
  vectorAvailable?: boolean;
  /** Reason for falling back to legacy, if applicable */
  fallbackReason?: string;
  /** Final result count after fusion and limiting */
  finalResultCount?: number;

  /**
   * Normalized retrieval type for dashboards.
   * Replaces the legacy "semantic rerank" terminology.
   * Values: "hybrid" (FTS+vector+RRF), "legacy-rerank", "lexical-only"
   */
  retrievalType?: "hybrid" | "legacy-rerank" | "lexical-only";

  /** Number of symbols boosted by prior feedback. */
  feedbackBoostedCount?: number;
}

export interface SummaryQualityTelemetryEvent {
  repoId: RepoId;
  provider: string;
  divergenceScore: number;
  costUsd: number;
}

export interface PrefetchTelemetryEvent {
  repoId: RepoId;
  hitRate: number;
  wasteRate: number;
  avgLatencyReductionMs: number;
  queueDepth: number;
}

export interface AuditEvent {
  eventId: string;
  timestamp: string;
  tool: string;
  decision: string;
  repoId: string | null;
  symbolId: string | null;
  details: Record<string, unknown>;
}

function generateAuditEventId(): string {
  return `audit_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

function buildIndexEventDetails(event: IndexEvent): string {
  return JSON.stringify({
    versionId: event.versionId,
    ...event.stats,
  });
}

function logIndexEventInfo(event: IndexEvent): void {
  logger.info(`Index event logged: ${event.repoId}`, {
    versionId: event.versionId,
    stats: event.stats,
  });
}

async function recordAuditEvent(event: {
  tool: string;
  decision: string;
  repoId?: string;
  symbolId?: string;
  detailsJson: string;
}): Promise<void> {
  const row = {
    eventId: generateAuditEventId(),
    timestamp: getCurrentTimestamp(),
    tool: event.tool,
    decision: event.decision,
    repoId: event.repoId ?? null,
    symbolId: event.symbolId ?? null,
    detailsJson: event.detailsJson,
  };
  // Route through the audit buffer when a post-index session is in flight.
  // The session holds the writeLimiter slot end-to-end; calling withWriteConn
  // here would queue for the entire session duration and likely hit
  // queueTimeoutMs. The session-end hook drains the buffer using the
  // session's conn so audits land before the next writer can interleave.
  if (getActivePostIndexSession()) {
    if (!bufferAuditEvent(row)) {
      // Buffer full; surface the drop synchronously so the first event is
      // never silent. audit-buffer's own per-N log won't fire until N drops
      // have accumulated, but operators need immediate visibility for
      // compliance.
      logger.error(
        `[telemetry] Audit event dropped (buffer full) tool=${row.tool} decision=${row.decision} eventId=${row.eventId}`,
      );
    }
    return;
  }
  try {
    await withWriteConn(async (wConn) => {
      await ladybugDb.insertAuditEvent(wConn, row);
    });
  } catch (err) {
    logger.error(`Failed to log audit event: ${String(err)}`);
  }
}

export function logToolCall(event: ToolCallEvent): void {
  const decision = event.response.error ? "error" : "success";

  // Fire-and-forget async logging
  void recordAuditEvent({
    tool: event.tool,
    decision,
    repoId: event.repoId,
    symbolId: event.symbolId,
    detailsJson: JSON.stringify({
      request: event.request,
      response: event.response,
      durationMs: event.durationMs,
    }),
  }).catch((err) =>
    logger.warn(`Audit write failed for ${event.tool}: ${String(err)}`),
  );

  logger.info(`Tool call logged: ${event.tool}`, {
    decision,
    durationMs: event.durationMs,
  });

  try { getObservabilityTap()?.toolCall(event); } catch (err) { logger.warn("observability tap error", { error: err instanceof Error ? err.message : String(err) }); }
}

export function logCodeWindowDecision(event: CodeWindowDecisionEvent): void {
  const decision = event.approved ? "approved" : "denied";

  void recordAuditEvent({
    tool: "code.needWindow",
    decision,
    symbolId: event.symbolId,
    detailsJson: JSON.stringify({
      approved: event.approved,
      reason: event.reason,
    }),
  }).catch((err) =>
    logger.warn(`Audit write failed for code.needWindow: ${String(err)}`),
  );

  logger.info(`Code window decision: ${decision}`, {
    symbolId: event.symbolId,
    reason: event.reason,
  });
}

export function logIndexEvent(event: IndexEvent): void {
  void recordAuditEvent({
    tool: "index.refresh",
    decision: "success",
    repoId: event.repoId,
    detailsJson: buildIndexEventDetails(event),
  }).catch((err) =>
    logger.warn(`Audit write failed for index.refresh: ${String(err)}`),
  );

  logIndexEventInfo(event);

  try { getObservabilityTap()?.indexEvent(event); } catch (err) { logger.warn("observability tap error", { error: err instanceof Error ? err.message : String(err) }); }
}

export async function flushIndexEvent(event: IndexEvent): Promise<void> {
  await recordAuditEvent({
    tool: "index.refresh",
    decision: "success",
    repoId: event.repoId,
    detailsJson: buildIndexEventDetails(event),
  });

  logIndexEventInfo(event);
}

export async function getAuditTrail(
  repoId?: RepoId,
  limit?: number,
): Promise<AuditEvent[]> {
  const conn = await getLadybugConn();
  const events = await ladybugDb.getAuditEvents(conn, {
    repoId,
    limit: limit ?? DB_QUERY_LIMIT_MAX,
  });

  return events.map((event) => ({
    eventId: event.eventId,
    timestamp: event.timestamp,
    tool: event.tool,
    decision: event.decision,
    repoId: event.repoId,
    symbolId: event.symbolId,
    details: safeJsonParse(event.detailsJson, z.record(z.string(), z.unknown()), {}),
  }));
}

export function logPolicyDecision(event: PolicyDecisionEvent): void {
  const {
    decision,
    auditHash,
    evidenceUsed,
    deniedReasons,
    nextBestAction,
    requiredFieldsForNext,
    downgradeTarget,
    ...rest
  } = event;

  void recordAuditEvent({
    tool: `policy.${rest.requestType}`,
    decision,
    repoId: event.repoId,
    symbolId: event.symbolId,
    detailsJson: JSON.stringify({
      auditHash,
      evidenceUsed,
      deniedReasons,
      nextBestAction,
      requiredFieldsForNext,
      downgradeTarget,
      context: rest.context,
    }),
  }).catch((err) =>
    logger.warn(
      `Audit write failed for policy.${rest.requestType}: ${String(err)}`,
    ),
  );

  logger.info(`Policy decision: ${decision}`, {
    requestType: rest.requestType,
    repoId: event.repoId,
    symbolId: event.symbolId,
    auditHash,
    nextBestAction,
  });

  try { getObservabilityTap()?.policyDecision(event); } catch (err) { logger.warn("observability tap error", { error: err instanceof Error ? err.message : String(err) }); }
}

export function logSetupPipelineEvent(event: SetupPipelineEvent): void {
  void recordAuditEvent({
    tool: "phaseA.setup",
    decision: "success",
    repoId: event.repoId,
    detailsJson: JSON.stringify(event),
  }).catch((err) =>
    logger.warn(`Audit write failed for phaseA.setup: ${String(err)}`),
  );

  try { getObservabilityTap()?.setupPipeline(event); } catch (err) { logger.warn("observability tap error", { error: err instanceof Error ? err.message : String(err) }); }
}

export function logSummaryGenerationEvent(event: SummaryGenerationEvent): void {
  void recordAuditEvent({
    tool: "phaseA.summary",
    decision: "success",
    repoId: event.repoId,
    detailsJson: JSON.stringify(event),
  }).catch((err) =>
    logger.warn(`Audit write failed for phaseA.summary: ${String(err)}`),
  );

  try { getObservabilityTap()?.summaryGeneration(event); } catch (err) { logger.warn("observability tap error", { error: err instanceof Error ? err.message : String(err) }); }
}

export function logWatcherHealthTelemetry(
  event: WatcherHealthTelemetryEvent,
): void {
  void recordAuditEvent({
    tool: "phaseA.watcher",
    decision: event.stale || event.errors > 0 ? "warn" : "success",
    repoId: event.repoId,
    detailsJson: JSON.stringify(event),
  }).catch((err) =>
    logger.warn(`Audit write failed for phaseA.watcher: ${String(err)}`),
  );

  try { getObservabilityTap()?.watcherHealth(event); } catch (err) { logger.warn("observability tap error", { error: err instanceof Error ? err.message : String(err) }); }
}

export function logEdgeResolutionTelemetry(
  event: EdgeResolutionTelemetryEvent,
): void {
  logger.info("Edge resolution benchmark", {
    eventType: "edge_resolution",
    timestamp: getCurrentTimestamp(),
    repoId: event.repoId,
    language: event.language,
    precision: event.precision,
    recall: event.recall,
    f1: event.f1,
    strategyAccuracy: event.strategyAccuracy,
  });

  try { getObservabilityTap()?.edgeResolution(event); } catch (err) { logger.warn("observability tap error", { error: err instanceof Error ? err.message : String(err) }); }
}

export function logSemanticSearchTelemetry(
  event: SemanticSearchTelemetryEvent,
): void {
  const fields: Record<string, unknown> = {
    eventType: "semantic_search",
    timestamp: getCurrentTimestamp(),
    repoId: event.repoId,
    semanticEnabled: event.semanticEnabled,
    latencyMs: event.latencyMs,
    candidateCount: event.candidateCount,
    alpha: event.alpha,
  };

  if (event.retrievalMode !== undefined) {
    fields.retrievalMode = event.retrievalMode;
  }
  if (event.candidateCountPerSource !== undefined) {
    fields.candidateCountPerSource = event.candidateCountPerSource;
  }
  if (event.fusionLatencyMs !== undefined) {
    fields.fusionLatencyMs = event.fusionLatencyMs;
  }
  if (event.ftsAvailable !== undefined) {
    fields.ftsAvailable = event.ftsAvailable;
  }
  if (event.vectorAvailable !== undefined) {
    fields.vectorAvailable = event.vectorAvailable;
  }
  if (event.fallbackReason !== undefined) {
    fields.fallbackReason = event.fallbackReason;
  }
  if (event.finalResultCount !== undefined) {
    fields.finalResultCount = event.finalResultCount;
  }
  if (event.retrievalType !== undefined) {
    fields.retrievalType = event.retrievalType;
  }
  if (event.feedbackBoostedCount !== undefined) {
    fields.feedbackBoostedCount = event.feedbackBoostedCount;
  }

  logger.info("Semantic search", fields);

  try { getObservabilityTap()?.semanticSearch(event); } catch (err) { logger.warn("observability tap error", { error: err instanceof Error ? err.message : String(err) }); }
}

export function logSummaryQualityTelemetry(
  event: SummaryQualityTelemetryEvent,
): void {
  logger.info("Generated summary quality", {
    eventType: "summary_quality",
    timestamp: getCurrentTimestamp(),
    repoId: event.repoId,
    provider: event.provider,
    divergenceScore: event.divergenceScore,
    costUsd: event.costUsd,
  });

  try { getObservabilityTap()?.summaryQuality(event); } catch (err) { logger.warn("observability tap error", { error: err instanceof Error ? err.message : String(err) }); }
}

export function logPrefetchTelemetry(event: PrefetchTelemetryEvent): void {
  logger.info("Prefetch metrics", {
    eventType: "prefetch_metrics",
    timestamp: getCurrentTimestamp(),
    repoId: event.repoId,
    hitRate: event.hitRate,
    wasteRate: event.wasteRate,
    avgLatencyReductionMs: event.avgLatencyReductionMs,
    queueDepth: event.queueDepth,
  });

  try { getObservabilityTap()?.prefetch(event); } catch (err) { logger.warn("observability tap error", { error: err instanceof Error ? err.message : String(err) }); }
}

// ============================================================================
// Runtime Execution Telemetry
// ============================================================================

export interface RuntimeExecutionEvent {
  repoId: RepoId;
  runtime: string;
  executable: string;
  exitCode: number | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  policyDecision: string;
  auditHash: string;
  artifactHandle: string | null;
}

/**
 * Log a runtime execution event to the audit trail.
 * Never logs: raw stdout/stderr, env values, full args, code content.
 */
export function logRuntimeExecution(event: RuntimeExecutionEvent): void {
  const decision = event.exitCode === 0 ? "success" : "error";

  void recordAuditEvent({
    tool: "runtime.execute",
    decision,
    repoId: event.repoId,
    detailsJson: JSON.stringify({
      runtime: event.runtime,
      executable: event.executable,
      exitCode: event.exitCode,
      durationMs: event.durationMs,
      stdoutBytes: event.stdoutBytes,
      stderrBytes: event.stderrBytes,
      timedOut: event.timedOut,
      policyDecision: event.policyDecision,
      auditHash: event.auditHash,
      artifactHandle: event.artifactHandle,
    }),
  }).catch((err) =>
    logger.warn(`Audit write failed for runtime.execute: ${String(err)}`),
  );

  logger.info("Runtime execution", {
    eventType: "runtime_execution",
    timestamp: getCurrentTimestamp(),
    repoId: event.repoId,
    runtime: event.runtime,
    exitCode: event.exitCode,
    durationMs: event.durationMs,
    timedOut: event.timedOut,
    policyDecision: event.policyDecision,
  });

  try { getObservabilityTap()?.runtimeExecution(event); } catch (err) { logger.warn("observability tap error", { error: err instanceof Error ? err.message : String(err) }); }
}
