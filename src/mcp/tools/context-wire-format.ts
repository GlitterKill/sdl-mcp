/**
 * Packed-wire gate for the canonical sdl.context v2 payload.
 */

import {
  gateWireFormat,
  publishWireDecision,
  type WireGateResult,
} from "../wire/gate.js";

export type ContextWireResult = WireGateResult;

export function serializeContextForWireFormat(
  response: Record<string, unknown>,
  wireFormat: "json" | "packed" | "auto" | undefined,
  options?: {
    repoId?: string;
    packedThreshold?: number;
    packedTokenThreshold?: number;
    packedEnabled?: boolean;
    sessionId?: string;
    shortIds?: boolean;
  },
): ContextWireResult {
  return gateWireFormat("context", response, wireFormat, {
    ...options,
    encoderInput: response,
    publishDecision: false,
  });
}

export function publishContextWireDecision(
  wireResult: ContextWireResult,
  decision: "packed" | "fallback",
): void {
  publishWireDecision(wireResult, decision);
}
