import { randomBytes } from "node:crypto";

// --- Token estimation ---

/** Approximate tokens from a JSON string (chars / 4) */
function estimateJsonTokens(json: string): number {
  return Math.ceil(json.length / 4);
}

function safeJsonStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "function") return "[Function]";
      if (typeof item === "symbol") return item.toString();
      if (item === undefined) return null;
      return item;
    });
    return json ?? "null";
  } catch {
    return JSON.stringify(String(value));
  }
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

function navigatePath(obj: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (/^\d+$/.test(segment)) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(segment)];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
}

function stringChunk(
  source: string,
  offset: number | undefined,
  limit: number | undefined,
  encoding: "text" | "json",
): ContinuationResult {
  const start = Math.min(offset ?? 0, source.length);
  const requestedChars = limit ?? 12000;
  const charLimit = Math.max(1, Math.min(requestedChars, 12000));
  const end = Math.min(start + charLimit, source.length);
  const data = {
    content: source.slice(start, end),
    encoding,
    offset: start,
    nextOffset: end < source.length ? end : null,
    totalBytes: source.length,
  };
  return {
    data,
    totalTokens: estimateJsonTokens(JSON.stringify(data)),
    hasMore: end < source.length,
  };
}

// --- Smart truncation ---

function smartTruncate(result: unknown, maxTokens: number): unknown {
  const maxChars = maxTokens * 4;

  if (Array.isArray(result)) {
    const kept: unknown[] = [];
    let chars = 2; // []
    for (const item of result) {
      const itemJson = safeJsonStringify(item);
      if (chars + itemJson.length + 1 > maxChars) break;
      kept.push(item);
      chars += itemJson.length + 1;
    }
    if (result.length > 0 && kept.length === 0) {
      return truncationMarker();
    }
    return kept;
  }

  if (result !== null && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const truncatedObj: Record<string, unknown> = {};
    let chars = 2; // {}

    for (const [key, value] of Object.entries(obj)) {
      const valueJson = safeJsonStringify(value);
      const entrySize = key.length + valueJson.length + 4; // "key":value,

      if (chars + entrySize > maxChars) {
        // Try to include with truncated value
        if (Array.isArray(value) && value.length > 0) {
          const remainingBudget = Math.max(
            50,
            Math.floor((maxChars - chars) / 4),
          );
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
    if (Object.keys(obj).length > 0 && Object.keys(truncatedObj).length === 0) {
      return truncationMarker();
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
function isEmptyTruncationPreview(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

function truncationMarker(): Record<string, unknown> {
  return {
    truncated: true,
    reason:
      "maxResponseTokens is too low to include result fields; use truncatedResponse.continuationHandle to fetch the full result.",
  };
}

function ensureVisibleTruncationPreview(value: unknown): unknown {
  return isEmptyTruncationPreview(value) ? truncationMarker() : value;
}

export function truncateStepResult(
  result: unknown,
  maxTokens: number,
): TruncationResult {
  const json = safeJsonStringify(result);
  const originalTokens = estimateJsonTokens(json);

  if (originalTokens <= maxTokens) {
    return {
      truncated: result,
      handle: "",
      originalTokens,
      keptTokens: originalTokens,
    };
  }

  const handle = `cont-${Date.now()}-${randomBytes(4).toString("hex")}`;

  // Store full result for continuation
  evictExpired();
  if (CONTINUATION_STORE.size >= MAX_CONTINUATIONS) {
    // Evict 10% of entries (batch eviction prevents rapid churn from bursts)
    const evictCount = Math.max(1, Math.floor(MAX_CONTINUATIONS * 0.1));
    const keys = Array.from(CONTINUATION_STORE.keys()).slice(0, evictCount);
    for (const key of keys) {
      CONTINUATION_STORE.delete(key);
    }
  }
  CONTINUATION_STORE.set(handle, {
    data: json,
    expiresAt: Date.now() + CONTINUATION_TTL_MS,
  });

  const truncated = ensureVisibleTruncationPreview(
    smartTruncate(result, maxTokens),
  );
  const keptTokens = estimateJsonTokens(safeJsonStringify(truncated));

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
  path?: string,
): ContinuationResult | null {
  evictExpired();
  const entry = CONTINUATION_STORE.get(handle);
  if (!entry) return null;

  const parsed: unknown = JSON.parse(entry.data);
  const totalTokens = estimateJsonTokens(entry.data);

  if (path) {
    const selected = navigatePath(parsed, path);
    if (selected === undefined) {
      throw new Error(`Continuation path not found: ${path}`);
    }
    if (Array.isArray(selected)) {
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 0;
        const end = limit !== undefined ? start + limit : selected.length;
        const data = selected.slice(start, end);
        return {
          data,
          totalTokens: estimateJsonTokens(safeJsonStringify(data)),
          hasMore: end < selected.length,
        };
      }
      return {
        data: selected,
        totalTokens: estimateJsonTokens(safeJsonStringify(selected)),
        hasMore: false,
      };
    }
    if (typeof selected === "string") {
      if (offset !== undefined || limit !== undefined) {
        return stringChunk(selected, offset, limit, "text");
      }
      return {
        data: selected,
        totalTokens: estimateJsonTokens(safeJsonStringify(selected)),
        hasMore: false,
      };
    }
    if (offset !== undefined || limit !== undefined) {
      throw new Error(
        `Continuation path ${path} is not an array or string; remove offset/limit.`,
      );
    }
    return {
      data: selected,
      totalTokens: estimateJsonTokens(safeJsonStringify(selected)),
      hasMore: false,
    };
  }

  if (Array.isArray(parsed) && (offset !== undefined || limit !== undefined)) {
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : parsed.length;
    return {
      data: parsed.slice(start, end),
      totalTokens,
      hasMore: end < parsed.length,
    };
  }

  const maxInlineTokens = 4000;
  if (offset !== undefined || limit !== undefined || totalTokens > maxInlineTokens) {
    const source = typeof parsed === "string" ? parsed : entry.data;
    return stringChunk(source, offset, limit, typeof parsed === "string" ? "text" : "json");
  }

  return { data: parsed, totalTokens, hasMore: false };
}

/**
 * Clear all stored continuations.
 */
export function clearContinuationStore(): void {
  CONTINUATION_STORE.clear();
}
