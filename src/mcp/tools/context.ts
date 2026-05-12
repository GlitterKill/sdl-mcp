import { contextEngine } from "../../agent/context-engine.js";
import type { AgentTask } from "../../agent/types.js";
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
import type { ToolContext } from "../../server.js";
import {
  maybeCompressToolResponse,
  recordTokenSavings,
} from "../response-compression.js";
import {
  attachTimingDiagnostics,
  ToolPhaseTimer,
} from "../timing-diagnostics.js";

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

    // Always use rawTokens for usage tracking - synthetic fileIds don't exist in DB
    // and would cause the savings meter to always show 0%.
    const rawTokens = (response.metrics?.totalTokens ?? 0) * 3;
    const enrichedResponse = attachRawContext(response, { rawTokens });
    // Snapshot pre-gate bulk fields so the ETag stable view reflects the
    // original payload identity even when the packed gate clears them.
    const stableView: Record<string, unknown> = {
      ...(enrichedResponse as Record<string, unknown>),
    };
    if (request.wireFormat === "packed" || request.wireFormat === "auto") {
      const wireStartedAt = timer.start();
      const wireResult = serializeContextForWireFormat(
        enrichedResponse as Record<string, unknown>,
        request.wireFormat,
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
