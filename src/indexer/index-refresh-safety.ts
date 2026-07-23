import { withWriteConn } from "../db/ladybug.js";
import {
  drainAuditBuffer,
  getBufferedAuditCount,
  withExplicitAuditBufferingScope,
} from "../mcp/audit-buffer.js";

import { withGraphIntegrityVerifierQuiesced } from "./provider-first/background-graph-integrity-verifier.js";

/**
 * Own the process-wide boundaries required by a destructive, isolated full
 * index: no verifier may read during reset, and telemetry writes are buffered
 * until the index releases LadybugDB's single writer.
 */
export function withFullIndexSafetyBoundaries<T>(
  repoId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withExplicitAuditBufferingScope(
    () => withGraphIntegrityVerifierQuiesced(repoId, operation),
    async () => {
      if (getBufferedAuditCount() === 0) return;
      await withWriteConn((conn) => drainAuditBuffer(conn));
    },
  );
}
