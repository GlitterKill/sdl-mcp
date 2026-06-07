import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";

type RecordTiming = (phaseName: string, durationMs: number) => void;

async function measureVersionPhase<T>(
  recordTiming: RecordTiming | undefined,
  phaseName: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    recordTiming?.(phaseName, Date.now() - startedAt);
  }
}

async function snapshotSymbolsForVersion(params: {
  repoId: string;
  versionId: string;
  freshVersion?: boolean;
  recordTiming?: RecordTiming;
}): Promise<number> {
  const { repoId, versionId, freshVersion = false, recordTiming } = params;
  const readConn = await getLadybugConn();
  let afterSymbolId: string | undefined;
  let symbolCount = 0;

  await measureVersionPhase(
    recordTiming,
    "versionSnapshot.snapshot",
    async () => {
      if (freshVersion) {
        const writer = await ladybugDb.createFreshSymbolVersionCopyWriter();
        try {
          while (true) {
            const symbols = await measureVersionPhase(
              recordTiming,
              "versionSnapshot.snapshot.readPages",
              () =>
                ladybugDb.getSymbolsByRepoForSnapshotPage(readConn, repoId, {
                  afterSymbolId,
                }),
            );
            if (symbols.length === 0) break;

            const rows = symbols.map((symbol) => ({
              versionId,
              symbolId: symbol.symbolId,
              astFingerprint: symbol.astFingerprint,
              signatureJson: symbol.signatureJson,
              summary: symbol.summary,
              invariantsJson: symbol.invariantsJson,
              sideEffectsJson: symbol.sideEffectsJson,
            }));
            await measureVersionPhase(
              recordTiming,
              "versionSnapshot.snapshot.writePages",
              () => writer.writePage(rows),
            );
            symbolCount += symbols.length;
            afterSymbolId = symbols[symbols.length - 1]?.symbolId;
          }
          await measureVersionPhase(
            recordTiming,
            "versionSnapshot.snapshot.writePages",
            () => withWriteConn((wConn) => writer.finish(wConn)),
          );
        } finally {
          await writer.dispose();
        }
        return;
      }

      while (true) {
        const symbols = await measureVersionPhase(
          recordTiming,
          "versionSnapshot.snapshot.readPages",
          () =>
            ladybugDb.getSymbolsByRepoForSnapshotPage(readConn, repoId, {
              afterSymbolId,
            }),
        );
        if (symbols.length === 0) break;

        const rows = symbols.map((symbol) => ({
          versionId,
          symbolId: symbol.symbolId,
          astFingerprint: symbol.astFingerprint,
          signatureJson: symbol.signatureJson,
          summary: symbol.summary,
          invariantsJson: symbol.invariantsJson,
          sideEffectsJson: symbol.sideEffectsJson,
        }));
        await measureVersionPhase(
          recordTiming,
          "versionSnapshot.snapshot.writePages",
          () =>
            withWriteConn(async (wConn) => {
              if (freshVersion) {
                await ladybugDb.snapshotFreshSymbolVersionsCopy(wConn, rows);
              } else {
                await ladybugDb.snapshotSymbolVersionsBatch(wConn, rows);
              }
            }),
        );
        symbolCount += symbols.length;
        afterSymbolId = symbols[symbols.length - 1]?.symbolId;
      }
    },
  );

  logger.debug("Version snapshot complete", {
    repoId,
    versionId,
    symbolCount,
  });
  return symbolCount;
}

export async function snapshotCurrentSymbolsForVersion(params: {
  repoId: string;
  versionId: string;
  recordTiming?: RecordTiming;
}): Promise<number> {
  return snapshotSymbolsForVersion(params);
}

export async function createVersionAndSnapshot(params: {
  repoId: string;
  versionId: string;
  reason: string;
  recordTiming?: RecordTiming;
}): Promise<void> {
  const { repoId, versionId, reason, recordTiming } = params;
  await measureVersionPhase(
    recordTiming,
    "versionSnapshot.createVersion",
    () =>
      withWriteConn(async (wConn) => {
        await ladybugDb.createVersion(wConn, {
          versionId,
          repoId,
          createdAt: new Date().toISOString(),
          reason,
          prevVersionHash: null,
          versionHash: null,
        });
      }),
  );
  await snapshotSymbolsForVersion({
    repoId,
    versionId,
    freshVersion: true,
    recordTiming,
  });
}
