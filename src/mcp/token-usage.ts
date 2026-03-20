import { estimateTokens } from "../util/tokenize.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";

export interface TokenUsageMetadata {
  sdlTokens: number;
  rawEquivalent: number;
  savingsPercent: number;
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
  const savingsPercent =
    rawEquivalent > 0 && sdlTokens < rawEquivalent
      ? Math.round((1 - sdlTokens / rawEquivalent) * 100)
      : 0;

  return { sdlTokens, rawEquivalent, savingsPercent };
}

export async function computeTokenUsage(
  result: Record<string, unknown>,
): Promise<TokenUsageMetadata> {
  const hint = result._rawContext as RawContextHint | undefined;
  if (!hint) {
    return { sdlTokens: 0, rawEquivalent: 0, savingsPercent: 0 };
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
 * Attach a _rawContext hint to a handler result via mutation.
 * Returns the same object so it can be used inline at return sites
 * without conflicting with the handler's declared return type.
 */
export function attachRawContext<T>(result: T, hint: RawContextHint): T {
  if (result && typeof result === "object") {
    (result as Record<string, unknown>)._rawContext = hint;
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
