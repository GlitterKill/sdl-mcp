import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import { withTransaction } from "../db/ladybug-core.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";

const SNAPSHOT_BATCH_SIZE = 200;

export async function createVersionAndSnapshot(params: {
  repoId: string;
  versionId: string;
  reason: string;
}): Promise<void> {
  const { repoId, versionId, reason } = params;
  const readConn = await getLadybugConn();
  const symbols = await ladybugDb.getSymbolsByRepoForSnapshot(readConn, repoId);
  await withWriteConn(async (wConn) => {
    let chunksCommitted = 0;
    await ladybugDb.createVersion(wConn, {
      versionId,
      repoId,
      createdAt: new Date().toISOString(),
      reason,
      prevVersionHash: null,
      versionHash: null,
    });
    // Batch snapshots inside transactions to avoid thousands of individual
    // auto-commits which cause WAL pressure and can crash Kuzu on large repos.
    for (let i = 0; i < symbols.length; i += SNAPSHOT_BATCH_SIZE) {
      const chunk = symbols.slice(i, i + SNAPSHOT_BATCH_SIZE);
      await withTransaction(wConn, async (txConn) => {
        for (const symbol of chunk) {
          await ladybugDb.snapshotSymbolVersion(txConn, {
            versionId,
            symbolId: symbol.symbolId,
            astFingerprint: symbol.astFingerprint,
            signatureJson: symbol.signatureJson,
            summary: symbol.summary,
            invariantsJson: symbol.invariantsJson,
            sideEffectsJson: symbol.sideEffectsJson,
          });
        }
      });
      chunksCommitted++;
    }
    logger.debug("Version snapshot complete", {
      repoId,
      versionId,
      symbolCount: symbols.length,
      chunksCommitted,
    });
  });
}
