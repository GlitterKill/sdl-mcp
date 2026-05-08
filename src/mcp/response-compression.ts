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
  stripRawContext,
  type RawContextHint,
} from "./token-usage.js";

export type { ResponseMode, ResponseArtifactReference };

export interface MaybeCompressToolResponseOptions<T> {
  repoId: string;
  toolName: string;
  payload: T;
  responseMode?: ResponseMode;
  rawContext?: RawContextHint;
  threshold?: number;
  sessionId?: string;
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
  const rawContext = opts.rawContext ?? extractRawContext(opts.payload);
  const payloadForStorage = stripRawContext(opts.payload);

  const result = await maybeStoreLargeResponse({
    repoId: opts.repoId,
    toolName: opts.toolName,
    payload: payloadForStorage,
    responseMode: opts.responseMode,
    threshold: opts.threshold,
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

  recordTokenSavings({
    repoId: opts.repoId,
    source: "responseArtifact",
    tool: opts.toolName,
    estimatedTokensAvoided: result.payload.savings.savedTokens,
    storedBytes: result.metadata.storedBytes,
    opportunity: true,
    hit: true,
    realized: true,
  });

  return rawContext
    ? attachRawContext(result.payload, rawContext)
    : result.payload;
}

function extractRawContext(payload: unknown): RawContextHint | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const rawContext = (payload as Record<string, unknown>)._rawContext;
  if (!rawContext || typeof rawContext !== "object") return undefined;
  return rawContext as RawContextHint;
}
