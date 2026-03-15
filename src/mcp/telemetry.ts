import * as crypto from "crypto";

import type { RepoId, SymbolId } from "../db/schema.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";
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

async function recordAuditEvent(event: {
  tool: string;
  decision: string;
  repoId?: string;
  symbolId?: string;
  detailsJson: string;
}): Promise<void> {
  try {
    await withWriteConn(async (wConn) => {
      await ladybugDb.insertAuditEvent(wConn, {
        eventId: generateAuditEventId(),
        timestamp: getCurrentTimestamp(),
        tool: event.tool,
        decision: event.decision,
        repoId: event.repoId ?? null,
        symbolId: event.symbolId ?? null,
        detailsJson: event.detailsJson,
      });
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
  });

  logger.info(`Tool call logged: ${event.tool}`, {
    decision,
    durationMs: event.durationMs,
  });
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
  });

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
    detailsJson: JSON.stringify({
      versionId: event.versionId,
      ...event.stats,
    }),
  });

  logger.info(`Index event logged: ${event.repoId}`, {
    versionId: event.versionId,
    stats: event.stats,
  });
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
    details: safeJsonParse(event.detailsJson, z.record(z.unknown()), {}),
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
  });

  logger.info(`Policy decision: ${decision}`, {
    requestType: rest.requestType,
    repoId: event.repoId,
    symbolId: event.symbolId,
    auditHash,
    nextBestAction,
  });
}

export function logSetupPipelineEvent(event: SetupPipelineEvent): void {
  void recordAuditEvent({
    tool: "phaseA.setup",
    decision: "success",
    repoId: event.repoId,
    detailsJson: JSON.stringify(event),
  });
}

export function logSummaryGenerationEvent(event: SummaryGenerationEvent): void {
  void recordAuditEvent({
    tool: "phaseA.summary",
    decision: "success",
    repoId: event.repoId,
    detailsJson: JSON.stringify(event),
  });
}

export function logWatcherHealthTelemetry(
  event: WatcherHealthTelemetryEvent,
): void {
  void recordAuditEvent({
    tool: "phaseA.watcher",
    decision: event.stale || event.errors > 0 ? "warn" : "success",
    repoId: event.repoId,
    detailsJson: JSON.stringify(event),
  });
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
}

export function logSemanticSearchTelemetry(
  event: SemanticSearchTelemetryEvent,
): void {
  logger.info("Semantic search", {
    eventType: "semantic_search",
    timestamp: getCurrentTimestamp(),
    repoId: event.repoId,
    semanticEnabled: event.semanticEnabled,
    latencyMs: event.latencyMs,
    candidateCount: event.candidateCount,
    alpha: event.alpha,
  });
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
  });

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
}
