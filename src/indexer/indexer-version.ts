import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";

export async function createVersionAndSnapshot(params: {
  repoId: string;
  versionId: string;
  reason: string;
}): Promise<void> {
  const { repoId, versionId, reason } = params;
  const readConn = await getLadybugConn();
  const symbols = await ladybugDb.getSymbolsByRepoForSnapshot(readConn, repoId);
  await withWriteConn(async (wConn) => {
    await ladybugDb.createVersion(wConn, {
      versionId,
      repoId,
      createdAt: new Date().toISOString(),
      reason,
      prevVersionHash: null,
      versionHash: null,
    });
    for (const symbol of symbols) {
      await ladybugDb.snapshotSymbolVersion(wConn, {
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
}
