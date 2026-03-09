import type { Connection } from "kuzu";
import { IndexError } from "../mcp/errors.js";

import type { VersionId } from "../db/schema.js";
import type {
  DeltaPack,
  DeltaSymbolChange,
  DeltaSymbolChangeWithTiers,
  StalenessTiers,
} from "../mcp/types.js";
import { logger } from "../util/logger.js";
import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";
import {
  STABILITY_SCORE_INTERFACE,
  STABILITY_SCORE_BEHAVIOR,
  STABILITY_SCORE_SIDE_EFFECTS,
} from "../config/constants.js";

async function getSymbolVersions(
  conn: Connection,
  versionId: string,
): Promise<kuzuDb.SymbolVersionRow[]> {
  return kuzuDb.getSymbolVersionsAtVersion(conn, versionId);
}

export async function computeDelta(
  repoId: string,
  fromVersion: VersionId,
  toVersion: VersionId,
): Promise<DeltaPack> {
  const conn = await getKuzuConn();
  const fromVersions = await getSymbolVersions(conn, fromVersion);
  const toVersions = await getSymbolVersions(conn, toVersion);

  if (fromVersions.length === 0) {
    throw new IndexError(
      `No symbol snapshots found for fromVersion ${fromVersion}. Run indexing to create snapshots.`,
    );
  }

  if (toVersions.length === 0) {
    throw new IndexError(
      `No symbol snapshots found for toVersion ${toVersion}. Run indexing to create snapshots.`,
    );
  }

  const fromMap = new Map<string, kuzuDb.SymbolVersionRow>(
    fromVersions.map((v) => [v.symbolId, v]),
  );
  const toMap = new Map<string, kuzuDb.SymbolVersionRow>(
    toVersions.map((v) => [v.symbolId, v]),
  );

  const changedSymbols: DeltaSymbolChange[] = [];

  for (const [symbolId, toRow] of toMap) {
    const fromRow = fromMap.get(symbolId);

    if (!fromRow) {
      changedSymbols.push({
        symbolId,
        changeType: "added",
      });
      continue;
    }

    const signatureDiff = diffSignature(
      fromRow.signatureJson,
      toRow.signatureJson,
    );
    const invariantDiff = diffArray(
      fromRow.invariantsJson,
      toRow.invariantsJson,
    );
    const sideEffectDiff = diffArray(
      fromRow.sideEffectsJson,
      toRow.sideEffectsJson,
    );

    const isModified =
      fromRow.astFingerprint !== toRow.astFingerprint ||
      fromRow.summary !== toRow.summary ||
      signatureDiff !== undefined ||
      invariantDiff !== undefined ||
      sideEffectDiff !== undefined;

    if (isModified) {
      changedSymbols.push({
        symbolId,
        changeType: "modified",
        signatureDiff,
        invariantDiff,
        sideEffectDiff,
      });
    }
  }

  for (const [symbolId] of fromMap) {
    if (!toMap.has(symbolId)) {
      changedSymbols.push({
        symbolId,
        changeType: "removed",
      });
    }
  }

  return {
    repoId,
    fromVersion,
    toVersion,
    changedSymbols,
    blastRadius: [],
  };
}

export function diffSignature(
  before: string | null,
  after: string | null,
): { before?: string; after?: string } | undefined {
  if (before === after) {
    return undefined;
  }

  let beforeObj = null;
  if (before !== null) {
    try {
      beforeObj = JSON.parse(before);
    } catch (e) {
      logger.warn(
        `Failed to parse JSON in diffSignature (before): ${(e as Error).message}`,
      );
    }
  }

  let afterObj = null;
  if (after !== null) {
    try {
      afterObj = JSON.parse(after);
    } catch (e) {
      logger.warn(
        `Failed to parse JSON in diffSignature (after): ${(e as Error).message}`,
      );
    }
  }

  const beforeStr = JSON.stringify(beforeObj);
  const afterStr = JSON.stringify(afterObj);

  if (beforeStr === afterStr) {
    return undefined;
  }

  return {
    before: before ?? undefined,
    after: after ?? undefined,
  };
}

export function diffArray(
  before: string | null,
  after: string | null,
): { added: string[]; removed: string[] } | undefined {
  if (before === after) {
    return undefined;
  }

  let beforeArr: string[] = [];
  if (before !== null) {
    try {
      beforeArr = JSON.parse(before) as string[];
    } catch (e) {
      logger.warn(
        `Failed to parse JSON in diffArray (before): ${(e as Error).message}`,
      );
      beforeArr = [];
    }
  }

  let afterArr: string[] = [];
  if (after !== null) {
    try {
      afterArr = JSON.parse(after) as string[];
    } catch (e) {
      logger.warn(
        `Failed to parse JSON in diffArray (after): ${(e as Error).message}`,
      );
      afterArr = [];
    }
  }

  const beforeSet = new Set(beforeArr);
  const afterSet = new Set(afterArr);

  const added: string[] = [];
  const removed: string[] = [];

  for (const item of afterSet) {
    if (!beforeSet.has(item)) {
      added.push(item);
    }
  }

  for (const item of beforeSet) {
    if (!afterSet.has(item)) {
      removed.push(item);
    }
  }

  if (added.length === 0 && removed.length === 0) {
    return undefined;
  }

  return { added, removed };
}

export function computeStalenessTiers(
  change: DeltaSymbolChange,
  fromRow: kuzuDb.SymbolVersionRow | null,
  toRow: kuzuDb.SymbolVersionRow | null,
): StalenessTiers {
  // `signatureDiff` and `sideEffectDiff` only exist on the "modified" variant of
  // the DeltaSymbolChange discriminated union. For "added"/"removed" changes the
  // interface/side-effects are inherently unstable (one side is missing entirely).
  const interfaceStable = change.changeType === "modified" ? change.signatureDiff === undefined : false;
  const sideEffectsStable = change.changeType === "modified" ? change.sideEffectDiff === undefined : false;

  let behaviorStable = false;

  if (fromRow && toRow) {
    const astFingerprintUnchanged =
      fromRow.astFingerprint === toRow.astFingerprint;
    const summaryUnchanged = fromRow.summary === toRow.summary;

    behaviorStable = astFingerprintUnchanged && summaryUnchanged;
  }

  let stabilityScore =
    (interfaceStable ? STABILITY_SCORE_INTERFACE : 0) +
    (behaviorStable ? STABILITY_SCORE_BEHAVIOR : 0) +
    (sideEffectsStable ? STABILITY_SCORE_SIDE_EFFECTS : 0);

  if (stabilityScore < 0 || stabilityScore > 100) {
    stabilityScore = Math.max(0, Math.min(100, stabilityScore));
  }

  const riskScore = 100 - stabilityScore;

  return {
    interfaceStable,
    behaviorStable,
    sideEffectsStable,
    riskScore,
  };
}

export async function computeDeltaWithTiers(
  repoId: string,
  fromVersion: VersionId,
  toVersion: VersionId,
): Promise<DeltaPack & { changedSymbols: DeltaSymbolChangeWithTiers[] }> {
  const conn = await getKuzuConn();
  const fromVersions = await getSymbolVersions(conn, fromVersion);
  const toVersions = await getSymbolVersions(conn, toVersion);

  if (fromVersions.length === 0) {
    throw new IndexError(
      `No symbol snapshots found for fromVersion ${fromVersion}. Run indexing to create snapshots.`,
    );
  }

  if (toVersions.length === 0) {
    throw new IndexError(
      `No symbol snapshots found for toVersion ${toVersion}. Run indexing to create snapshots.`,
    );
  }

  const fromMap = new Map<string, kuzuDb.SymbolVersionRow>(
    fromVersions.map((v) => [v.symbolId, v]),
  );
  const toMap = new Map<string, kuzuDb.SymbolVersionRow>(
    toVersions.map((v) => [v.symbolId, v]),
  );

  const changedSymbols: DeltaSymbolChangeWithTiers[] = [];

  for (const [symbolId, toRow] of toMap) {
    const fromRow = fromMap.get(symbolId);

    if (!fromRow) {
      const change: DeltaSymbolChangeWithTiers = {
        symbolId,
        changeType: "added",
        tiers: {
          interfaceStable: false,
          behaviorStable: false,
          sideEffectsStable: false,
          riskScore: 100,
        },
      };
      changedSymbols.push(change);
      continue;
    }

    const signatureDiff = diffSignature(
      fromRow.signatureJson,
      toRow.signatureJson,
    );
    const invariantDiff = diffArray(
      fromRow.invariantsJson,
      toRow.invariantsJson,
    );
    const sideEffectDiff = diffArray(
      fromRow.sideEffectsJson,
      toRow.sideEffectsJson,
    );

    const isModified =
      fromRow.astFingerprint !== toRow.astFingerprint ||
      fromRow.summary !== toRow.summary ||
      signatureDiff !== undefined ||
      invariantDiff !== undefined ||
      sideEffectDiff !== undefined;

    if (isModified) {
      const baseChange: DeltaSymbolChange = {
        symbolId,
        changeType: "modified",
        signatureDiff,
        invariantDiff,
        sideEffectDiff,
      };

      const tiers = computeStalenessTiers(baseChange, fromRow, toRow);

      changedSymbols.push({
        ...baseChange,
        tiers,
      });
    }
  }

  for (const [symbolId] of fromMap) {
    if (!toMap.has(symbolId)) {
      const change: DeltaSymbolChangeWithTiers = {
        symbolId,
        changeType: "removed",
        tiers: {
          interfaceStable: false,
          behaviorStable: false,
          sideEffectsStable: false,
          riskScore: 100,
        },
      };
      changedSymbols.push(change);
    }
  }

  return {
    repoId,
    fromVersion,
    toVersion,
    changedSymbols,
    blastRadius: [],
  };
}
