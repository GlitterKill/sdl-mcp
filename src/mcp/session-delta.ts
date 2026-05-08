import { createHash } from "node:crypto";

import { estimateTokens } from "../util/tokenize.js";

export type SessionDeltaMode = "off" | "auto";

export interface SessionDeltaRange {
  startLine: number;
  endLine: number;
}

export interface SessionDeltaWindowKey {
  toolName: string;
  repoId: string;
  filePath?: string;
  symbolId?: string;
  range?: SessionDeltaRange;
  extra?: Readonly<Record<string, string | number | boolean | undefined>>;
}

export interface SessionDeltaRequest {
  sessionId?: string;
  key: string | SessionDeltaWindowKey;
  content: string;
  deltaMode?: SessionDeltaMode;
  maxDeltaLines?: number;
  contentHash?: string;
  etag?: string;
  nowMs?: number;
}

export interface SessionDeltaMetadata {
  cacheHit: boolean;
  deltaApplied: boolean;
  stableKey: string;
  currentContentHash: string;
  previousContentHash?: string;
  etag?: string;
  estimatedFullTokens: number;
  estimatedDeltaTokens: number;
  estimatedTokensAvoided: number;
  reason?:
    | "delta-off"
    | "no-session"
    | "cache-miss"
    | "content-too-large"
    | "delta-too-large";
}

export interface SessionDeltaPayload {
  format: "unified-line-diff";
  status: "unchanged" | "changed";
  excerpt?: string;
  changedLineCount: number;
  maxDeltaLines: number;
  truncated: boolean;
}

export interface SessionDeltaResult {
  mode: "off" | "miss" | "unchanged" | "changed";
  content?: string;
  delta?: SessionDeltaPayload;
  metadata: SessionDeltaMetadata;
}

export interface SessionDeltaCacheOptions {
  ttlMs?: number;
  maxSessions?: number;
  maxEntriesPerSession?: number;
  defaultMaxDeltaLines?: number;
  maxEntryBytes?: number;
  maxBytesPerSession?: number;
  maxTotalBytes?: number;
}

interface SessionDeltaEntry {
  stableKey: string;
  content: string;
  contentHash: string;
  bytes: number;
  etag?: string;
  createdAtMs: number;
  lastAccessMs: number;
}

interface SessionBucket {
  entries: Map<string, SessionDeltaEntry>;
  lastAccessMs: number;
  bytes: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_MAX_ENTRIES_PER_SESSION = 64;
const DEFAULT_MAX_DELTA_LINES = 80;
const DEFAULT_MAX_ENTRY_BYTES = 128 * 1024;
const DEFAULT_MAX_BYTES_PER_SESSION = 512 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * Per-process cache for raw-window deltas. Entries are scoped by session first,
 * then by stable window identity so one client cannot receive another client's
 * cached content.
 */
export class SessionDeltaCache {
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly maxEntriesPerSession: number;
  private readonly defaultMaxDeltaLines: number;
  private readonly maxEntryBytes: number;
  private readonly maxBytesPerSession: number;
  private readonly maxTotalBytes: number;
  private readonly sessions = new Map<string, SessionBucket>();
  private totalBytes = 0;

  constructor(options: SessionDeltaCacheOptions = {}) {
    this.ttlMs = positiveIntOrDefault(options.ttlMs, DEFAULT_TTL_MS);
    this.maxSessions = positiveIntOrDefault(
      options.maxSessions,
      DEFAULT_MAX_SESSIONS,
    );
    this.maxEntriesPerSession = positiveIntOrDefault(
      options.maxEntriesPerSession,
      DEFAULT_MAX_ENTRIES_PER_SESSION,
    );
    this.defaultMaxDeltaLines = positiveIntOrDefault(
      options.defaultMaxDeltaLines,
      DEFAULT_MAX_DELTA_LINES,
    );
    this.maxEntryBytes = positiveIntOrDefault(
      options.maxEntryBytes,
      DEFAULT_MAX_ENTRY_BYTES,
    );
    this.maxBytesPerSession = positiveIntOrDefault(
      options.maxBytesPerSession,
      DEFAULT_MAX_BYTES_PER_SESSION,
    );
    this.maxTotalBytes = positiveIntOrDefault(
      options.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
    );
  }

  maybeBuildSessionDelta(request: SessionDeltaRequest): SessionDeltaResult {
    const nowMs = request.nowMs ?? Date.now();
    const deltaMode = request.deltaMode ?? "off";
    const stableKey = buildSessionDeltaKey(request.key);
    const currentContentHash =
      request.contentHash ?? hashSessionDeltaContent(request.content);
    const estimatedFullTokens = estimateTokens(request.content);

    if (deltaMode === "off") {
      return buildBypassResult({
        mode: "off",
        content: request.content,
        stableKey,
        currentContentHash,
        etag: request.etag,
        estimatedFullTokens,
        reason: "delta-off",
      });
    }

    if (!request.sessionId) {
      return buildBypassResult({
        mode: "miss",
        content: request.content,
        stableKey,
        currentContentHash,
        etag: request.etag,
        estimatedFullTokens,
        reason: "no-session",
      });
    }

    this.pruneExpired(nowMs);

    const bucket = this.getOrCreateBucket(request.sessionId, nowMs);
    bucket.lastAccessMs = nowMs;
    const previous = bucket.entries.get(stableKey);
    const contentBytes = Buffer.byteLength(request.content, "utf-8");
    if (contentBytes > this.maxEntryBytes) {
      if (previous) {
        this.deleteEntry(bucket, stableKey);
      }
      return buildBypassResult({
        mode: "miss",
        content: request.content,
        stableKey,
        currentContentHash,
        etag: request.etag,
        estimatedFullTokens,
        reason: "content-too-large",
      });
    }
    const current: SessionDeltaEntry = {
      stableKey,
      content: request.content,
      contentHash: currentContentHash,
      bytes: contentBytes,
      etag: request.etag,
      createdAtMs: nowMs,
      lastAccessMs: nowMs,
    };
    if (previous) {
      this.deleteEntry(bucket, stableKey);
    }
    bucket.entries.set(stableKey, current);
    bucket.bytes += current.bytes;
    this.totalBytes += current.bytes;
    this.enforceEntryLimit(bucket);
    this.enforceByteLimits(bucket);
    this.enforceSessionLimit();

    if (!previous) {
      return buildBypassResult({
        mode: "miss",
        content: request.content,
        stableKey,
        currentContentHash,
        etag: request.etag,
        estimatedFullTokens,
        reason: "cache-miss",
      });
    }

    previous.lastAccessMs = nowMs;

    if (
      previous.contentHash === currentContentHash ||
      previous.content === request.content
    ) {
      return {
        mode: "unchanged",
        metadata: {
          cacheHit: true,
          deltaApplied: true,
          stableKey,
          currentContentHash,
          previousContentHash: previous.contentHash,
          etag: request.etag,
          estimatedFullTokens,
          estimatedDeltaTokens: 0,
          estimatedTokensAvoided: estimatedFullTokens,
        },
        delta: {
          format: "unified-line-diff",
          status: "unchanged",
          changedLineCount: 0,
          maxDeltaLines: resolveMaxDeltaLines(
            request.maxDeltaLines,
            this.defaultMaxDeltaLines,
          ),
          truncated: false,
        },
      };
    }

    const maxDeltaLines = resolveMaxDeltaLines(
      request.maxDeltaLines,
      this.defaultMaxDeltaLines,
    );
    const diff = buildBoundedUnifiedLineDiff(
      previous.content,
      request.content,
      maxDeltaLines,
    );
    const estimatedDeltaTokens = estimateTokens(diff.excerpt);
    if (diff.truncated) {
      return {
        mode: "miss",
        content: request.content,
        metadata: {
          cacheHit: true,
          deltaApplied: false,
          stableKey,
          currentContentHash,
          previousContentHash: previous.contentHash,
          etag: request.etag,
          estimatedFullTokens,
          estimatedDeltaTokens,
          estimatedTokensAvoided: 0,
          reason: "delta-too-large",
        },
      };
    }

    return {
      mode: "changed",
      metadata: {
        cacheHit: true,
        deltaApplied: true,
        stableKey,
        currentContentHash,
        previousContentHash: previous.contentHash,
        etag: request.etag,
        estimatedFullTokens,
        estimatedDeltaTokens,
        estimatedTokensAvoided: Math.max(
          0,
          estimatedFullTokens - estimatedDeltaTokens,
        ),
      },
      delta: {
        format: "unified-line-diff",
        status: "changed",
        excerpt: diff.excerpt,
        changedLineCount: diff.changedLineCount,
        maxDeltaLines,
        truncated: diff.truncated,
      },
    };
  }

  clear(): void {
    this.sessions.clear();
    this.totalBytes = 0;
  }

  getStats(): { sessions: number; entries: number } {
    let entries = 0;
    for (const bucket of this.sessions.values()) {
      entries += bucket.entries.size;
    }
    return { sessions: this.sessions.size, entries };
  }

  private getOrCreateBucket(sessionId: string, nowMs: number): SessionBucket {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const bucket = {
      entries: new Map<string, SessionDeltaEntry>(),
      lastAccessMs: nowMs,
      bytes: 0,
    };
    this.sessions.set(sessionId, bucket);
    return bucket;
  }

  private pruneExpired(nowMs: number): void {
    const cutoffMs = nowMs - this.ttlMs;
    for (const [sessionId, bucket] of this.sessions) {
      for (const [key, entry] of bucket.entries) {
        if (entry.lastAccessMs < cutoffMs) {
          this.deleteEntry(bucket, key);
        }
      }
      if (bucket.entries.size === 0 && bucket.lastAccessMs < cutoffMs) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private enforceEntryLimit(bucket: SessionBucket): void {
    while (bucket.entries.size > this.maxEntriesPerSession) {
      const oldestKey = findOldestEntryKey(bucket.entries);
      if (!oldestKey) return;
      this.deleteEntry(bucket, oldestKey);
    }
  }

  private enforceByteLimits(bucket: SessionBucket): void {
    while (bucket.bytes > this.maxBytesPerSession) {
      const oldestKey = findOldestEntryKey(bucket.entries);
      if (!oldestKey) return;
      this.deleteEntry(bucket, oldestKey);
    }

    while (this.totalBytes > this.maxTotalBytes) {
      const oldest = this.findOldestEntryAcrossSessions();
      if (!oldest) return;
      this.deleteEntry(oldest.bucket, oldest.key);
    }
  }

  private enforceSessionLimit(): void {
    while (this.sessions.size > this.maxSessions) {
      let oldestSessionId: string | undefined;
      let oldestAccessMs = Number.POSITIVE_INFINITY;

      for (const [sessionId, bucket] of this.sessions) {
        if (bucket.lastAccessMs < oldestAccessMs) {
          oldestAccessMs = bucket.lastAccessMs;
          oldestSessionId = sessionId;
        }
      }

      if (!oldestSessionId) return;
      const bucket = this.sessions.get(oldestSessionId);
      if (bucket) this.totalBytes -= bucket.bytes;
      this.sessions.delete(oldestSessionId);
    }
  }

  private deleteEntry(bucket: SessionBucket, key: string): void {
    const entry = bucket.entries.get(key);
    if (!entry) return;
    bucket.entries.delete(key);
    bucket.bytes = Math.max(0, bucket.bytes - entry.bytes);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
  }

  private findOldestEntryAcrossSessions():
    | { bucket: SessionBucket; key: string }
    | undefined {
    let oldest:
      | { bucket: SessionBucket; key: string; lastAccessMs: number }
      | undefined;
    for (const bucket of this.sessions.values()) {
      for (const [key, entry] of bucket.entries) {
        if (!oldest || entry.lastAccessMs < oldest.lastAccessMs) {
          oldest = { bucket, key, lastAccessMs: entry.lastAccessMs };
        }
      }
    }
    return oldest;
  }
}

export const defaultSessionDeltaCache = new SessionDeltaCache();

/**
 * Returns full content on miss/off, or compact same-session delta information
 * on cache hits. Callers can preserve existing behavior by leaving
 * `deltaMode` unset or explicitly passing `"off"`.
 */
export function maybeBuildSessionDelta(
  request: SessionDeltaRequest,
  cache = defaultSessionDeltaCache,
): SessionDeltaResult {
  return cache.maybeBuildSessionDelta(request);
}

/**
 * Builds the reusable window identity. Content hashes and etags are intentionally
 * metadata, not key parts, because changed content still needs to hit the prior
 * window entry to produce a diff.
 */
export function buildSessionDeltaKey(
  key: string | SessionDeltaWindowKey,
): string {
  if (typeof key === "string") return key;

  const parts = [
    `tool=${key.toolName}`,
    `repo=${key.repoId}`,
    key.filePath ? `file=${key.filePath}` : undefined,
    key.symbolId ? `symbol=${key.symbolId}` : undefined,
    key.range ? `range=${key.range.startLine}-${key.range.endLine}` : undefined,
    ...stableExtraParts(key.extra),
  ];

  return parts.filter((part): part is string => Boolean(part)).join("|");
}

export function hashSessionDeltaContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function buildBoundedUnifiedLineDiff(
  previousContent: string,
  currentContent: string,
  maxDeltaLines: number,
): { excerpt: string; changedLineCount: number; truncated: boolean } {
  const previousLines = splitLines(previousContent);
  const currentLines = splitLines(currentContent);
  let prefixLength = 0;

  while (
    prefixLength < previousLines.length &&
    prefixLength < currentLines.length &&
    previousLines[prefixLength] === currentLines[prefixLength]
  ) {
    prefixLength++;
  }

  let previousSuffix = previousLines.length - 1;
  let currentSuffix = currentLines.length - 1;
  while (
    previousSuffix >= prefixLength &&
    currentSuffix >= prefixLength &&
    previousLines[previousSuffix] === currentLines[currentSuffix]
  ) {
    previousSuffix--;
    currentSuffix--;
  }

  const removed = previousLines.slice(prefixLength, previousSuffix + 1);
  const added = currentLines.slice(prefixLength, currentSuffix + 1);
  const changedLineCount = removed.length + added.length;
  const header = `@@ -${prefixLength + 1},${removed.length} +${prefixLength + 1},${added.length} @@`;
  // Keep the algorithm deliberately simple: a single changed hunk with common
  // prefix/suffix trimming is enough for repeated raw windows and avoids a
  // heavyweight diff dependency in the hot path.
  const diffLines = [
    header,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  const truncated = diffLines.length > maxDeltaLines;
  const boundedLines = truncated
    ? [
        ...diffLines.slice(0, Math.max(1, maxDeltaLines - 1)),
        `... truncated ${diffLines.length - Math.max(1, maxDeltaLines - 1)} diff lines`,
      ]
    : diffLines;

  return {
    excerpt: boundedLines.join("\n"),
    changedLineCount,
    truncated,
  };
}

function splitLines(content: string): string[] {
  if (content === "") return [];
  return content.split(/\r?\n/);
}

function positiveIntOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

function resolveMaxDeltaLines(
  requested: number | undefined,
  fallback: number,
): number {
  return positiveIntOrDefault(requested, fallback);
}

function buildBypassResult(args: {
  mode: "off" | "miss";
  content: string;
  stableKey: string;
  currentContentHash: string;
  etag?: string;
  estimatedFullTokens: number;
  reason: SessionDeltaMetadata["reason"];
}): SessionDeltaResult {
  return {
    mode: args.mode,
    content: args.content,
    metadata: {
      cacheHit: false,
      deltaApplied: false,
      stableKey: args.stableKey,
      currentContentHash: args.currentContentHash,
      etag: args.etag,
      estimatedFullTokens: args.estimatedFullTokens,
      estimatedDeltaTokens: args.estimatedFullTokens,
      estimatedTokensAvoided: 0,
      reason: args.reason,
    },
  };
}

function findOldestEntryKey(
  entries: Map<string, SessionDeltaEntry>,
): string | undefined {
  let oldestKey: string | undefined;
  let oldestAccessMs = Number.POSITIVE_INFINITY;

  for (const [key, entry] of entries) {
    if (entry.lastAccessMs < oldestAccessMs) {
      oldestAccessMs = entry.lastAccessMs;
      oldestKey = key;
    }
  }

  return oldestKey;
}

function stableExtraParts(
  extra:
    | Readonly<Record<string, string | number | boolean | undefined>>
    | undefined,
): string[] {
  if (!extra) return [];

  return Object.keys(extra)
    .sort()
    .flatMap((key) => {
      const value = extra[key];
      return value === undefined ? [] : [`${key}=${String(value)}`];
    });
}
