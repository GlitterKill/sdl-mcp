import {
  decideFormatDetailed,
  isPackedEnabled,
  resolveThreshold,
  resolveTokenThreshold,
} from "./packed/gate.js";
import { getEncoderForTool } from "./packed/encoders/registry.js";
import {
  markShortIdsDelivered,
  packedShortIdsActive,
  type PackedShortIdOptions,
} from "./packed/short-ids.js";
import { estimatePackedTokens, estimateTokens } from "../../util/tokenize.js";
import { getObservabilityTap } from "../../observability/event-tap.js";
import { tokenAccumulator } from "../token-accumulator.js";

export interface WireGateResult {
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

export interface WireGateOptions extends PackedShortIdOptions {
  packedThreshold?: number;
  packedTokenThreshold?: number;
  packedEnabled?: boolean;
  /** Encoder input when the readable JSON projection differs from source data. */
  encoderInput?: unknown;
  /** Context defers publication until it knows whether the candidate is attached. */
  publishDecision?: boolean;
}

export function publishWireDecision(
  wireResult: WireGateResult,
  decision: "packed" | "fallback",
): void {
  if (
    !wireResult.encoderId ||
    typeof wireResult.jsonBytes !== "number" ||
    typeof wireResult.packedBytes !== "number"
  ) {
    return;
  }

  tokenAccumulator.recordPackedUsage(
    wireResult.encoderId,
    wireResult.jsonBytes,
    wireResult.packedBytes,
    decision,
  );
  try {
    getObservabilityTap()?.packedWire({
      encoderId: wireResult.encoderId,
      jsonBytes: wireResult.jsonBytes,
      packedBytes: wireResult.packedBytes,
      jsonTokens: wireResult.jsonTokens,
      packedTokens: wireResult.packedTokens,
      decision,
      axisHit: wireResult.axisHit ?? null,
    });
  } catch {
    // Observability must never alter the response path.
  }
}

/** Run the shared packed candidate gate for one tool-specific encoder. */
export function gateWireFormat(
  toolName: string,
  payload: unknown,
  wireFormat: "json" | "packed" | "auto" | undefined,
  options: WireGateOptions = {},
): WireGateResult {
  if (wireFormat !== "packed" && wireFormat !== "auto") {
    return { format: "json", payload };
  }
  if (!isPackedEnabled(options.packedEnabled)) {
    return { format: "json", payload };
  }

  const encoder = getEncoderForTool(toolName);
  if (!encoder) throw new Error(`No packed encoder registered for ${toolName}`);

  const json = JSON.stringify(payload);
  const packed = encoder.encode(options.encoderInput ?? payload, options);
  const jsonTokens = estimateTokens(json);
  const packedTokens = estimatePackedTokens(packed);
  const detail = decideFormatDetailed(
    wireFormat,
    {
      jsonBytes: json.length,
      packedBytes: packed.length,
      jsonTokens,
      packedTokens,
    },
    resolveThreshold({ callThreshold: options.packedThreshold }),
    resolveTokenThreshold({
      callTokenThreshold: options.packedTokenThreshold,
    }),
  );
  const gateDecision: "packed" | "fallback" =
    detail.decision === "packed" ? "packed" : "fallback";
  const encoderId = packedShortIdsActive(options)
    ? encoder.shortId
    : encoder.id;
  const stats = {
    encoderId,
    jsonBytes: json.length,
    packedBytes: packed.length,
    jsonTokens,
    packedTokens,
    axisHit: detail.axisHit ?? undefined,
    gateDecision,
  };

  if (options.publishDecision !== false) {
    publishWireDecision({ format: "json", payload, ...stats }, gateDecision);
  }

  if (gateDecision === "packed") {
    if (encoder.markDeliveredOnPacked) {
      markShortIdsDelivered(packed, options);
    }
    return {
      format: "packed",
      payload: packed,
      ...stats,
      axisHit: detail.axisHit ?? "bytes",
    };
  }

  return { format: "json", payload, ...stats };
}
