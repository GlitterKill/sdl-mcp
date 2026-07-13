/**
 * symbol.search wire-format gate. Mirrors slice-wire-format.ts: runs the
 * packed gate on the JSON response, publishes tap + token-accumulator
 * events for both packed and fallback decisions, and returns the chosen
 * payload (JSON object or packed string).
 */

import {
  gateWireFormat,
  type WireGateResult,
} from "../wire/gate.js";

export type SymbolSearchWireResult = WireGateResult;

export interface SymbolSearchWireInput {
  query: string;
  results: Array<{
    symbolId: string;
    name: string;
    file: string;
    kind: string;
    line?: number;
    score?: number;
  }>;
  total?: number;
}

export function serializeSymbolSearchForWireFormat(
  input: SymbolSearchWireInput,
  wireFormat: "json" | "packed" | "auto" | undefined,
  options?: {
    packedThreshold?: number;
    packedTokenThreshold?: number;
    packedEnabled?: boolean;
    sessionId?: string;
    shortIds?: boolean;
  },
): SymbolSearchWireResult {
  return gateWireFormat(
    "symbol.search",
    input,
    wireFormat,
    options,
  );
}
