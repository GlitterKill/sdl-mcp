export interface ShortIdRegistryOptions {
  ttlMs?: number;
  maxSessions?: number;
  maxEntriesPerSession?: number;
}

interface ShortIdSession {
  byId: Map<string, string>;
  byAlias: Map<string, string>;
  counter: number;
  disabled: boolean;
  lastAccessMs: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_MAX_ENTRIES_PER_SESSION = 50_000;
const MAX_ALIAS_COUNTER = 999_999;
const ALIAS_PATTERN = /^s[1-9][0-9]{0,5}$/;

export class ShortIdRegistry {
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly maxEntriesPerSession: number;
  private readonly sessions = new Map<string, ShortIdSession>();

  constructor(options: ShortIdRegistryOptions = {}) {
    this.ttlMs = positiveIntOrDefault(options.ttlMs, DEFAULT_TTL_MS);
    this.maxSessions = positiveIntOrDefault(
      options.maxSessions,
      DEFAULT_MAX_SESSIONS,
    );
    this.maxEntriesPerSession = Math.min(
      positiveIntOrDefault(
        options.maxEntriesPerSession,
        DEFAULT_MAX_ENTRIES_PER_SESSION,
      ),
      MAX_ALIAS_COUNTER,
    );
  }

  aliasWithStatus(
    sessionId: string,
    fullId: string,
  ): { alias: string; introduced: boolean } {
    const session = this.sessions.get(sessionId);
    const known = session?.byId.has(fullId) === true;
    const alias = this.alias(sessionId, fullId);
    return { alias, introduced: alias !== fullId && !known };
  }

  alias(sessionId: string, fullId: string): string {
    const nowMs = Date.now();
    this.pruneExpired(nowMs);

    const session = this.getOrCreateSession(sessionId, nowMs);
    this.markSessionAccessed(sessionId, session, nowMs);
    if (session.disabled) return fullId;

    const existing = session.byId.get(fullId);
    if (existing) return existing;

    if (session.byId.size >= this.maxEntriesPerSession) {
      this.disableSession(session);
      return fullId;
    }

    session.counter += 1;
    const alias = `s${session.counter}`;
    session.byId.set(fullId, alias);
    session.byAlias.set(alias, fullId);
    this.enforceSessionLimit();
    return alias;
  }

  resolve(sessionId: string, idOrAlias: string): string | undefined {
    if (!ShortIdRegistry.looksLikeAlias(idOrAlias)) return idOrAlias;

    const nowMs = Date.now();
    this.pruneExpired(nowMs);

    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    this.markSessionAccessed(sessionId, session, nowMs);
    if (session.disabled) return undefined;
    return session.byAlias.get(idOrAlias);
  }

  static looksLikeAlias(value: string): boolean {
    return ALIAS_PATTERN.test(value);
  }

  private getOrCreateSession(
    sessionId: string,
    nowMs: number,
  ): ShortIdSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const session: ShortIdSession = {
      byId: new Map(),
      byAlias: new Map(),
      counter: 0,
      disabled: false,
      lastAccessMs: nowMs,
    };
    this.sessions.set(sessionId, session);
    this.enforceSessionLimit();
    return session;
  }

  private markSessionAccessed(
    sessionId: string,
    session: ShortIdSession,
    nowMs: number,
  ): void {
    session.lastAccessMs = nowMs;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
  }

  private disableSession(session: ShortIdSession): void {
    // ponytail: keep an empty tombstone so a capped session cannot reuse s1 for a different full id.
    session.byId.clear();
    session.byAlias.clear();
    session.disabled = true;
  }

  private pruneExpired(nowMs: number): void {
    const cutoffMs = nowMs - this.ttlMs;
    for (const [sessionId, session] of this.sessions) {
      if (session.lastAccessMs < cutoffMs) {
        this.sessions.delete(sessionId);
      }
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

export const shortIdRegistry = new ShortIdRegistry();
