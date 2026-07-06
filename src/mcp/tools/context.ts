import { contextEngine } from "../../agent/context-engine.js";
import { loadConfig } from "../../config/loadConfig.js";
import type { AgentTask } from "../../agent/types.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { normalizePath } from "../../util/paths.js";
import { IndexError, ValidationError } from "../errors.js";
import { attachRawContext } from "../token-usage.js";
import {
  serializeContextForWireFormat,
  publishContextWireDecision,
  type ContextWireResult,
} from "./context-wire-format.js";
import {
  AgentContextRequestSchema,
  type AgentContextResponse,
} from "../tools.js";
import { ZodError } from "zod";
import { buildConditionalResponse } from "../../util/conditional-response.js";
import { hashContent } from "../../util/hashing.js";
import type { ToolContext } from "../../server.js";
import { sessionContentLedger } from "../session-dedupe.js";
import {
  projectCardForTask,
  projectSymbolCardEvidenceForTask,
} from "../context-response-projection.js";
import {
  maybeCompressToolResponse,
  recordTokenSavings,
} from "../response-compression.js";
import {
  attachTimingDiagnostics,
  ToolPhaseTimer,
} from "../timing-diagnostics.js";

const BYTES_PER_TOKEN = 4;
const SYMBOL_ID_PATTERN = /^[a-f0-9]{64}$/i;
const MIN_RAW_TOKENS_PER_CONTEXT_RESULT = 300;

interface EvidenceSourceCandidates {
  symbolIds: Set<string>;
  relPaths: Set<string>;
}

export interface ContextRawTokenSources {
  symbolIds: Set<string>;
  relPaths: Set<string>;
  evidenceCount: number;
  evidenceSources: EvidenceSourceCandidates[];
}

export interface ContextRawEquivalentInput {
  fileRawTokens: number;
  evidenceCount: number;
  resolvedEvidenceCount: number;
}
function stripVolatileEvidenceFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripVolatileEvidenceFields(entry));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const stableEntries = Object.entries(record)
      .filter(([key]) => key !== "timestamp")
      .map(([key, entryValue]) => [
        key,
        stripVolatileEvidenceFields(entryValue),
      ]);
    return Object.fromEntries(stableEntries);
  }

  return value;
}

function buildStableAgentContextValue(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const actionsTaken = Array.isArray(response.actionsTaken)
    ? response.actionsTaken.map((action) => {
        if (!action || typeof action !== "object") return action;
        const entry = action as Record<string, unknown>;
        return {
          type: entry.type,
          status: entry.status,
          input: entry.input,
          output: entry.output,
          error: entry.error,
          evidence: stripVolatileEvidenceFields(entry.evidence),
        };
      })
    : [];

  const finalEvidence = Array.isArray(response.finalEvidence)
    ? response.finalEvidence.map((item) => {
        if (!item || typeof item !== "object") return item;
        const entry = item as Record<string, unknown>;
        return {
          type: entry.type,
          reference: entry.reference,
          summary: entry.summary,
        };
      })
    : [];

  const metrics =
    response.metrics && typeof response.metrics === "object"
      ? (() => {
          const entry = response.metrics as Record<string, unknown>;
          return {
            totalTokens: entry.totalTokens,
            totalActions: entry.totalActions,
            successfulActions: entry.successfulActions,
            failedActions: entry.failedActions,
            cacheHits: entry.cacheHits,
          };
        })()
      : undefined;

  return {
    taskType: response.taskType,
    actionsTaken,
    path: response.path,
    contextModeHint: response.contextModeHint,
    finalEvidence,
    summary: response.summary,
    success: response.success,
    error: response.error,
    metrics,
    answer: response.answer,
    nextBestAction: response.nextBestAction,
    retrievalEvidence: stripVolatileEvidenceFields(response.retrievalEvidence),
  };
}

function sanitizePhaseSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function recordContextSubTimings(
  timer: ToolPhaseTimer,
  response: Extract<AgentContextResponse, { taskId: string }>,
): void {
  const diagnosticTimings = (response as Record<string, unknown>)
    .diagnosticTimings;
  if (diagnosticTimings && typeof diagnosticTimings === "object") {
    for (const [phase, durationMs] of Object.entries(
      diagnosticTimings as Record<string, unknown>,
    )) {
      if (typeof durationMs === "number") {
        timer.add(`context.${sanitizePhaseSegment(phase)}`, durationMs);
      }
    }
    delete (response as Record<string, unknown>).diagnosticTimings;
  }
  for (const action of response.actionsTaken ?? []) {
    timer.add(
      `context.action.${sanitizePhaseSegment(action.type)}`,
      action.durationMs,
    );
  }
  const fusionLatencyMs = response.retrievalEvidence?.fusionLatencyMs;
  if (typeof fusionLatencyMs === "number") {
    timer.add("context.retrievalFusion", fusionLatencyMs);
  }
  const retrievalTimings = response.retrievalEvidence?.diagnosticTimings;
  if (retrievalTimings && typeof retrievalTimings === "object") {
    for (const [phase, durationMs] of Object.entries(retrievalTimings)) {
      if (typeof durationMs === "number") {
        timer.add(`context.retrieval.${sanitizePhaseSegment(phase)}`, durationMs);
      }
    }
  }
}

export function shouldAttachPackedPayloadForContext(
  wireFormat: "packed" | "auto",
  wireResult: Pick<
    ContextWireResult,
    "jsonBytes" | "packedBytes" | "jsonTokens" | "packedTokens"
  >,
): boolean {
  const bytesSaved = (wireResult.jsonBytes ?? 0) > (wireResult.packedBytes ?? 0);
  const tokensSaved =
    typeof wireResult.jsonTokens === "number" &&
    typeof wireResult.packedTokens === "number" &&
    wireResult.jsonTokens > wireResult.packedTokens;
  return wireFormat === "packed" && bytesSaved && tokensSaved;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSymbolId(value: string): boolean {
  return SYMBOL_ID_PATTERN.test(value);
}

function normalizeEvidencePath(
  value: string,
  allowRootFile = false,
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (isSymbolId(trimmed)) return undefined;
  const hasDirectory = trimmed.includes("/") || trimmed.includes("\\");
  if (!hasDirectory && !allowRootFile) return undefined;
  if (!hasDirectory && !/^[^\\/:*?"<>|]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    return undefined;
  }
  return normalizePath(trimmed);
}

function extractSummaryPath(summary: string): string | undefined {
  for (const segment of summary.split("|")) {
    const relPath = normalizeEvidencePath(segment, true);
    if (relPath) return relPath;
  }
  return undefined;
}

function addCandidate(
  candidates: EvidenceSourceCandidates,
  sources: ContextRawTokenSources,
  kind: "symbol" | "path",
  value: string,
): void {
  if (kind === "symbol") {
    candidates.symbolIds.add(value);
    sources.symbolIds.add(value);
  } else {
    candidates.relPaths.add(value);
    sources.relPaths.add(value);
  }
}

function extractPathBeforeNumericSuffix(value: string): string | undefined {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const suffix = value.slice(separator + 1);
  if (!/^\d+(?:-\d+)?$/.test(suffix)) return undefined;
  return value.slice(0, separator);
}

function addEvidenceSource(
  evidence: Record<string, unknown>,
  sources: ContextRawTokenSources,
): void {
  const reference =
    typeof evidence.reference === "string" ? evidence.reference : "";
  const summary = typeof evidence.summary === "string" ? evidence.summary : "";
  const type = typeof evidence.type === "string" ? evidence.type : "";
  if (reference || summary || type) {
    sources.evidenceCount += 1;
  }

  const candidates: EvidenceSourceCandidates = {
    symbolIds: new Set<string>(),
    relPaths: new Set<string>(),
  };

  const [prefix, ...rest] = reference.split(":");
  const body = rest.join(":").trim();
  if (body) {
    if (prefix === "symbol" || prefix === "hotpath") {
      if (isSymbolId(body)) addCandidate(candidates, sources, "symbol", body);
    } else if (prefix === "file") {
      if (isSymbolId(body)) {
        addCandidate(candidates, sources, "symbol", body);
      } else {
        const relPath = normalizeEvidencePath(body, true);
        if (relPath) addCandidate(candidates, sources, "path", relPath);
      }
    } else if (prefix === "window" || prefix === "diagnostic") {
      const filePath = extractPathBeforeNumericSuffix(body);
      if (filePath) {
        const relPath = normalizeEvidencePath(filePath, true);
        if (relPath) addCandidate(candidates, sources, "path", relPath);
      }
    }
  }

  const summaryPath = extractSummaryPath(summary);
  if (summaryPath) addCandidate(candidates, sources, "path", summaryPath);

  if (candidates.symbolIds.size > 0 || candidates.relPaths.size > 0) {
    sources.evidenceSources.push(candidates);
  }
}

export function collectContextRawTokenSources(
  response: Record<string, unknown>,
): ContextRawTokenSources {
  const sources: ContextRawTokenSources = {
    symbolIds: new Set(),
    relPaths: new Set(),
    evidenceCount: 0,
    evidenceSources: [],
  };

  const addEvidenceArray = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (isRecord(item)) addEvidenceSource(item, sources);
    }
  };

  addEvidenceArray(response.finalEvidence);

  return sources;
}

export function calculateContextRawEquivalentTokens({
  fileRawTokens,
  evidenceCount,
  resolvedEvidenceCount,
}: ContextRawEquivalentInput): number {
  const unresolvedEvidenceCount = Math.max(
    0,
    evidenceCount - resolvedEvidenceCount,
  );
  const unresolvedFloor =
    unresolvedEvidenceCount * MIN_RAW_TOKENS_PER_CONTEXT_RESULT;

  return fileRawTokens + unresolvedFloor;
}

function fileBytesToTokens(byteSize: number): number {
  return Math.ceil(byteSize / BYTES_PER_TOKEN);
}

export async function estimateContextRawEquivalentTokens(
  repoId: string,
  response: Record<string, unknown>,
): Promise<number> {
  const sources = collectContextRawTokenSources(response);
  if (sources.symbolIds.size === 0 && sources.relPaths.size === 0) {
    return calculateContextRawEquivalentTokens({
      fileRawTokens: 0,
      evidenceCount: sources.evidenceCount,
      resolvedEvidenceCount: 0,
    });
  }

  try {
    const conn = await getLadybugConn();
    const fileIds = new Set<string>();
    const resolvedSymbolIds = new Set<string>();
    const resolvedRelPaths = new Set<string>();

    if (sources.symbolIds.size > 0) {
      const symbols = await ladybugDb.getSymbolsByIds(
        conn,
        [...sources.symbolIds],
      );
      for (const symbol of symbols.values()) {
        if (symbol.repoId === repoId) {
          fileIds.add(symbol.fileId);
          resolvedSymbolIds.add(symbol.symbolId);
        }
      }
    }

    for (const relPath of sources.relPaths) {
      const file = await ladybugDb.getFileByRepoPath(conn, repoId, relPath);
      if (file) {
        fileIds.add(file.fileId);
        resolvedRelPaths.add(relPath);
      }
    }

    const files = await ladybugDb.getFilesByIds(conn, [...fileIds]);
    let fileRawTokens = 0;
    for (const file of files.values()) {
      if (file.repoId === repoId) {
        fileRawTokens += fileBytesToTokens(file.byteSize);
      }
    }

    let resolvedEvidenceCount = 0;
    for (const candidates of sources.evidenceSources.values()) {
      const resolved =
        [...candidates.symbolIds].some((id) => resolvedSymbolIds.has(id)) ||
        [...candidates.relPaths].some((relPath) => resolvedRelPaths.has(relPath));
      if (resolved) resolvedEvidenceCount += 1;
    }

    return calculateContextRawEquivalentTokens({
      fileRawTokens,
      evidenceCount: sources.evidenceCount,
      resolvedEvidenceCount,
    });
  } catch {
    // Token accounting must never make sdl.context fail.
    return calculateContextRawEquivalentTokens({
      fileRawTokens: 0,
      evidenceCount: sources.evidenceCount,
      resolvedEvidenceCount: 0,
    });
  }
}

interface ContextSessionDeltaSummary {
  newCards: number;
  changedCards: number;
  unchangedRefs: number;
}

function contextSessionRef(key: string, etag?: string): { key: string; etag?: string } {
  const ref: { key: string; etag?: string } = { key };
  if (etag !== undefined) ref.etag = etag;
  return ref;
}

function symbolIdFromEvidenceReference(reference: unknown): string | undefined {
  if (typeof reference !== "string") return undefined;
  return reference.startsWith("symbol:") ? reference.slice("symbol:".length) : reference;
}

function applyTaskConditionedCardProjection(
  response: Record<string, unknown>,
  taskType: AgentTask["taskType"],
  cardDetail: unknown,
): void {
  if (cardDetail === "full") return;

  if (Array.isArray(response.cards)) {
    response.cards = response.cards.map((card) =>
      isRecord(card) ? projectCardForTask(card, taskType) : card,
    );
  }

  if (Array.isArray(response.finalEvidence)) {
    response.finalEvidence = response.finalEvidence.map((item) => {
      if (!isRecord(item) || item.type !== "symbolCard") return item;
      return projectSymbolCardEvidenceForTask(item, taskType);
    });
  }
}

function applyContextSessionRefs(
  response: Record<string, unknown>,
  options: { repoId: string; refsMode?: "auto" | "off"; sessionId?: string },
): void {
  if (options.refsMode === "off" || !options.sessionId) return;
  if (!Array.isArray(response.finalEvidence)) return;

  const sessionDelta: ContextSessionDeltaSummary = {
    newCards: 0,
    changedCards: 0,
    unchangedRefs: 0,
  };
  let sawSymbolCard = false;
  response.finalEvidence = response.finalEvidence.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const evidence = item as Record<string, unknown>;
    if (evidence.type !== "symbolCard") return item;

    const symbolId = symbolIdFromEvidenceReference(evidence.reference);
    if (!symbolId) return item;
    sawSymbolCard = true;
    const key = `card:${options.repoId}:${symbolId}`;
    const etag = typeof evidence.etag === "string" ? evidence.etag : undefined;
    const result = sessionContentLedger.record({
      sessionId: options.sessionId,
      key,
      contentHash: hashContent(JSON.stringify(evidence)),
      etag,
    });

    if (result.status === "unchanged") {
      sessionDelta.unchangedRefs += 1;
      return {
        type: evidence.type,
        reference: evidence.reference,
        ref: contextSessionRef(key, etag),
        unchanged: true,
      };
    }
    if (result.status === "changed") {
      sessionDelta.changedCards += 1;
      return { ...evidence, changedSincePrior: true };
    }
    sessionDelta.newCards += 1;
    return item;
  });

  if (sawSymbolCard) response.sessionDelta = sessionDelta;
}

export function buildContextPackedStats(
  wireResult: ContextWireResult,
  payloadAttached: boolean,
): Record<string, unknown> | undefined {
  if (!wireResult.gateDecision) return undefined;
  const savedRatio =
    wireResult.jsonBytes && wireResult.jsonBytes > 0
      ? (wireResult.jsonBytes - (wireResult.packedBytes ?? 0)) /
        wireResult.jsonBytes
      : 0;
  const jt = wireResult.jsonTokens;
  const pt = wireResult.packedTokens;
  const tokenSavedRatio =
    typeof jt === "number" && typeof pt === "number" && jt > 0
      ? (jt - pt) / jt
      : undefined;
  return {
    encoderId: wireResult.encoderId,
    jsonBytes: wireResult.jsonBytes,
    packedBytes: wireResult.packedBytes,
    jsonTokens: wireResult.jsonTokens,
    packedTokens: wireResult.packedTokens,
    savedRatio,
    tokenSavedRatio,
    axisHit: wireResult.axisHit,
    candidateDecision: wireResult.gateDecision,
    gateDecision: payloadAttached ? "packed" : "fallback",
    payloadAttached,
    returnFormat: payloadAttached ? "packed" : "json",
  };
}

export async function handleAgentContext(
  args: unknown,
  context?: ToolContext,
): Promise<AgentContextResponse> {
  const timer = new ToolPhaseTimer();
  try {
    const parseStartedAt = timer.start();
    const request = AgentContextRequestSchema.parse(args);
    timer.record("context.validate", parseStartedAt);
    const task: AgentTask = {
      repoId: request.repoId,
      taskType: request.taskType,
      taskText: request.taskText,
      budget: request.budget,
      options: request.options,
    };

    const result = await timer.time("context.buildContext", () =>
      contextEngine.buildContext(task),
    );
    const response = result as Extract<AgentContextResponse, { taskId: string }>;
    recordContextSubTimings(timer, response);

    const rawTokens = await timer.time("context.rawEquivalent", () =>
      estimateContextRawEquivalentTokens(request.repoId, response),
    );
    const config = loadConfig();
    const enrichedResponse = attachRawContext(response, { rawTokens });
    const cardDetail = isRecord(request.options)
      ? (request.options as Record<string, unknown>).cardDetail
      : undefined;
    applyTaskConditionedCardProjection(
      enrichedResponse as Record<string, unknown>,
      request.taskType,
      cardDetail,
    );
    // Snapshot pre-gate bulk fields so the ETag stable view reflects the
    // projected payload identity even when the packed gate clears them.
    const stableView: Record<string, unknown> = {
      ...(enrichedResponse as Record<string, unknown>),
    };
    applyContextSessionRefs(enrichedResponse as Record<string, unknown>, {
      repoId: request.repoId,
      refsMode: request.refsMode,
      sessionId: context?.sessionId,
    });
    if (request.wireFormat === "packed" || request.wireFormat === "auto") {
      const wireStartedAt = timer.start();
      const wireResult = serializeContextForWireFormat(
        enrichedResponse as Record<string, unknown>,
        request.wireFormat,
        {
          sessionId: context?.sessionId,
          shortIds: config.wire?.shortIds,
        },
      );
      if (wireResult.format === "packed") {
        // Only attach _packedPayload for explicit packed requests when it
        // saves both bytes and tokens. Auto remains JSON-first because adding
        // the packed string beside readable evidence costs tokens.
        const payloadAttached = shouldAttachPackedPayloadForContext(
          request.wireFormat,
          wireResult,
        );
        const stats = buildContextPackedStats(wireResult, payloadAttached);
        if (stats) {
          (enrichedResponse as Record<string, unknown>)._packedStats = stats;
        }
        publishContextWireDecision(
          wireResult,
          payloadAttached ? "packed" : "fallback",
        );
        if (payloadAttached) {
          (enrichedResponse as Record<string, unknown>)._packedPayload =
            wireResult.payload as string;
          (enrichedResponse as Record<string, unknown>).actionsTaken = [];
          (enrichedResponse as Record<string, unknown>).finalEvidence = [];
          stableView._packedPayload = wireResult.payload;
          // stableView keeps pre-clear actionsTaken/finalEvidence so two
          // packed responses with different underlying data produce
          // different ETags.
        } else {
          // Net loss — downgrade gateDecision so the stats block tells
          // observers honestly that we fell back rather than packed.
          const stats = (enrichedResponse as Record<string, unknown>)
            ._packedStats as Record<string, unknown> | undefined;
          if (stats) stats.gateDecision = "fallback";
        }
      } else {
        const stats = buildContextPackedStats(wireResult, false);
        if (stats) {
          (enrichedResponse as Record<string, unknown>)._packedStats = stats;
        }
        publishContextWireDecision(wireResult, "fallback");
      }
      timer.record("context.wireFormat", wireStartedAt);
    }
    const etagStartedAt = timer.start();
    const conditionalResponse = buildConditionalResponse(enrichedResponse, {
      ifNoneMatch: request.ifNoneMatch,
      // Strip request-unique IDs and timing data from the ETag source.
      stableValue: buildStableAgentContextValue(stableView),
    });
    timer.record("context.etag", etagStartedAt);
    if (request.ifNoneMatch) {
      const hit = "notModified" in conditionalResponse;
      recordTokenSavings({
        repoId: request.repoId,
        source: "etag",
        tool: "sdl.context",
        estimatedTokensAvoided: hit ? rawTokens : 0,
        opportunity: true,
        hit,
        realized: hit,
      });
    }
    if ("notModified" in conditionalResponse) {
      return request.includeDiagnostics
        ? attachTimingDiagnostics(conditionalResponse, timer.snapshot())
        : conditionalResponse;
    }
    const compressionStartedAt = timer.start();
    const compressedResponse = await maybeCompressToolResponse({
      repoId: request.repoId,
      toolName: "sdl.context",
      payload: conditionalResponse,
      responseMode: request.responseMode,
      rawContext: { rawTokens },
      sessionId: context?.sessionId,
    });
    timer.record("context.responseMode", compressionStartedAt);
    return request.includeDiagnostics
      ? attachTimingDiagnostics(compressedResponse, timer.snapshot())
      : compressedResponse;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid agent context request: ${error.issues.map((issue) => issue.message).join(", ")}`,
      );
    }
    if (error instanceof ValidationError || error instanceof IndexError) {
      throw error;
    }
    throw new IndexError(
      `Agent context retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
