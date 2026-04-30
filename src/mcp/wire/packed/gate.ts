/**
 * Auto-gate logic for packed wire format.
 *
 * Two-axis decision: emit packed when EITHER byte savings clear
 * `byteThreshold` OR token savings clear `tokenThreshold`.
 *
 * Tokens drive the practical win on LLM payloads — JSON's structural sigils
 * (`{`, `}`, `:`, `,`, `"`) each count as a token under the chars-based
 * estimator; packed strips them. Bytes stay relevant for transport-bound
 * scenarios and back-compat with the v0.11.0 single-axis design.
 *
 * Threshold cascade (highest precedence first):
 *   1. Per-call options.{packedThreshold, packedTokenThreshold}
 *   2. Env SDL_PACKED_THRESHOLD / SDL_PACKED_TOKEN_THRESHOLD (parsed float)
 *   3. Config wire.packed.{threshold, tokenThreshold}
 *   4. Defaults — bytes 0.10, tokens 0.20
 */

const DEFAULT_BYTE_THRESHOLD = 0.10;
const DEFAULT_TOKEN_THRESHOLD = 0.20;

export interface GateContext {
  /** Per-call byte-savings override; takes top precedence. */
  callThreshold?: number;
  /** Per-call token-savings override; takes top precedence. */
  callTokenThreshold?: number;
  /** Resolved config-level byte threshold. */
  configThreshold?: number;
  /** Resolved config-level token threshold. */
  configTokenThreshold?: number;
}

function resolveAxis(
  callValue: number | undefined,
  envName: string,
  configValue: number | undefined,
  fallback: number,
): number {
  if (typeof callValue === "number" && Number.isFinite(callValue)) {
    return callValue;
  }
  const env = process.env[envName];
  if (env) {
    const parsed = parseFloat(env);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof configValue === "number" && Number.isFinite(configValue)) {
    return configValue;
  }
  return fallback;
}

/**
 * Resolve the byte-axis threshold (legacy single-arg signature kept).
 */
export function resolveThreshold(ctx: GateContext = {}): number {
  return resolveAxis(
    ctx.callThreshold,
    "SDL_PACKED_THRESHOLD",
    ctx.configThreshold,
    DEFAULT_BYTE_THRESHOLD,
  );
}

/** Resolve the token-axis threshold. */
export function resolveTokenThreshold(ctx: GateContext = {}): number {
  return resolveAxis(
    ctx.callTokenThreshold,
    "SDL_PACKED_TOKEN_THRESHOLD",
    ctx.configTokenThreshold,
    DEFAULT_TOKEN_THRESHOLD,
  );
}

export function isPackedEnabled(configEnabled?: boolean): boolean {
  const env = process.env.SDL_PACKED_ENABLED;
  if (env !== undefined) {
    const lc = env.trim().toLowerCase();
    if (lc === "false" || lc === "0" || lc === "no") return false;
    if (lc === "true" || lc === "1" || lc === "yes") return true;
  }
  return configEnabled !== false;
}

export function defaultFormat(): "packed" | "auto" | "compact" {
  const env = process.env.SDL_PACKED_DEFAULT_FORMAT;
  if (env === "packed" || env === "auto" || env === "compact") return env;
  return "compact";
}

/**
 * Single-axis byte gate (kept for compatibility with callers that don't
 * have a token estimate handy). Emits packed when byte savings >= threshold.
 */
export function shouldEmitPacked(
  jsonBytes: number,
  packedBytes: number,
  threshold = DEFAULT_BYTE_THRESHOLD,
): boolean {
  if (jsonBytes <= 0) return false;
  const saved = (jsonBytes - packedBytes) / jsonBytes;
  return saved >= threshold;
}

export function savedRatio(jsonBytes: number, packedBytes: number): number {
  if (jsonBytes <= 0) return 0;
  return (jsonBytes - packedBytes) / jsonBytes;
}

export interface DecideMetrics {
  jsonBytes: number;
  packedBytes: number;
  /** Estimated tokens for the JSON payload (compact-v3). Required for token gate. */
  jsonTokens?: number;
  /** Estimated tokens for the packed payload. Required for token gate. */
  packedTokens?: number;
}

export interface DecideResult {
  decision: "packed" | "fallback";
  axisHit: "bytes" | "tokens" | null;
  bytesSavedRatio: number;
  tokensSavedRatio: number;
}

/**
 * Two-axis decision: emit packed when EITHER threshold is met.
 *
 * `wireFormat: "auto"` — picks whichever encoding has a smaller
 * token footprint (or smaller byte footprint when token estimates are
 * absent). `wireFormat: "packed"` — emits when either axis clears its
 * threshold.
 */
export function decideFormatDetailed(
  wireFormat: "packed" | "auto",
  metrics: DecideMetrics,
  byteThreshold = DEFAULT_BYTE_THRESHOLD,
  tokenThreshold = DEFAULT_TOKEN_THRESHOLD,
): DecideResult {
  const bytesRatio =
    metrics.jsonBytes > 0
      ? (metrics.jsonBytes - metrics.packedBytes) / metrics.jsonBytes
      : 0;
  const haveTokens =
    typeof metrics.jsonTokens === "number" &&
    typeof metrics.packedTokens === "number" &&
    metrics.jsonTokens > 0;
  const tokensRatio = haveTokens
    ? (metrics.jsonTokens! - metrics.packedTokens!) / metrics.jsonTokens!
    : 0;

  if (wireFormat === "auto") {
    if (haveTokens) {
      return {
        decision: metrics.packedTokens! < metrics.jsonTokens! ? "packed" : "fallback",
        axisHit: metrics.packedTokens! < metrics.jsonTokens! ? "tokens" : null,
        bytesSavedRatio: bytesRatio,
        tokensSavedRatio: tokensRatio,
      };
    }
    return {
      decision: metrics.packedBytes < metrics.jsonBytes ? "packed" : "fallback",
      axisHit: metrics.packedBytes < metrics.jsonBytes ? "bytes" : null,
      bytesSavedRatio: bytesRatio,
      tokensSavedRatio: tokensRatio,
    };
  }

  if (haveTokens && tokensRatio >= tokenThreshold) {
    return {
      decision: "packed",
      axisHit: "tokens",
      bytesSavedRatio: bytesRatio,
      tokensSavedRatio: tokensRatio,
    };
  }
  if (bytesRatio >= byteThreshold) {
    return {
      decision: "packed",
      axisHit: "bytes",
      bytesSavedRatio: bytesRatio,
      tokensSavedRatio: tokensRatio,
    };
  }
  return {
    decision: "fallback",
    axisHit: null,
    bytesSavedRatio: bytesRatio,
    tokensSavedRatio: tokensRatio,
  };
}

/**
 * Single-shot decision (back-compat with v0.11.0 single-axis API). Bytes-only.
 */
export function decideFormat(
  wireFormat: "packed" | "auto",
  jsonBytes: number,
  packedBytes: number,
  threshold?: number,
): "packed" | "fallback" {
  return decideFormatDetailed(
    wireFormat,
    { jsonBytes, packedBytes },
    threshold ?? DEFAULT_BYTE_THRESHOLD,
    DEFAULT_TOKEN_THRESHOLD,
  ).decision;
}

export const PACKED_DEFAULT_THRESHOLD = DEFAULT_BYTE_THRESHOLD;
export const PACKED_DEFAULT_TOKEN_THRESHOLD = DEFAULT_TOKEN_THRESHOLD;
