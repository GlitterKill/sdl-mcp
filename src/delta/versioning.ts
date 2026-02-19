import type { VersionId, SymbolId } from "../db/schema.js";
import * as db from "../db/queries.js";
import { getCurrentTimestamp } from "../util/time.js";
import type { VersionRow } from "../db/schema.js";
import type { SymbolVersionRow } from "../db/schema.js";
import { getDb } from "../db/db.js";
import { hashContent } from "../util/hashing.js";
import { logger } from "../util/logger.js";

export function createVersion(repoId: string, reason?: string): VersionId {
  const timestamp = Date.now();
  const versionId: VersionId = `${repoId}-v${timestamp}`;

  const latestVersion = db.getLatestVersion(repoId);
  const prevVersionHash = latestVersion?.version_hash ?? null;

  const version: VersionRow = {
    version_id: versionId,
    repo_id: repoId,
    created_at: getCurrentTimestamp(),
    reason: reason ?? null,
    prev_version_hash: prevVersionHash,
    version_hash: null,
  };

  db.createVersion(version);
  return versionId;
}

export function computeVersionHash(
  prevVersionHash: string | null,
  symbolVersions: SymbolVersionRow[],
): string {
  const sortedVersions = [...symbolVersions].sort((a, b) =>
    a.symbol_id.localeCompare(b.symbol_id),
  );

  const fingerprints = sortedVersions.map((sv) => sv.ast_fingerprint).join("|");
  const combined = `${prevVersionHash || "none"}:${fingerprints}`;
  return hashContent(combined);
}

export function finalizeVersionHash(
  versionId: VersionId,
  symbolVersions: SymbolVersionRow[],
): void {
  const version = db.getVersion(versionId);
  if (!version) {
    throw new Error(`Version ${versionId} not found`);
  }

  const versionHash = computeVersionHash(
    version.prev_version_hash,
    symbolVersions,
  );

  db.updateVersionHashes(versionId, version.prev_version_hash, versionHash);
}

export function getVersion(versionId: VersionId): VersionRow | null {
  return db.getVersion(versionId);
}

export function getLatestVersion(repoId: string): VersionRow | null {
  return db.getLatestVersion(repoId);
}

export function listVersions(repoId: string, limit?: number): VersionRow[] {
  return db.listVersions(repoId, limit ?? 50);
}

export function snapshotSymbols(
  versionId: VersionId,
  symbolIds: SymbolId[],
): void {
  const dbInstance = getDb();
  const snapshotTx = dbInstance.transaction(() => {
    const snapshots: SymbolVersionRow[] = [];

    for (const symbolId of symbolIds) {
      const symbol = db.getSymbol(symbolId);
      if (!symbol) {
        logger.warn("Symbol not found during version snapshot, skipping", {
          versionId,
          symbolId,
        });
        continue;
      }

      const snapshot: SymbolVersionRow = {
        version_id: versionId,
        symbol_id: symbolId,
        ast_fingerprint: symbol.ast_fingerprint,
        signature_json: symbol.signature_json,
        summary: symbol.summary,
        invariants_json: symbol.invariants_json,
        side_effects_json: symbol.side_effects_json,
      };

      db.snapshotSymbolVersion(versionId, symbolId, snapshot);
      snapshots.push(snapshot);
    }

    finalizeVersionHash(versionId, snapshots);
  });

  try {
    snapshotTx();
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
