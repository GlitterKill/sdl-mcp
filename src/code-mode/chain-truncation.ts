import { randomBytes } from "node:crypto";

// --- Token estimation ---

/** Approximate tokens from a JSON string (chars / 4) */
function estimateJsonTokens(json: string): number {
  return Math.ceil(json.length / 4);
}

// --- Continuation store ---

interface ContinuationEntry {
  data: string;
  expiresAt: number;
}

const CONTINUATION_STORE = new Map<string, ContinuationEntry>();
const CONTINUATION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONTINUATIONS = 100;

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of CONTINUATION_STORE) {
    if (entry.expiresAt <= now) CONTINUATION_STORE.delete(key);
  }
}

// --- Truncation result types ---

export interface TruncationResult {
  truncated: unknown;
  handle: string;
  originalTokens: number;
  keptTokens: number;
}

export interface TruncatedResponseMeta {
  originalTokens: number;
  keptTokens: number;
  continuationHandle: string;
}

export interface ContinuationResult {
  data: unknown;
  totalTokens: number;
  hasMore: boolean;
}

// --- Smart truncation ---

function smartTruncate(result: unknown, maxTokens: number): unknown {
  const maxChars = maxTokens * 4;

  if (Array.isArray(result)) {
    const kept: unknown[] = [];
    let chars = 2; // []
    for (const item of result) {
      const itemJson = JSON.stringify(item);
      if (chars + itemJson.length + 1 > maxChars) break;
      kept.push(item);
      chars += itemJson.length + 1;
    }
    return kept;
  }

  if (result !== null && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const truncatedObj: Record<string, unknown> = {};
    let chars = 2; // {}

    for (const [key, value] of Object.entries(obj)) {
      const valueJson = JSON.stringify(value);
      const entrySize = key.length + valueJson.length + 4; // "key":value,

      if (chars + entrySize > maxChars) {
        // Try to include with truncated value
        if (Array.isArray(value) && value.length > 0) {
          const remainingBudget = Math.max(50, Math.floor((maxChars - chars) / 4));
          truncatedObj[key] = smartTruncate(value, remainingBudget);
          break;
        }
        if (typeof value === "string" && value.length > 100) {
          const maxStr = Math.max(50, maxChars - chars - key.length - 30);
          truncatedObj[key] = value.slice(0, maxStr) + "\u2026[truncated]";
          break;
        }
        break;
      }
      truncatedObj[key] = value;
      chars += entrySize;
    }
    return truncatedObj;
  }

  // Primitive
  if (typeof result === "string" && result.length > maxChars) {
    return result.slice(0, maxChars - 20) + "\u2026[truncated]";
  }
  return result;
}

// --- Public API ---

/**
 * Truncate a step result to fit within a token budget.
 * Returns the original result unchanged if it fits.
 * Otherwise, stores the full result for continuation retrieval and returns a truncated version.
 */
export function truncateStepResult(
  result: unknown,
  maxTokens: number,
): TruncationResult {
  const json = JSON.stringify(result);
  const originalTokens = estimateJsonTokens(json);

  if (originalTokens <= maxTokens) {
    return { truncated: result, handle: "", originalTokens, keptTokens: originalTokens };
  }

  const handle = `cont-${Date.now()}-${randomBytes(4).toString("hex")}`;

  // Store full result for continuation
  evictExpired();
  if (CONTINUATION_STORE.size >= MAX_CONTINUATIONS) {
    // Evict oldest entry
    const oldest = CONTINUATION_STORE.keys().next().value;
    if (oldest) CONTINUATION_STORE.delete(oldest);
  }
  CONTINUATION_STORE.set(handle, {
    data: json,
    expiresAt: Date.now() + CONTINUATION_TTL_MS,
  });

  const truncated = smartTruncate(result, maxTokens);
  const keptTokens = estimateJsonTokens(JSON.stringify(truncated));

  return { truncated, handle, originalTokens, keptTokens };
}

/**
 * Retrieve continuation data from a truncated step result.
 * For arrays, supports offset/limit pagination.
 */
export function getContinuation(
  handle: string,
  offset?: number,
  limit?: number,
): ContinuationResult | null {
  evictExpired();
  const entry = CONTINUATION_STORE.get(handle);
  if (!entry) return null;

  const parsed: unknown = JSON.parse(entry.data);
  const totalTokens = estimateJsonTokens(entry.data);

  if (Array.isArray(parsed) && (offset !== undefined || limit !== undefined)) {
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : parsed.length;
    return {
      data: parsed.slice(start, end),
      totalTokens,
      hasMore: end < parsed.length,
    };
  }

  return { data: parsed, totalTokens, hasMore: false };
}

/**
 * Clear all stored continuations.
 */
export function clearContinuationStore(): void {
  CONTINUATION_STORE.clear();
}
