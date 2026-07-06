export interface WasteLedgerToolSnapshot {
  tool: string;
  deliveredIds: number;
  referencedIds: number;
  deliveredTokens: number;
  signalDensity: number;
}

export interface WasteLedgerSnapshot {
  tools: WasteLedgerToolSnapshot[];
}

export interface WasteLedgerOptions {
  ttlMs?: number;
  maxSessions?: number;
  maxIdsPerSession?: number;
  now?: () => number;
}

interface DeliveredIdEntry {
  tools: Set<string>;
  creditedTools: Set<string>;
}

interface ToolCounters {
  deliveredIds: number;
  referencedIds: number;
  deliveredTokens: number;
}

interface SessionBucket {
  deliveredById: Map<string, DeliveredIdEntry>;
  tools: Map<string, ToolCounters>;
  lastAccessMs: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_MAX_IDS_PER_SESSION = 50_000;

export class WasteLedger {
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly maxIdsPerSession: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionBucket>();

  constructor(options: WasteLedgerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxIdsPerSession = options.maxIdsPerSession ?? DEFAULT_MAX_IDS_PER_SESSION;
    this.now = options.now ?? Date.now;
  }

  recordDelivered(
    sessionId: string,
    tool: string,
    deliveredIds: readonly string[],
    deliveredTokens: number,
  ): void {
    const session = this.getOrCreateSession(sessionId, this.now());
    const toolCounters = getOrCreateToolCounters(session.tools, tool);
    toolCounters.deliveredTokens += deliveredTokens;

    for (const id of new Set(deliveredIds)) {
      let delivered = session.deliveredById.get(id);
      if (!delivered) {
        delivered = { tools: new Set(), creditedTools: new Set() };
        session.deliveredById.set(id, delivered);
      }

      if (!delivered.tools.has(tool)) {
        delivered.tools.add(tool);
        toolCounters.deliveredIds += 1;
      }

      if (session.deliveredById.size > this.maxIdsPerSession) {
        // ponytail: drop the whole session if the ledger exceeds its cap; per-id eviction would corrupt density counts.
        this.sessions.delete(sessionId);
        return;
      }
    }
  }

  recordReferenced(sessionId: string, referencedIds: readonly string[]): void {
    const nowMs = this.now();
    this.pruneExpired(nowMs);

    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastAccessMs = nowMs;

    for (const id of new Set(referencedIds)) {
      const delivered = session.deliveredById.get(id);
      if (!delivered) continue;

      for (const tool of delivered.tools) {
        if (delivered.creditedTools.has(tool)) continue;
        delivered.creditedTools.add(tool);
        getOrCreateToolCounters(session.tools, tool).referencedIds += 1;
      }
    }
  }

  snapshot(): WasteLedgerSnapshot {
    this.pruneExpired(this.now());

    const byTool = new Map<string, ToolCounters>();
    for (const session of this.sessions.values()) {
      for (const [tool, counters] of session.tools) {
        const aggregate = getOrCreateToolCounters(byTool, tool);
        aggregate.deliveredIds += counters.deliveredIds;
        aggregate.referencedIds += counters.referencedIds;
        aggregate.deliveredTokens += counters.deliveredTokens;
      }
    }

    return {
      tools: [...byTool.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([tool, counters]) => ({
          tool,
          deliveredIds: counters.deliveredIds,
          referencedIds: counters.referencedIds,
          deliveredTokens: counters.deliveredTokens,
          signalDensity:
            counters.deliveredIds === 0
              ? 0
              : counters.referencedIds / counters.deliveredIds,
        })),
    };
  }

  clear(): void {
    this.sessions.clear();
  }

  private getOrCreateSession(sessionId: string, nowMs: number): SessionBucket {
    this.pruneExpired(nowMs);

    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastAccessMs = nowMs;
      return existing;
    }

    const session: SessionBucket = {
      deliveredById: new Map(),
      tools: new Map(),
      lastAccessMs: nowMs,
    };
    this.sessions.set(sessionId, session);
    this.enforceSessionLimit();
    return session;
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
      let oldestSessionId: string | undefined;
      let oldestAccessMs = Number.POSITIVE_INFINITY;

      for (const [sessionId, session] of this.sessions) {
        if (session.lastAccessMs < oldestAccessMs) {
          oldestAccessMs = session.lastAccessMs;
          oldestSessionId = sessionId;
        }
      }

      if (!oldestSessionId) return;
      this.sessions.delete(oldestSessionId);
    }
  }
}

function getOrCreateToolCounters(
  tools: Map<string, ToolCounters>,
  tool: string,
): ToolCounters {
  let counters = tools.get(tool);
  if (!counters) {
    counters = { deliveredIds: 0, referencedIds: 0, deliveredTokens: 0 };
    tools.set(tool, counters);
  }
  return counters;
}

export const wasteLedger = new WasteLedger();
