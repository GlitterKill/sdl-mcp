/**
 * DerivedState freshness record per repo.
 *
 * Tracks staleness of cluster / process / algorithm / summary / embedding
 * work so incremental indexing can defer it without losing track. See
 * devdocs/plans/2026-04-17-post-pass2-performance-and-feedback-plan.md §5.
 */

import { getLadybugConn, withWriteConn } from "./ladybug.js";
import { exec, queryAll } from "./ladybug-core.js";
import { getCurrentTimestamp } from "../util/time.js";
import { logger } from "../util/logger.js";

export interface DerivedStateRow {
  repoId: string;
  clustersDirty: boolean;
  processesDirty: boolean;
  algorithmsDirty: boolean;
  summariesDirty: boolean;
  embeddingsDirty: boolean;
  targetVersionId: string | null;
  computedVersionId: string | null;
  updatedAt: string | null;
  lastError: string | null;
}

export interface DerivedStateDirtyFlags {
  clusters?: boolean;
  processes?: boolean;
  algorithms?: boolean;
  summaries?: boolean;
  embeddings?: boolean;
}

function normalizeRow(
  raw: Record<string, unknown> | null,
): DerivedStateRow | null {
  if (!raw) return null;
  return {
    repoId: String(raw.repoId ?? ""),
    clustersDirty: Boolean(raw.clustersDirty),
    processesDirty: Boolean(raw.processesDirty),
    algorithmsDirty: Boolean(raw.algorithmsDirty),
    summariesDirty: Boolean(raw.summariesDirty),
    embeddingsDirty: Boolean(raw.embeddingsDirty),
    targetVersionId: (raw.targetVersionId as string | null) ?? null,
    computedVersionId: (raw.computedVersionId as string | null) ?? null,
    updatedAt: (raw.updatedAt as string | null) ?? null,
    lastError: (raw.lastError as string | null) ?? null,
  };
}

export async function getDerivedState(
  repoId: string,
): Promise<DerivedStateRow | null> {
  const conn = await getLadybugConn();
  const rows = await queryAll<Record<string, unknown>>(
    conn,
    "MATCH (d:DerivedState {repoId: $repoId}) RETURN d.repoId AS repoId, d.clustersDirty AS clustersDirty, d.processesDirty AS processesDirty, d.algorithmsDirty AS algorithmsDirty, d.summariesDirty AS summariesDirty, d.embeddingsDirty AS embeddingsDirty, d.targetVersionId AS targetVersionId, d.computedVersionId AS computedVersionId, d.updatedAt AS updatedAt, d.lastError AS lastError",
    { repoId },
  );
  return normalizeRow(rows[0] ?? null);
}

export async function markDerivedStateDirty(
  repoId: string,
  targetVersionId: string,
  flags: DerivedStateDirtyFlags,
): Promise<void> {
  const updatedAt = getCurrentTimestamp();
  await withWriteConn(async (wConn) => {
    await exec(
      wConn,
      "MERGE (d:DerivedState {repoId: $repoId}) ON CREATE SET d.clustersDirty = $clustersDirty, d.processesDirty = $processesDirty, d.algorithmsDirty = $algorithmsDirty, d.summariesDirty = $summariesDirty, d.embeddingsDirty = $embeddingsDirty, d.targetVersionId = $targetVersionId, d.updatedAt = $updatedAt ON MATCH SET d.clustersDirty = d.clustersDirty OR $clustersDirty, d.processesDirty = d.processesDirty OR $processesDirty, d.algorithmsDirty = d.algorithmsDirty OR $algorithmsDirty, d.summariesDirty = d.summariesDirty OR $summariesDirty, d.embeddingsDirty = d.embeddingsDirty OR $embeddingsDirty, d.targetVersionId = $targetVersionId, d.updatedAt = $updatedAt",
      {
        repoId,
        clustersDirty: Boolean(flags.clusters),
        processesDirty: Boolean(flags.processes),
        algorithmsDirty: Boolean(flags.algorithms),
        summariesDirty: Boolean(flags.summaries),
        embeddingsDirty: Boolean(flags.embeddings),
        targetVersionId,
        updatedAt,
      },
    );
  });
}

export async function markDerivedStateComputed(
  repoId: string,
  computedVersionId: string,
  clearedFlags?: DerivedStateDirtyFlags,
): Promise<void> {
  const updatedAt = getCurrentTimestamp();
  // When no selective flags are given, clear everything.
  const clearAll = !clearedFlags;
  const clearClusters = clearAll || Boolean(clearedFlags?.clusters);
  const clearProcesses = clearAll || Boolean(clearedFlags?.processes);
  const clearAlgorithms = clearAll || Boolean(clearedFlags?.algorithms);
  const clearSummaries = clearAll || Boolean(clearedFlags?.summaries);
  const clearEmbeddings = clearAll || Boolean(clearedFlags?.embeddings);
  await withWriteConn(async (wConn) => {
    await exec(
      wConn,
      "MERGE (d:DerivedState {repoId: $repoId}) SET d.clustersDirty = CASE WHEN $clearClusters THEN false ELSE d.clustersDirty END, d.processesDirty = CASE WHEN $clearProcesses THEN false ELSE d.processesDirty END, d.algorithmsDirty = CASE WHEN $clearAlgorithms THEN false ELSE d.algorithmsDirty END, d.summariesDirty = CASE WHEN $clearSummaries THEN false ELSE d.summariesDirty END, d.embeddingsDirty = CASE WHEN $clearEmbeddings THEN false ELSE d.embeddingsDirty END, d.computedVersionId = $computedVersionId, d.targetVersionId = $computedVersionId, d.updatedAt = $updatedAt, d.lastError = null",
      {
        repoId,
        clearClusters,
        clearProcesses,
        clearAlgorithms,
        clearSummaries,
        clearEmbeddings,
        computedVersionId,
        updatedAt,
      },
    );
  });
}

export async function recordDerivedStateError(
  repoId: string,
  lastError: string,
): Promise<void> {
  const updatedAt = getCurrentTimestamp();
  try {
    await withWriteConn(async (wConn) => {
      await exec(
        wConn,
        "MERGE (d:DerivedState {repoId: $repoId}) SET d.lastError = $lastError, d.updatedAt = $updatedAt",
        { repoId, lastError: lastError.slice(0, 1024), updatedAt },
      );
    });
  } catch (err) {
    logger.debug("recordDerivedStateError failed", {
      repoId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function derivedStateIsStale(row: DerivedStateRow | null): boolean {
  if (!row) return false;
  return (
    row.clustersDirty ||
    row.processesDirty ||
    row.algorithmsDirty ||
    row.summariesDirty ||
    row.embeddingsDirty
  );
}

export interface DerivedStateSummary {
  stale: boolean;
  clustersDirty: boolean;
  processesDirty: boolean;
  algorithmsDirty: boolean;
  summariesDirty: boolean;
  embeddingsDirty: boolean;
  targetVersionId: string | null;
  computedVersionId: string | null;
  updatedAt: string | null;
  lastError?: string | null;
}

export async function getDerivedStateSummary(
  repoId: string,
): Promise<DerivedStateSummary | null> {
  const row = await getDerivedState(repoId);
  if (!row) return null;
  const summary: DerivedStateSummary = {
    stale: derivedStateIsStale(row),
    clustersDirty: row.clustersDirty,
    processesDirty: row.processesDirty,
    algorithmsDirty: row.algorithmsDirty,
    summariesDirty: row.summariesDirty,
    embeddingsDirty: row.embeddingsDirty,
    targetVersionId: row.targetVersionId,
    computedVersionId: row.computedVersionId,
    updatedAt: row.updatedAt,
  };
  if (row.lastError) {
    summary.lastError = row.lastError;
  }
  return summary;
}
