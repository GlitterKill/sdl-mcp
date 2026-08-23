import { randomBytes } from "node:crypto";

import { estimateTokensCoarse } from "../util/tokenize.js";

// --- Token estimation ---

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

function upsertContinuation(handle: string, data: string): void {
  evictExpired();

  if (CONTINUATION_STORE.has(handle)) {
    // Reinsert existing handles to refresh their FIFO position without growing the store.
    CONTINUATION_STORE.delete(handle);
  } else if (CONTINUATION_STORE.size >= MAX_CONTINUATIONS) {
    // Batch eviction prevents rapid churn when a burst fills the bounded store.
    const evictCount = Math.max(1, Math.floor(MAX_CONTINUATIONS * 0.1));
    const keys = Array.from(CONTINUATION_STORE.keys()).slice(0, evictCount);
    for (const key of keys) {
      CONTINUATION_STORE.delete(key);
    }
  }

  CONTINUATION_STORE.set(handle, {
    data,
    expiresAt: Date.now() + CONTINUATION_TTL_MS,
  });
}

/** Store a complete result behind the workflow continuation retrieval action. */
export function storeContinuation(result: unknown): string {
  const handle = `cont-${Date.now()}-${randomBytes(4).toString("hex")}`;

  upsertContinuation(handle, safeJsonStringify(result));

  return handle;
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
    totalTokens: estimateTokensCoarse(JSON.stringify(data)),
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
  if (value === undefined) return true;
  if (Array.isArray(value)) {
    return value.length === 0 || value.every(isEmptyTruncationPreview);
  }
  if (isRecordValue(value)) {
    const fields = Object.values(value);
    return fields.length === 0 || fields.every(isEmptyTruncationPreview);
  }
  return false;
}

function truncationMarker(): Record<string, unknown> {
  return {
    truncated: true,
    reason:
      "maxResponseTokens is too low to include result fields.",
  };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactCardHeader(card: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ["symbolId", "name", "kind", "file"].flatMap((key) =>
      card[key] === undefined ? [] : [[key, card[key]]],
    ),
  );
}

function minimumCardPreview(original: unknown): unknown | undefined {
  if (!isRecordValue(original)) return undefined;
  if (isRecordValue(original.card)) {
    return { card: compactCardHeader(original.card) };
  }
  if (Array.isArray(original.cards)) {
    const cards = original.cards
      .filter(isRecordValue)
      .slice(0, 3)
      .map(compactCardHeader);
    return cards.length > 0 ? { cards } : undefined;
  }
  return undefined;
}

function isGenericTruncationMarker(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    value.truncated === true &&
    typeof value.reason === "string" &&
    Object.keys(value).length <= 2
  );
}

function ensureVisibleTruncationPreview(
  value: unknown,
  original: unknown,
): unknown {
  if (isEmptyTruncationPreview(value) || isGenericTruncationMarker(value)) {
    return minimumCardPreview(original) ?? truncationMarker();
  }
  return value;
}

const VOLATILE_WORKFLOW_FIELDS = new Set([
  "durationMs",
  "tokens",
  "totalTokens",
  "tokenEstimate",
  "tokenMetrics",
  "generatedAt",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "timestamp",
  "sessionId",
  "trace",
  "diagnostics",
]);

const WORKFLOW_TELEMETRY_FIELDS = new Set([
  "durationMs",
  "tokens",
  "totalTokens",
  "tokenEstimate",
  "tokenMetrics",
]);

/** Remove workflow-envelope volatility before a step projection is exposed or stored. */
export function sanitizeWorkflowStepValue(
  value: unknown,
  includeDiagnostics = false,
  includeTelemetry = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) =>
      sanitizeWorkflowStepValue(child, includeDiagnostics, includeTelemetry)
    );
  }
  if (!isRecordValue(value)) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      !VOLATILE_WORKFLOW_FIELDS.has(key)
      || (key === "diagnostics" && includeDiagnostics)
      || (includeTelemetry && WORKFLOW_TELEMETRY_FIELDS.has(key))
    ) {
      sanitized[key] = sanitizeWorkflowStepValue(
        child,
        includeDiagnostics,
        includeTelemetry,
      );
    }
  }
  return sanitized;
}

export function truncateStepResult(
  result: unknown,
  maxTokens: number,
  continuationHandle?: string,
): TruncationResult {
  const json = safeJsonStringify(result);
  const originalTokens = estimateTokensCoarse(json);

  if (continuationHandle) {
    // Keep the executor-created handle synchronized even when reprojection now fits inline.
    upsertContinuation(continuationHandle, json);
  }

  const needsVisiblePreview =
    continuationHandle !== undefined && isEmptyTruncationPreview(result);
  if (!needsVisiblePreview && originalTokens <= maxTokens) {
    return {
      truncated: result,
      handle: "",
      originalTokens,
      keptTokens: originalTokens,
    };
  }

  const handle = continuationHandle || storeContinuation(result);

  const truncated = ensureVisibleTruncationPreview(
    smartTruncate(result, maxTokens),
    result,
  );
  const keptTokens = estimateTokensCoarse(safeJsonStringify(truncated));

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
  return getContinuationInternal(handle, offset, limit, path);
}

/** Projects the selected value before paging while preserving the raw store. */
export function getContinuationWithProjection(
  handle: string,
  projectValue: (value: unknown) => unknown,
  offset?: number,
  limit?: number,
  path?: string,
): ContinuationResult | null {
  return getContinuationInternal(
    handle,
    offset,
    limit,
    path,
    projectValue,
  );
}

function getContinuationInternal(
  handle: string,
  offset?: number,
  limit?: number,
  path?: string,
  projectValue?: (value: unknown) => unknown,
): ContinuationResult | null {
  evictExpired();
  const entry = CONTINUATION_STORE.get(handle);
  if (!entry) return null;

  const stored: unknown = JSON.parse(entry.data);
  const parsed = path === undefined && projectValue
    ? projectValue(stored)
    : stored;
  const serialized = parsed === stored ? entry.data : safeJsonStringify(parsed);
  const totalTokens = estimateTokensCoarse(serialized);

  if (path) {
    const storedSelection = navigatePath(parsed, path);
    if (storedSelection === undefined) {
      throw new Error(`Continuation path not found: ${path}`);
    }
    const selected = projectValue
      ? projectValue(storedSelection)
      : storedSelection;
    if (Array.isArray(selected)) {
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 0;
        const end = limit !== undefined ? start + limit : selected.length;
        const data = selected.slice(start, end);
        return {
          data,
          totalTokens: estimateTokensCoarse(safeJsonStringify(data)),
          hasMore: end < selected.length,
        };
      }
      return {
        data: selected,
        totalTokens: estimateTokensCoarse(safeJsonStringify(selected)),
        hasMore: false,
      };
    }
    if (typeof selected === "string") {
      if (offset !== undefined || limit !== undefined) {
        return stringChunk(selected, offset, limit, "text");
      }
      return {
        data: selected,
        totalTokens: estimateTokensCoarse(safeJsonStringify(selected)),
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
      totalTokens: estimateTokensCoarse(safeJsonStringify(selected)),
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
    const source = typeof parsed === "string" ? parsed : serialized;
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
