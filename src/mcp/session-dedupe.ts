export interface LedgerRecordInput {
  sessionId?: string;
  key: string;
  contentHash: string;
  etag?: string;
  nowMs?: number;
}

export interface LedgerRecordResult {
  status: "new" | "unchanged" | "changed";
  priorEtag?: string;
}

export interface SessionContentLedgerOptions {
  ttlMs?: number;
  maxSessions?: number;
  maxEntriesPerSession?: number;
}

interface LedgerEntry {
  contentHash: string;
  etag?: string;
  lastAccessMs: number;
}

interface SessionLedgerBucket {
  entries: Map<string, LedgerEntry>;
  // Remember evicted keys so a stale retry cannot evict still-live entries.
  evictedKeys: Set<string>;
  lastAccessMs: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_MAX_ENTRIES_PER_SESSION = 4096;

export class SessionContentLedger {
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly maxEntriesPerSession: number;
  private readonly sessions = new Map<string, SessionLedgerBucket>();

  constructor(options: SessionContentLedgerOptions = {}) {
    this.ttlMs = positiveIntOrDefault(options.ttlMs, DEFAULT_TTL_MS);
    this.maxSessions = positiveIntOrDefault(
      options.maxSessions,
      DEFAULT_MAX_SESSIONS,
    );
    this.maxEntriesPerSession = positiveIntOrDefault(
      options.maxEntriesPerSession,
      DEFAULT_MAX_ENTRIES_PER_SESSION,
    );
  }

  record(input: LedgerRecordInput): LedgerRecordResult {
    if (!input.sessionId) return { status: "new" };

    const nowMs = input.nowMs ?? Date.now();
    this.pruneExpired(nowMs);

    const bucket = this.getOrCreateBucket(input.sessionId, nowMs);
    this.markSessionAccessed(input.sessionId, bucket, nowMs);

    const prior = bucket.entries.get(input.key);
    if (!prior && bucket.evictedKeys.has(input.key)) {
      return { status: "new" };
    }

    if (prior) bucket.entries.delete(input.key);
    const entry: LedgerEntry = {
      contentHash: input.contentHash,
      lastAccessMs: nowMs,
    };
    if (input.etag !== undefined) entry.etag = input.etag;
    bucket.entries.set(input.key, entry);
    this.enforceEntryLimit(bucket);
    this.enforceSessionLimit();

    if (!prior) return { status: "new" };

    const result: LedgerRecordResult = {
      status: prior.contentHash === input.contentHash ? "unchanged" : "changed",
    };
    if (prior.etag !== undefined) result.priorEtag = prior.etag;
    return result;
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get entryCount(): number {
    let entries = 0;
    for (const bucket of this.sessions.values()) {
      entries += bucket.entries.size;
    }
    return entries;
  }

  get size(): number {
    return this.entryCount;
  }

  private getOrCreateBucket(
    sessionId: string,
    nowMs: number,
  ): SessionLedgerBucket {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const bucket = {
      entries: new Map<string, LedgerEntry>(),
      evictedKeys: new Set<string>(),
      lastAccessMs: nowMs,
    };
    this.sessions.set(sessionId, bucket);
    return bucket;
  }

  private markSessionAccessed(
    sessionId: string,
    bucket: SessionLedgerBucket,
    nowMs: number,
  ): void {
    bucket.lastAccessMs = nowMs;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, bucket);
  }

  private pruneExpired(nowMs: number): void {
    const cutoffMs = nowMs - this.ttlMs;
    for (const [sessionId, bucket] of this.sessions) {
      for (const [key, entry] of bucket.entries) {
        if (entry.lastAccessMs < cutoffMs) {
          bucket.entries.delete(key);
        }
      }
      if (bucket.entries.size === 0 && bucket.lastAccessMs < cutoffMs) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private enforceEntryLimit(bucket: SessionLedgerBucket): void {
    while (bucket.entries.size > this.maxEntriesPerSession) {
      const oldestKey = bucket.entries.keys().next().value;
      if (oldestKey === undefined) return;
      bucket.entries.delete(oldestKey);
      bucket.evictedKeys.add(oldestKey);
    }
  }

  private enforceSessionLimit(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldestSessionId = this.sessions.keys().next().value;
      if (oldestSessionId === undefined) return;
      this.sessions.delete(oldestSessionId);
    }
  }
}

function positiveIntOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export const sessionContentLedger = new SessionContentLedger();
