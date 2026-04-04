import { contextEngine } from "../../agent/context-engine.js";
import type { AgentTask } from "../../agent/types.js";
import { IndexError, ValidationError } from "../errors.js";
import { attachRawContext } from "../token-usage.js";
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

    const focusPaths = request.options?.focusPaths;
    const fileIds = focusPaths?.length
      ? focusPaths.map((path) => `${request.repoId}:${path}`)
      : undefined;
    const rawTokens = (response.metrics?.totalTokens ?? 0) * 3;
    const enrichedResponse = attachRawContext(
      response,
      fileIds ? { fileIds } : { rawTokens },
    );
    return buildConditionalResponse(enrichedResponse, {
      ifNoneMatch: request.ifNoneMatch,
      // Strip request-unique IDs and timing data from the ETag source.
      stableValue: buildStableAgentContextValue(
        enrichedResponse as Record<string, unknown>,
      ),
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
