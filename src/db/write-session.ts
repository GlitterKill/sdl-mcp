/**
 * Post-index write sessions.
 *
 * Background — `LadybugDB` allows only one write transaction system-wide.
 * Indexer post-phase work (finalize, derived state, deferred indexes,
 * memory sync, audit flush) used to acquire the writeLimiter per phase.
 * Between phases another writer (audit log, live-index reconcile) could
 * interleave; on conflict LadybugDB returned "Cannot start a new write
 * transaction" and the swallowing-catch hid the problem until the system
 * wedged.
 *
 * `withPostIndexWriteSession` holds the writeLimiter for the entire
 * pipeline. Two cooperating mechanisms expose the session state:
 *
 *   1. `AsyncLocalStorage` — `withWriteConn` can detect that the current
 *      async context is INSIDE a session body and reuse the session conn
 *      directly, avoiding a deadlock that would otherwise occur because
 *      the writeLimiter's single slot is already held by the outer session.
 *
 *   2. Process-global `activeSession` — audit-log buffering and other
 *      cross-context callers can detect "post-index in flight" without
 *      participating in ALS. They use this to queue work instead of
 *      blocking on the limiter for the session's duration.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Connection } from "kuzu";
import { logger } from "../util/logger.js";
import { getObservabilityTap } from "../observability/event-tap.js";

const SESSION_BRAND: unique symbol = Symbol("WriteSession");

export interface WriteSession {
  readonly [SESSION_BRAND]: true;
  readonly conn: Connection;
  readonly id: string;
  readonly startedAt: number;
}

let activeSession: WriteSession | null = null;
const sessionContext = new AsyncLocalStorage<WriteSession>();

/**
 * Read the currently active post-index session, if any. Process-global —
 * visible to ANY async context including parallel tool calls. Use this to
 * decide whether to buffer / defer rather than block on the writeLimiter.
 */
export function getActivePostIndexSession(): WriteSession | null {
  return activeSession;
}

/**
 * Returns true if a post-index session is currently in flight on this process.
 * Cheap predicate suitable for hot paths.
 */
export function isPostIndexSessionActive(): boolean {
  return activeSession !== null;
}

/**
 * Read the session bound to the CURRENT async context. Returns null when
 * called from outside a session body (even if another session is active in
 * a different context). Used by `withWriteConn` to reuse the session conn
 * for in-pipeline writes without re-acquiring the limiter.
 */
export function getCurrentSession(): WriteSession | null {
  return sessionContext.getStore() ?? null;
}

interface WithWriteConnFn {
  <T>(fn: (conn: Connection) => Promise<T>): Promise<T>;
}

let writeConnAcquirer: WithWriteConnFn | null = null;

/**
 * Wire the write-conn acquirer at module init time. Called from ladybug.ts
 * to avoid a circular import (`ladybug.ts` imports this module, this module
 * needs ladybug.ts's `withWriteConn`).
 */
export function configureWriteConnAcquirer(fn: WithWriteConnFn): void {
  writeConnAcquirer = fn;
}

let sessionCounter = 0;

// Hooks invoked just before the session releases the writeLimiter. Used by
// the audit-log buffer to drain queued events on the session conn so they
// land in the same writeLimiter window. Hooks must be quick; failures are
// logged and swallowed so they can't strand the session.
type SessionEndHook = (session: WriteSession) => Promise<void>;
const sessionEndHooks: SessionEndHook[] = [];

/**
 * Register a hook to run inside the writeLimiter slot just before the
 * session releases. Returns an unregister function.
 */
export function registerSessionEndHook(fn: SessionEndHook): () => void {
  sessionEndHooks.push(fn);
  return () => {
    const idx = sessionEndHooks.indexOf(fn);
    if (idx !== -1) sessionEndHooks.splice(idx, 1);
  };
}

// Default upper bound on a post-index session. If a phase hangs (e.g.
// LadybugDB native call wedges), the session timeout fires so callers see
// a clear error rather than waiting for the writeLimiter's per-call queue
// timeouts to surface. Override via env or the options arg.
//
// Sized for fresh-DB initial index of mid-size repos (~8-12k symbols):
// `buildDeferredIndexes` runs `CREATE_VECTOR_INDEX` once per configured
// embedding model on the populated `Symbol.embedding*Vec` columns, and
// each call walks all live vectors with HNSW ef_construction=200 and M=16.
// Empirically a 8500-symbol × 768-dim × 2-model rebuild lands near the old
// 5min default; allowing 15min keeps a safety margin while still
// surfacing a real wedge before the writeLimiter's per-call queue
// timeouts pile on. Incremental refreshes finish in seconds and don't
// approach this budget. Override via SDL_POST_INDEX_SESSION_TIMEOUT_MS
// when running on slower disks or larger repos.
const DEFAULT_SESSION_TIMEOUT_MS = 15 * 60 * 1000;

function resolveSessionTimeoutMs(override?: number): number {
  if (override !== undefined && override > 0) return override;
  const raw = process.env.SDL_POST_INDEX_SESSION_TIMEOUT_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_SESSION_TIMEOUT_MS;
}

/**
 * Acquire the writeLimiter for the duration of `body`. The session is
 * marked active so other code paths can detect it. Nesting is forbidden —
 * calling this while another session is active throws, intentional: post-
 * index runs are not re-entrant.
 */
export interface WithPostIndexWriteSessionOptions {
  /** Hard timeout in ms; throws if the session body hasn't settled. */
  timeoutMs?: number;
}

export function withPostIndexWriteSession<T>(
  body: (session: WriteSession) => Promise<T>,
  options: WithPostIndexWriteSessionOptions = {},
): Promise<T> {
  if (activeSession) {
    throw new Error(
      `withPostIndexWriteSession called while another session (${activeSession.id}) is still active`,
    );
  }
  if (!writeConnAcquirer) {
    throw new Error(
      "withPostIndexWriteSession invoked before configureWriteConnAcquirer; ensure ladybug.ts has loaded",
    );
  }
  const acquire = writeConnAcquirer;
  return acquire(async (conn) => {
    const session: WriteSession = {
      [SESSION_BRAND]: true,
      conn,
      id: `pi-${Date.now().toString(36)}-${(sessionCounter++).toString(36)}`,
      startedAt: Date.now(),
    };
    activeSession = session;
    const timeoutMs = resolveSessionTimeoutMs(options.timeoutMs);
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        logger.error(
          `[write-session] post-index session ${session.id} exceeded ${timeoutMs}ms; aborting body. The writeLimiter slot will release once the underlying task settles.`,
        );
        reject(
          new Error(
            `post-index session ${session.id} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      timeoutHandle.unref();
    });
    try {
      return (await Promise.race([
        sessionContext.run(session, () => body(session)),
        timeoutPromise,
      ])) as T;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Clear the active-session marker BEFORE running hooks. Audit calls
      // that fire during hook execution then route to writeLimiter (queued
      // behind the session) instead of into the in-memory buffer. This
      // closes a race where a recordAuditEvent enqueued AFTER the drain's
      // splice but BEFORE the marker clear could be stranded in the buffer
      // until the next session or shutdown.
      activeSession = null;
      // Skip end-hooks on timeout. The body's last LadybugDB call is still
      // running on session.conn (the limiter slot only releases when it
      // settles), and per-conn serialization is enforced by getConnMutex
      // — so any drain attempt would queue behind the hung call, hit
      // queueTimeoutMs, and drop the buffered events entirely. Leave them
      // for the next session's drain or the on-shutdown flush.
      if (timedOut) {
        if (sessionEndHooks.length > 0) {
          logger.error(
            `[write-session] Session ${session.id} timed out; skipping ${sessionEndHooks.length} end-hook(s). Buffered work will drain on next session or shutdown.`,
          );
        }
      } else {
        // Run end-hooks (e.g. audit-buffer drain) inside the limiter slot
        // so their writes land before the next writer can interleave.
        for (const hook of sessionEndHooks) {
          try {
            await hook(session);
          } catch (hookErr) {
            logger.warn(
              `[write-session] session end hook failed: ${
                hookErr instanceof Error ? hookErr.message : String(hookErr)
              }`,
            );
          }
        }
      }
      const durationMs = Date.now() - session.startedAt;
      const summary =
        `[write-session] post-index session ${session.id} ended ` +
        `(durationMs=${durationMs}, timedOut=${timedOut})`;
      if (timedOut || durationMs > timeoutMs * 0.5) {
        logger.warn(summary);
      } else {
        logger.debug(summary);
      }
      try {
        getObservabilityTap()?.postIndexSession({
          sessionId: session.id,
          durationMs,
          timedOut,
        });
      } catch {
        // tap forwarding must never affect session result
      }
      // activeSession was already cleared at the top of the finally so audit
      // calls that ran during hook execution didn't buffer; nothing to do.
    }
  });
}
