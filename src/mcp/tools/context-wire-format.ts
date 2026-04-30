/**
 * sdl.context wire-format gate. Mirrors slice-wire-format and
 * symbol-wire-format: runs the packed gate, publishes tap +
 * tokenAccumulator events for both decisions, returns chosen payload.
 */

import {
  encodePackedContext,
  CONTEXT_ENCODER_ID,
} from "../wire/packed/encoders/context.js";
import {
  decideFormatDetailed,
  isPackedEnabled,
  resolveThreshold,
  resolveTokenThreshold,
} from "../wire/packed/index.js";
import { estimateTokens, estimatePackedTokens } from "../../util/tokenize.js";
import { getObservabilityTap } from "../../observability/event-tap.js";
import { tokenAccumulator } from "../token-accumulator.js";

export interface ContextWireResult {
  format: "json" | "packed";
  payload: unknown;
  encoderId?: string;
  jsonBytes?: number;
  packedBytes?: number;
  jsonTokens?: number;
  packedTokens?: number;
  axisHit?: "bytes" | "tokens";
  gateDecision?: "packed" | "fallback";
}

/**
 * Build a ContextInput shape from an enriched AgentContextPayload-like
 * response. Pulls cards from finalEvidence (type=symbolCard), action
 * rows from actionsTaken, evidence rows from finalEvidence.
 */
function buildContextInput(response: Record<string, unknown>): {
  taskType?: string;
  windowBytes?: number;
  cards: Array<{
    symbolId?: string;
    file?: string;
    kind?: string;
    name?: string;
    summary?: string;
  }>;
  rungs: Array<{ rungName?: string; rationale?: string }>;
  actions: Array<{
    id?: string;
    type?: string;
    status?: string;
    durationMs?: number;
    error?: string;
  }>;
  evidence: Array<{ type?: string; reference?: string; summary?: string }>;
  summary?: string;
  success?: boolean;
  nextBestActionTool?: string;
  nextBestActionRationale?: string;
} {
  const finalEvidence = Array.isArray(response.finalEvidence)
    ? (response.finalEvidence as Array<Record<string, unknown>>)
    : [];
  const cards = finalEvidence
    .filter((e) => e.type === "symbolCard")
    .map((e) => ({
      symbolId:
        typeof e.reference === "string" ? e.reference : undefined,
      summary: typeof e.summary === "string" ? e.summary : undefined,
    }));
  const evidence = finalEvidence.map((e) => ({
    type: typeof e.type === "string" ? e.type : "",
    reference: typeof e.reference === "string" ? e.reference : "",
    summary: typeof e.summary === "string" ? e.summary : "",
  }));
  const rungsRaw = (response.path as { rungs?: unknown[] } | undefined)?.rungs;
  const rungs = Array.isArray(rungsRaw)
    ? rungsRaw.map((r) => {
        if (typeof r === "string") {
          return { rungName: r, rationale: "" };
        }
        if (r && typeof r === "object") {
          const obj = r as Record<string, unknown>;
          return {
            rungName:
              typeof obj.rungName === "string"
                ? obj.rungName
                : typeof obj.rung === "string"
                  ? obj.rung
                  : "",
            rationale:
              typeof obj.rationale === "string" ? obj.rationale : "",
          };
        }
        return { rungName: "", rationale: "" };
      })
    : [];
  const actions = Array.isArray(response.actionsTaken)
    ? (response.actionsTaken as Array<Record<string, unknown>>).map((a) => ({
        id: typeof a.id === "string" ? a.id : "",
        type: typeof a.type === "string" ? a.type : "",
        status: typeof a.status === "string" ? a.status : "",
        durationMs:
          typeof a.durationMs === "number" ? a.durationMs : 0,
        error: typeof a.error === "string" ? a.error : "",
      }))
    : [];
  const nba = response.nextBestAction as
    | { tool?: string; rationale?: string }
    | undefined;
  return {
    taskType:
      typeof response.taskType === "string" ? response.taskType : undefined,
    cards,
    rungs,
    actions,
    evidence,
    summary:
      typeof response.summary === "string" ? response.summary : undefined,
    success: response.success === true,
    nextBestActionTool:
      typeof nba?.tool === "string" ? nba.tool : undefined,
    nextBestActionRationale:
      typeof nba?.rationale === "string" ? nba.rationale : undefined,
  };
}

export function serializeContextForWireFormat(
  response: Record<string, unknown>,
  wireFormat: "json" | "packed" | "auto" | undefined,
  options?: {
    packedThreshold?: number;
    packedTokenThreshold?: number;
    packedEnabled?: boolean;
  },
): ContextWireResult {
  if (wireFormat !== "packed" && wireFormat !== "auto") {
    return { format: "json", payload: response };
  }
  if (!isPackedEnabled(options?.packedEnabled)) {
    return { format: "json", payload: response };
  }

  const input = buildContextInput(response);
  const jsonStr = JSON.stringify(response);
  const packedStr = encodePackedContext(input);
  const jsonTokens = estimateTokens(jsonStr);
  const packedTokens = estimatePackedTokens(packedStr);
  const detail = decideFormatDetailed(
    wireFormat,
    {
      jsonBytes: jsonStr.length,
      packedBytes: packedStr.length,
      jsonTokens,
      packedTokens,
    },
    resolveThreshold({ callThreshold: options?.packedThreshold }),
    resolveTokenThreshold({
      callTokenThreshold: options?.packedTokenThreshold,
    }),
  );
  const gateDecision = detail.decision === "packed" ? "packed" : "fallback";

  tokenAccumulator.recordPackedUsage(
    CONTEXT_ENCODER_ID,
    jsonStr.length,
    packedStr.length,
    gateDecision,
  );
  try {
    getObservabilityTap()?.packedWire({
      encoderId: CONTEXT_ENCODER_ID,
      jsonBytes: jsonStr.length,
      packedBytes: packedStr.length,
      decision: gateDecision,
      axisHit: detail.axisHit ?? null,
    });
  } catch {
    /* swallow */
  }

  if (gateDecision === "packed") {
    return {
      format: "packed",
      payload: packedStr,
      encoderId: CONTEXT_ENCODER_ID,
      jsonBytes: jsonStr.length,
      packedBytes: packedStr.length,
      jsonTokens,
      packedTokens,
      axisHit: detail.axisHit ?? "bytes",
      gateDecision,
    };
  }

  return {
    format: "json",
    payload: response,
    encoderId: CONTEXT_ENCODER_ID,
    jsonBytes: jsonStr.length,
    packedBytes: packedStr.length,
    jsonTokens,
    packedTokens,
    axisHit: detail.axisHit ?? undefined,
    gateDecision,
  };
}
