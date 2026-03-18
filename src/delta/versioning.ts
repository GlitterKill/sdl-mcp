import type { SymbolId, VersionId } from "../db/schema.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { getLadybugConn } from "../db/ladybug.js";
import { hashContent } from "../util/hashing.js";
import { getCurrentTimestamp } from "../util/time.js";
import { logger } from "../util/logger.js";
import { IndexError } from "../domain/errors.js";

export async function createVersion(
  repoId: string,
  reason?: string,
): Promise<VersionId> {
  const timestamp = Date.now();
  const suffix = Math.random().toString(36).slice(2, 6);
  const versionId: VersionId = `${repoId}-v${timestamp}-${suffix}`;

  const conn = await getLadybugConn();
  const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
  const prevVersionHash = latestVersion?.versionHash ?? null;

  const version: ladybugDb.VersionRow = {
    versionId,
    repoId,
    createdAt: getCurrentTimestamp(),
    reason: reason ?? null,
    prevVersionHash,
    versionHash: null,
  };

  await ladybugDb.createVersion(conn, version);
  return versionId;
}

export function computeVersionHash(
  prevVersionHash: string | null,
  symbolVersions: Array<Pick<ladybugDb.SymbolVersionRow, "symbolId" | "astFingerprint">>,
): string {
  const sortedVersions = [...symbolVersions].sort((a, b) =>
    a.symbolId.localeCompare(b.symbolId),
  );

  const fingerprints = sortedVersions.map((sv) => sv.astFingerprint).join("|");
  const combined = `${prevVersionHash || "none"}:${fingerprints}`;
  return hashContent(combined);
}

export async function finalizeVersionHash(
  versionId: VersionId,
  symbolVersions: Array<Pick<ladybugDb.SymbolVersionRow, "symbolId" | "astFingerprint">>,
): Promise<void> {
  const conn = await getLadybugConn();
  const version = await ladybugDb.getVersion(conn, versionId);
  if (!version) {
    throw new IndexError(`Version ${versionId} not found`);
  }

  const versionHash = computeVersionHash(version.prevVersionHash, symbolVersions);
  await ladybugDb.updateVersionHashes(
    conn,
    versionId,
    version.prevVersionHash,
    versionHash,
  );
}

export async function getVersion(
  versionId: VersionId,
): Promise<ladybugDb.VersionRow | null> {
  const conn = await getLadybugConn();
  return ladybugDb.getVersion(conn, versionId);
}

export async function getLatestVersion(
  repoId: string,
): Promise<ladybugDb.VersionRow | null> {
  const conn = await getLadybugConn();
  return ladybugDb.getLatestVersion(conn, repoId);
}

export async function listVersions(
  repoId: string,
  limit?: number,
): Promise<ladybugDb.VersionRow[]> {
  const conn = await getLadybugConn();
  return ladybugDb.getVersionsByRepo(conn, repoId, limit ?? 50);
}

export async function snapshotSymbols(
  versionId: VersionId,
  symbolIds: SymbolId[],
): Promise<void> {
  const conn = await getLadybugConn();

  try {
    const symbolMap = await ladybugDb.getSymbolsByIds(conn, symbolIds);
    const snapshots: Array<
      Pick<ladybugDb.SymbolVersionRow, "symbolId" | "astFingerprint">
    > = [];

    for (const symbolId of symbolIds) {
      const symbol = symbolMap.get(symbolId);
      if (!symbol) {
        logger.warn("Symbol not found during version snapshot, skipping", {
          versionId,
          symbolId,
        });
        continue;
      }

      await ladybugDb.snapshotSymbolVersion(conn, {
        versionId,
        symbolId,
        astFingerprint: symbol.astFingerprint,
        signatureJson: symbol.signatureJson,
        summary: symbol.summary,
        invariantsJson: symbol.invariantsJson,
        sideEffectsJson: symbol.sideEffectsJson,
      });

      snapshots.push({
        symbolId,
        astFingerprint: symbol.astFingerprint,
      });
    }

    await finalizeVersionHash(versionId, snapshots);
  } catch (error) {
    logger.error("Snapshot transaction failed; version may be inconsistent", {
      versionId,
      symbolCount: symbolIds.length,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

