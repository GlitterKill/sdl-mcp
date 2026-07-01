import { loadConfig } from "../config/loadConfig.js";
import { RuntimeConfigSchema } from "../config/types.js";
import { getObservabilityTap } from "../observability/event-tap.js";
import {
  maybeStoreLargeResponse,
  type ResponseMode,
  type ResponseArtifactReference,
} from "../runtime/response-artifacts.js";
import {
  attachRawContext,
  attachTokenUsage,
  computeSavings,
  stripRawContext,
  type RawContextHint,
} from "./token-usage.js";

export type { ResponseMode, ResponseArtifactReference };

// sdl.context responses become hard to scan before they hit the generic cap.
const SDL_CONTEXT_AUTO_RESPONSE_THRESHOLD_TOKENS = 1500;

export interface MaybeCompressToolResponseOptions<T> {
  repoId: string;
  toolName: string;
  payload: T;
  responseMode?: ResponseMode;
  rawContext?: RawContextHint;
  threshold?: number;
  sessionId?: string;
}

function estimateTokensFromPayload(payload: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(payload), "utf-8") / 4);
}

export function recordTokenSavings(event: {
  repoId?: string;
  source:
    | "responseArtifact"
    | "sessionDelta"
    | "etag"
    | "spillover"
    | "rawWindowAvoidance"
    | "packedWire";
  tool?: string;
  estimatedTokensAvoided?: number;
  originalTokens?: number;
  returnedTokens?: number;
  savedTokens?: number;
  storedBytes?: number;
  opportunity?: boolean;
  hit?: boolean;
  realized?: boolean;
}): void {
  try {
    getObservabilityTap()?.tokenSavings(event);
  } catch {
    // Observability must never affect tool responses.
  }
}

export async function maybeCompressToolResponse<T>(
  opts: MaybeCompressToolResponseOptions<T>,
): Promise<T | ResponseArtifactReference> {
  const appConfig = loadConfig();
  const runtimeConfig = RuntimeConfigSchema.parse(appConfig.runtime ?? {});
  const payloadForStorage = stripRawContext(opts.payload);

  const result = await maybeStoreLargeResponse({
    repoId: opts.repoId,
    toolName: opts.toolName,
    payload: payloadForStorage,
    responseMode: opts.responseMode,
    threshold:
      opts.threshold ??
      (opts.responseMode === "auto" && opts.toolName === "sdl.context"
        ? SDL_CONTEXT_AUTO_RESPONSE_THRESHOLD_TOKENS
        : undefined),
    artifactBaseDir: runtimeConfig.artifactBaseDir,
    artifactTtlHours: runtimeConfig.artifactTtlHours,
    maxArtifactBytes: runtimeConfig.maxArtifactBytes,
    maxArtifactsPerRepo: runtimeConfig.maxResponseArtifactsPerRepo,
    maxStoredBytesPerRepo: runtimeConfig.maxResponseArtifactBytesPerRepo,
    maxStoredBytesTotal: runtimeConfig.maxResponseArtifactBytesTotal,
    maxArtifactsTotal: runtimeConfig.maxResponseArtifactsTotal,
    sessionId: opts.sessionId,
    requiresSameSession: true,
  });

  if (result.responseMode === "inline") {
    if (opts.responseMode === "auto") {
      recordTokenSavings({
        repoId: opts.repoId,
        source: "responseArtifact",
        tool: opts.toolName,
        estimatedTokensAvoided: 0,
        opportunity: true,
        hit: false,
        realized: false,
      });
    }
    return opts.payload;
  }
  const returnedTokens = estimateTokensFromPayload(result.payload);
  const savedTokens = Math.max(
    0,
    result.metadata.estimatedOriginalTokens - returnedTokens,
  );

  recordTokenSavings({
    repoId: opts.repoId,
    source: "responseArtifact",
    tool: opts.toolName,
    estimatedTokensAvoided: savedTokens,
    originalTokens: result.metadata.estimatedOriginalTokens,
    returnedTokens,
    savedTokens,
    storedBytes: result.metadata.storedBytes,
    opportunity: true,
    hit: true,
    realized: true,
  });

  const responsePayload =
    opts.payload &&
    typeof opts.payload === "object" &&
    "_rawContext" in opts.payload
      ? attachRawContext(
          result.payload,
          (opts.payload as { _rawContext: RawContextHint })._rawContext,
        )
      : result.payload;

  return attachTokenUsage(
    responsePayload,
    computeSavings(returnedTokens, result.metadata.estimatedOriginalTokens),
  );
}
