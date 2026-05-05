import { contextEngine } from "../../agent/context-engine.js";
import type { AgentTask } from "../../agent/types.js";
import { IndexError, ValidationError } from "../errors.js";
import { attachRawContext } from "../token-usage.js";
import { serializeContextForWireFormat } from "./context-wire-format.js";
import {
  AgentContextRequestSchema,
  type AgentContextResponse,
} from "../tools.js";
import { ZodError } from "zod";
import { buildConditionalResponse } from "../../util/conditional-response.js";

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

export async function handleAgentContext(
  args: unknown,
): Promise<AgentContextResponse> {
  try {
    const request = AgentContextRequestSchema.parse(args);
    const task: AgentTask = {
      repoId: request.repoId,
      taskType: request.taskType,
      taskText: request.taskText,
      budget: request.budget,
      options: request.options,
    };

    const result = await contextEngine.buildContext(task);
    const response = result as Exclude<
      AgentContextResponse,
      { notModified: true }
    >;

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
      const wireResult = serializeContextForWireFormat(
        enrichedResponse as Record<string, unknown>,
        request.wireFormat,
      );
      if (wireResult.gateDecision) {
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
        (enrichedResponse as Record<string, unknown>)._packedStats = {
          encoderId: wireResult.encoderId,
          jsonBytes: wireResult.jsonBytes,
          packedBytes: wireResult.packedBytes,
          jsonTokens: wireResult.jsonTokens,
          packedTokens: wireResult.packedTokens,
          savedRatio,
          tokenSavedRatio,
          axisHit: wireResult.axisHit,
          gateDecision: wireResult.gateDecision,
        };
      }
      if (wireResult.format === "packed") {
        // Only attach _packedPayload when it actually saves both bytes AND
        // tokens vs the JSON form. The gate occasionally picks "packed" on
        // a single-axis win (e.g. tokens up, bytes down) where shipping the
        // string alongside finalEvidence + summary inflates the response.
        const bytesSaved =
          (wireResult.jsonBytes ?? 0) > (wireResult.packedBytes ?? 0);
        const tokensSaved =
          typeof wireResult.jsonTokens === "number" &&
          typeof wireResult.packedTokens === "number" &&
          wireResult.jsonTokens > wireResult.packedTokens;
        const netWin = bytesSaved && tokensSaved;
        if (netWin) {
          (enrichedResponse as Record<string, unknown>)._packedPayload =
            wireResult.payload as string;
          // Only suppress JSON fields when the caller explicitly asked for
          // packed. Under wireFormat="auto" we keep both forms so callers
          // that cannot decode packed still get human-readable evidence.
          if (request.wireFormat === "packed") {
            (enrichedResponse as Record<string, unknown>).actionsTaken = [];
            (enrichedResponse as Record<string, unknown>).finalEvidence = [];
          }
          // stableView keeps pre-clear actionsTaken/finalEvidence so two
          // packed responses with different underlying data produce
          // different ETags. _packedPayload is also tracked here to defend
          // against future decoder drift surfacing identity-changing
          // fields.
          stableView._packedPayload = wireResult.payload;
        } else {
          // Net loss — downgrade gateDecision so the stats block tells
          // observers honestly that we fell back rather than packed.
          const stats = (enrichedResponse as Record<string, unknown>)
            ._packedStats as Record<string, unknown> | undefined;
          if (stats) stats.gateDecision = "fallback";
        }
      }
    }
    return buildConditionalResponse(enrichedResponse, {
      ifNoneMatch: request.ifNoneMatch,
      // Strip request-unique IDs and timing data from the ETag source.
      stableValue: buildStableAgentContextValue(stableView),
    });
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
