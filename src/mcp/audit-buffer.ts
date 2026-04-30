/**
 * Audit-log in-memory buffer for use during post-index write sessions.
 *
 * Background — telemetry.recordAuditEvent normally goes straight to
 * withWriteConn → ladybugDb.insertAuditEvent. While a post-index session
 * is in flight, however, the writeLimiter slot is held by the indexer
 * pipeline. Audit calls that hit the limiter would queue for the entire
 * session duration, possibly tens of seconds, and the queue's own
 * timeout (30s default) would fire and drop the audit with an error log.
 *
 * Buffering the audit row in memory and draining at session end keeps the
 * audit guarantee while letting interactive tool calls return promptly.
 *
 * Bounded size (MAX_BUFFER): if the buffer fills, oldest entries are
 * dropped with a warn log. This protects the process from OOM when an
 * unusually long session combines with high tool-call volume.
 *
 * On shutdown the buffer is best-effort flushed via flushAuditBufferOnShutdown.
 */
import type { Connection } from "kuzu";
import * as ladybugDb from "../db/ladybug-queries.js";
import type { AuditRow } from "../db/ladybug-feedback.js";
import { registerSessionEndHook } from "../db/write-session.js";
import { logger } from "../util/logger.js";

const MAX_BUFFER = 5000;

const buffer: AuditRow[] = [];
let droppedDueToBackpressure = 0;

/**
 * Push an audit row into the buffer. Returns true if accepted, false if
 * dropped because the buffer is full.
 */
export function bufferAuditEvent(row: AuditRow): boolean {
  if (buffer.length >= MAX_BUFFER) {
    droppedDueToBackpressure += 1;
    if (droppedDueToBackpressure === 1 || droppedDueToBackpressure % 100 === 0) {
      logger.warn(
        `[audit-buffer] Buffer full at ${MAX_BUFFER}; dropped ${droppedDueToBackpressure} event(s) since last warn`,
      );
    }
    return false;
  }
  buffer.push(row);
  return true;
}

/**
 * Inspect current buffer depth (for observability surfaces).
 */
export function getBufferedAuditCount(): number {
  return buffer.length;
}

/**
 * Cumulative drop count across this process lifetime. Reset only by restart.
 */
export function getDroppedAuditCount(): number {
  return droppedDueToBackpressure;
}

/**
 * Drain all buffered events into the DB on the supplied connection. Returns
 * the count drained. Failures on individual rows are logged and skipped so
 * one bad row can't strand the whole queue.
 */
export async function drainAuditBuffer(conn: Connection): Promise<number> {
  if (buffer.length === 0) return 0;
  // Take a snapshot — new events arriving during the drain stay in the
  // buffer for the next drain (or the on-shutdown flush).
  const drained = buffer.splice(0, buffer.length);
  let okCount = 0;
  for (const row of drained) {
    try {
      await ladybugDb.insertAuditEvent(conn, row);
      okCount += 1;
    } catch (err) {
      logger.warn(
        `[audit-buffer] Failed to insert buffered audit event ${row.eventId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (okCount > 0) {
    logger.debug(`[audit-buffer] Drained ${okCount}/${drained.length} buffered audit events`);
  }
  return okCount;
}

/**
 * On-shutdown flush. Best-effort: takes a write conn from the supplied
 * acquirer (avoids importing ladybug.ts here to keep this module side-effect
 * free at module init). Caller wires this up at the close-hook level.
 */
export async function flushAuditBufferOnShutdown(
  acquireWrite: (
    body: (conn: Connection) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  if (buffer.length === 0) return;
  try {
    await acquireWrite(async (conn) => {
      await drainAuditBuffer(conn);
    });
  } catch (err) {
    logger.warn(
      `[audit-buffer] Shutdown flush failed (${buffer.length} event(s) lost): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// Register the drain hook at module init so any consumer importing this
// module gets buffered audit events flushed at session end.
registerSessionEndHook(async (session) => {
  await drainAuditBuffer(session.conn);
});
