import type { RepoId, SymbolId } from "../db/schema.js";
import { logger } from "../util/logger.js";
import { getCurrentTimestamp } from "../util/time.js";
import type { PolicyRequestContext } from "../policy/types.js";
import type { NextBestAction, RequiredFieldsForNext } from "./types.js";
import type { DecisionEvidence } from "./types.js";
import { DB_QUERY_LIMIT_MAX } from "../config/constants.js";

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
  eventId: number;
  timestamp: string;
  tool: string;
  decision: string;
  repoId: string | null;
  symbolId: string | null;
  details: Record<string, unknown>;
}

// Lazy import to avoid loading queries.ts before migrations run
let _queries: typeof import("../db/queries.js") | null = null;
async function getQueries() {
  if (!_queries) {
    _queries = await import("../db/queries.js");
  }
  return _queries;
}

export function logToolCall(event: ToolCallEvent): void {
  const decision = event.response.error ? "error" : "success";

  // Fire-and-forget async logging
  getQueries()
    .then((queries) => {
      queries.logAuditEvent({
        timestamp: getCurrentTimestamp(),
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
    })
    .catch((err) => {
      logger.error(`Failed to log audit event: ${err}`);
    });

  logger.info(`Tool call logged: ${event.tool}`, {
    decision,
    durationMs: event.durationMs,
  });
}

export function logCodeWindowDecision(event: CodeWindowDecisionEvent): void {
  const decision = event.approved ? "approved" : "denied";

  getQueries()
    .then((queries) => {
      queries.logAuditEvent({
        timestamp: getCurrentTimestamp(),
        tool: "code.needWindow",
        decision,
        symbolId: event.symbolId,
        detailsJson: JSON.stringify({
          approved: event.approved,
          reason: event.reason,
        }),
      });
    })
    .catch((err) => {
      logger.error(`Failed to log audit event: ${err}`);
    });

  logger.info(`Code window decision: ${decision}`, {
    symbolId: event.symbolId,
    reason: event.reason,
  });
}

export function logIndexEvent(event: IndexEvent): void {
  getQueries()
    .then((queries) => {
      queries.logAuditEvent({
        timestamp: getCurrentTimestamp(),
        tool: "index.refresh",
        decision: "success",
        repoId: event.repoId,
        detailsJson: JSON.stringify({
          versionId: event.versionId,
          ...event.stats,
        }),
      });
    })
    .catch((err) => {
      logger.error(`Failed to log audit event: ${err}`);
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
  const queries = await getQueries();
  const events = queries.getAuditEvents(repoId, limit ?? DB_QUERY_LIMIT_MAX);

  return events.map((event) => ({
    eventId: event.event_id,
    timestamp: event.timestamp,
    tool: event.tool,
    decision: event.decision,
    repoId: event.repo_id,
    symbolId: event.symbol_id,
    details: JSON.parse(event.details_json),
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

  getQueries()
    .then((queries) => {
      queries.logAuditEvent({
        timestamp: getCurrentTimestamp(),
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
    })
    .catch((err) => {
      logger.error(`Failed to log audit event: ${err}`);
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
  getQueries()
    .then((queries) => {
      queries.logAuditEvent({
        timestamp: getCurrentTimestamp(),
        tool: "phaseA.setup",
        decision: "success",
        repoId: event.repoId,
        detailsJson: JSON.stringify(event),
      });
    })
    .catch((err) => {
      logger.error(`Failed to log setup pipeline event: ${err}`);
    });
}

export function logSummaryGenerationEvent(event: SummaryGenerationEvent): void {
  getQueries()
    .then((queries) => {
      queries.logAuditEvent({
        timestamp: getCurrentTimestamp(),
        tool: "phaseA.summary",
        decision: "success",
        repoId: event.repoId,
        detailsJson: JSON.stringify(event),
      });
    })
    .catch((err) => {
      logger.error(`Failed to log summary generation event: ${err}`);
    });
}

export function logWatcherHealthTelemetry(
  event: WatcherHealthTelemetryEvent,
): void {
  getQueries()
    .then((queries) => {
      queries.logAuditEvent({
        timestamp: getCurrentTimestamp(),
        tool: "phaseA.watcher",
        decision: event.stale || event.errors > 0 ? "warn" : "success",
        repoId: event.repoId,
        detailsJson: JSON.stringify(event),
      });
    })
    .catch((err) => {
      logger.error(`Failed to log watcher telemetry event: ${err}`);
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
