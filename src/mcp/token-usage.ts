import { estimateTokens } from "../util/tokenize.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { renderOperationMeter, renderNegativeSavingsMeter } from "./savings-meter.js";

export interface TokenUsageMetadata {
  sdlTokens: number;
  rawEquivalent: number;
  savingsPercent: number;
  meter: string;
}

export interface RawContextHint {
  fileIds?: string[];
  rawTokens?: number;
}

/** Tools that don't serve code context — no _tokenUsage for these. */
const SKIP_TOOLS = new Set([
  "sdl.repo.register",
  "sdl.repo.status",
  "sdl.repo.overview",
  "sdl.index.refresh",
  "sdl.policy.get",
  "sdl.policy.set",
  "sdl.agent.feedback",
  "sdl.agent.feedback.query",
  "sdl.usage.stats",
]);

const BYTES_PER_TOKEN = 4;

export function shouldAttachUsage(toolName: string): boolean {
  return !SKIP_TOOLS.has(toolName);
}

export function computeSavings(
  sdlTokens: number,
  rawEquivalent: number,
): TokenUsageMetadata {
  if (rawEquivalent > 0 && sdlTokens < rawEquivalent) {
    // Positive savings
    const savingsPercent = Math.round((1 - sdlTokens / rawEquivalent) * 100);
    return { sdlTokens, rawEquivalent, savingsPercent, meter: renderOperationMeter(savingsPercent) };
  }

  if (rawEquivalent > 0 && sdlTokens > rawEquivalent) {
    // Suppress overhead warning for trivially small raw outputs where
    // SDL envelope overhead is expected and not actionable.
    if (rawEquivalent < 50) {
      return { sdlTokens, rawEquivalent, savingsPercent: 0, meter: renderOperationMeter(0) };
    }
    // Negative savings: SDL response is larger than raw equivalent.
    // Report negative percentage so callers see the overhead honestly.
    const overheadPercent = Math.round(((sdlTokens / rawEquivalent) - 1) * 100);
    const savingsPercent = -overheadPercent;
    return {
      sdlTokens,
      rawEquivalent,
      savingsPercent,
      meter: renderNegativeSavingsMeter(overheadPercent),
    };
  }

  // No savings (equal or zero raw equivalent)
  return { sdlTokens, rawEquivalent, savingsPercent: 0, meter: renderOperationMeter(0) };
}

export async function computeTokenUsage(
  result: Record<string, unknown>,
): Promise<TokenUsageMetadata> {
  const hint = result._rawContext as RawContextHint | undefined;
  if (!hint) {
    return { sdlTokens: 0, rawEquivalent: 0, savingsPercent: 0, meter: renderOperationMeter(0) };
  }

  const { _rawContext: _, ...cleanResult } = result;
  const sdlTokens = estimateTokens(JSON.stringify(cleanResult));

  let rawEquivalent = 0;
  if (hint.rawTokens !== undefined) {
    rawEquivalent = hint.rawTokens;
  } else if (hint.fileIds && hint.fileIds.length > 0) {
    const conn = await getLadybugConn();
    const files = await ladybugDb.getFilesByIds(conn, hint.fileIds);
    for (const file of files.values()) {
      rawEquivalent += Math.ceil(file.byteSize / BYTES_PER_TOKEN);
    }
  }

  return computeSavings(sdlTokens, rawEquivalent);
}

/**
 * Attach a _rawContext hint to a handler result by cloning.
 * Returns a shallow copy so the original object is not mutated,
 * preventing cache pollution when results are reused.
 */
const MAX_RAW_CONTEXT_FILE_IDS = 10;

export function attachRawContext<T>(result: T, hint: RawContextHint): T {
  if (result && typeof result === "object") {
    // Cap fileIds to avoid response bloat in workflow step results
    const bounded = hint.fileIds && hint.fileIds.length > MAX_RAW_CONTEXT_FILE_IDS
      ? { ...hint, fileIds: hint.fileIds.slice(0, MAX_RAW_CONTEXT_FILE_IDS) }
      : hint;
    return { ...result, _rawContext: bounded } as T;
  }
  return result;
}

export function stripRawContext<T>(result: T): T {
  if (result && typeof result === "object" && "_rawContext" in result) {
    const { _rawContext: _, ...rest } = result as Record<string, unknown>;
    return rest as T;
  }
  return result;
}
