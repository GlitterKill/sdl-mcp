/**
 * symbol.search wire-format gate. Mirrors slice-wire-format.ts: runs the
 * packed gate on the JSON response, publishes tap + token-accumulator
 * events for both packed and fallback decisions, and returns the chosen
 * payload (JSON object or packed string).
 */

import {
  encodePackedSymbolSearch,
  SYMBOL_SEARCH_ENCODER_ID,
} from "../wire/packed/encoders/symbol-search.js";
import {
  decideFormatDetailed,
  isPackedEnabled,
  resolveThreshold,
  resolveTokenThreshold,
} from "../wire/packed/index.js";
import { estimateTokens, estimatePackedTokens } from "../../util/tokenize.js";
import { getObservabilityTap } from "../../observability/event-tap.js";
import { tokenAccumulator } from "../token-accumulator.js";

export interface SymbolSearchWireResult {
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
  },
): SymbolSearchWireResult {
  if (wireFormat !== "packed" && wireFormat !== "auto") {
    return { format: "json", payload: input };
  }
  if (!isPackedEnabled(options?.packedEnabled)) {
    return { format: "json", payload: input };
  }

  const jsonStr = JSON.stringify(input);
  const packedStr = encodePackedSymbolSearch(input);
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
    SYMBOL_SEARCH_ENCODER_ID,
    jsonStr.length,
    packedStr.length,
    gateDecision,
  );
  try {
    getObservabilityTap()?.packedWire({
      encoderId: SYMBOL_SEARCH_ENCODER_ID,
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
      encoderId: SYMBOL_SEARCH_ENCODER_ID,
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
    payload: input,
    encoderId: SYMBOL_SEARCH_ENCODER_ID,
    jsonBytes: jsonStr.length,
    packedBytes: packedStr.length,
    jsonTokens,
    packedTokens,
    axisHit: detail.axisHit ?? undefined,
    gateDecision,
  };
}
