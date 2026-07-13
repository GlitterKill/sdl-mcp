/**
 * sdl.context wire-format gate. Mirrors slice-wire-format and
 * symbol-wire-format: runs the packed gate, publishes tap +
 * tokenAccumulator events for both decisions, returns chosen payload.
 */

import {
  gateWireFormat,
  publishWireDecision,
  type WireGateResult,
} from "../wire/gate.js";
import { compactCardForWire } from "./symbol-utils.js";

export type ContextWireResult = WireGateResult;

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
    sessionId?: string;
    shortIds?: boolean;
  },
): ContextWireResult {
  const jsonPayload = Array.isArray(response.cards)
    ? {
        ...response,
        cards: response.cards.map((card) =>
          card !== null && typeof card === "object" && !Array.isArray(card)
            ? compactCardForWire(
                card as Parameters<typeof compactCardForWire>[0],
              )
            : card,
        ),
      }
    : response;

  const input = buildContextInput(jsonPayload);
  return gateWireFormat(
    "context",
    jsonPayload,
    wireFormat,
    {
      ...options,
      encoderInput: input,
      publishDecision: false,
    },
  );
}

export function publishContextWireDecision(
  wireResult: ContextWireResult,
  decision: "packed" | "fallback",
): void {
  publishWireDecision(wireResult, decision);
}
