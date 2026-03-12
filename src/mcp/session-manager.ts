import { logger } from "../util/logger.js";
import { ValidationError } from "../domain/errors.js";

/**
 * Metadata tracked per active MCP session.
 */
export interface SessionInfo {
  sessionId: string;
  transportType: "sse" | "streamable-http";
  connectedAt: string;
  requestsInFlight: number;
  totalRequests: number;
  lastActivityAt: string;
}

/**
 * Tracks active MCP sessions across all transport types (SSE + Streamable HTTP).
 * Enforces session limits and provides monitoring stats.
 */
export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private maxSessions: number;
  private pendingReservations = 0;
  private idleReaperHandle: ReturnType<typeof setInterval> | undefined;

  constructor(maxSessions = 8) {
    if (maxSessions < 1 || maxSessions > 16) {
      throw new ValidationError(
        `maxSessions must be between 1 and 16, got ${maxSessions}`,
      );
    }
    this.maxSessions = maxSessions;
  }

  /**
   * Check if a new session can be accepted.
   */
  canAcceptSession(): boolean {
    return this.sessions.size + this.pendingReservations < this.maxSessions;
  }

  /**
   * Reserve a session slot before transport allocation.
   */
  reserveSession(): boolean {
    if (this.canAcceptSession()) {
      this.pendingReservations++;
      return true;
    }
    return false;
  }

  /**
   * Release a previously reserved slot.
   */
  releaseReservation(): void {
    this.pendingReservations = Math.max(0, this.pendingReservations - 1);
  }

  /**
   * Register a new session.
   */
  registerSession(
    sessionId: string,
    transportType: "sse" | "streamable-http",
  ): void {
    if (this.sessions.has(sessionId)) {
      logger.warn("Session already registered", { sessionId });
      this.releaseReservation();
      return;
    }

    if (!this.canAcceptSession() && this.pendingReservations === 0) {
      throw new ValidationError(
        `Maximum session limit (${this.maxSessions}) reached. Cannot accept new session.`,
      );
    }

    const now = new Date().toISOString();
    this.sessions.set(sessionId, {
      sessionId,
      transportType,
      connectedAt: now,
      requestsInFlight: 0,
      totalRequests: 0,
      lastActivityAt: now,
    });

    // Transition one slot from reserved -> registered.
    this.releaseReservation();

    logger.info("Session registered", {
      sessionId,
      transportType,
      activeSessions: this.sessions.size,
      pendingReservations: this.pendingReservations,
    });
  }

  /**
   * Unregister a session (on disconnect/cleanup).
   */
  unregisterSession(sessionId: string): void {
    const existed = this.sessions.delete(sessionId);
    if (existed) {
      logger.info("Session unregistered", {
        sessionId,
        activeSessions: this.sessions.size,
        pendingReservations: this.pendingReservations,
      });
    }
  }

  /**
   * Start periodic cleanup of idle sessions.
   */
  startIdleReaper(
    opts: { idleTimeoutMs?: number; intervalMs?: number },
    onExpired: (sessionId: string) => void,
  ): void {
    const idleTimeoutMs = opts.idleTimeoutMs ?? 300_000;
    const intervalMs = opts.intervalMs ?? 60_000;

    this.stopIdleReaper();

    const handle = setInterval(() => {
      const now = Date.now();
      const expiredSessionIds: string[] = [];

      for (const [sessionId, session] of this.sessions) {
        // Skip sessions with requests still in flight — they are actively
        // processing work even if lastActivityAt looks stale (H4).
        if (session.requestsInFlight > 0) continue;

        const lastActivityAt = new Date(session.lastActivityAt).getTime();
        if (now - lastActivityAt > idleTimeoutMs) {
          expiredSessionIds.push(sessionId);
        }
      }

      for (const sessionId of expiredSessionIds) {
        try {
          onExpired(sessionId);
        } catch (error) {
          logger.error("Idle reaper callback failed", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        this.unregisterSession(sessionId);
      }
    }, intervalMs);
    // Don't let the reaper interval prevent clean process exit (M7)
    if (typeof handle.unref === "function") {
      handle.unref();
    }
    this.idleReaperHandle = handle;

    logger.info("Session idle reaper started", {
      idleTimeoutMs,
      intervalMs,
    });
  }

  /**
   * Stop periodic cleanup of idle sessions.
   */
  stopIdleReaper(): void {
    if (!this.idleReaperHandle) {
      return;
    }

    clearInterval(this.idleReaperHandle);
    this.idleReaperHandle = undefined;

    logger.info("Session idle reaper stopped");
  }

  /**
   * Track a request starting for a session.
   * Returns a function to call when the request completes.
   */
  trackRequest(sessionId: string): () => void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return () => {};
    }

    session.requestsInFlight++;
    session.totalRequests++;
    session.lastActivityAt = new Date().toISOString();

    return () => {
      const current = this.sessions.get(sessionId);
      if (current) {
        current.requestsInFlight = Math.max(0, current.requestsInFlight - 1);
        // Update lastActivityAt on completion so the idle reaper measures
        // from request end, not start (H4).
        current.lastActivityAt = new Date().toISOString();
      }
    };
  }

  /**
   * Get session info for a specific session.
   */
  getSession(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : undefined;
  }

  /**
   * Get stats for all active sessions.
   */
  getStats(): {
    activeSessions: number;
    maxSessions: number;
    sessions: SessionInfo[];
  } {
    return {
      activeSessions: this.sessions.size,
      maxSessions: this.maxSessions,
      sessions: Array.from(this.sessions.values()).map((s) => ({ ...s })),
    };
  }

  /**
   * Get the maximum sessions limit.
   */
  getMaxSessions(): number {
    return this.maxSessions;
  }
}
