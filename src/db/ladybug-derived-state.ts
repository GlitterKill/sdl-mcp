/**
 * DerivedState freshness record per repo.
 *
 * Tracks staleness of cluster / process / algorithm / summary / embedding
 * work so failed post-index derived computation is visible in repo.status. See
 * devdocs/plans/2026-04-17-post-pass2-performance-and-feedback-plan.md §5.
 */

import type { Connection } from "kuzu";

import { getLadybugConn, withWriteConn } from "./ladybug.js";
import { exec, queryAll, querySingle } from "./ladybug-core.js";
import { getCurrentTimestamp } from "../util/time.js";
import { logger } from "../util/logger.js";

export type GraphIntegrityState =
  | "unknown"
  | "verifying"
  | "verified"
  | "failed";

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
  graphIntegrityState: GraphIntegrityState;
  graphIntegrityVersionId: string | null;
  graphIntegrityDigest: string | null;
  graphIntegrityError: string | null;
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
    graphIntegrityState: normalizeGraphIntegrityState(
      raw.graphIntegrityState,
    ),
    graphIntegrityVersionId:
      (raw.graphIntegrityVersionId as string | null) ?? null,
    graphIntegrityDigest:
      (raw.graphIntegrityDigest as string | null) ?? null,
    graphIntegrityError:
      (raw.graphIntegrityError as string | null) ?? null,
  };
}

export async function getDerivedState(
  repoId: string,
): Promise<DerivedStateRow | null> {
  const conn = await getLadybugConn();
  const rows = await queryAll<Record<string, unknown>>(
    conn,
    "MATCH (d:DerivedState {repoId: $repoId}) RETURN d.repoId AS repoId, d.clustersDirty AS clustersDirty, d.processesDirty AS processesDirty, d.algorithmsDirty AS algorithmsDirty, d.summariesDirty AS summariesDirty, d.embeddingsDirty AS embeddingsDirty, d.targetVersionId AS targetVersionId, d.computedVersionId AS computedVersionId, d.updatedAt AS updatedAt, d.lastError AS lastError, d.graphIntegrityState AS graphIntegrityState, d.graphIntegrityVersionId AS graphIntegrityVersionId, d.graphIntegrityDigest AS graphIntegrityDigest, d.graphIntegrityError AS graphIntegrityError",
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
  options?: { clearError?: boolean },
): Promise<void> {
  const updatedAt = getCurrentTimestamp();
  // When no selective flags are given, clear everything.
  const clearAll = !clearedFlags;
  const clearClusters = clearAll || Boolean(clearedFlags?.clusters);
  const clearProcesses = clearAll || Boolean(clearedFlags?.processes);
  const clearAlgorithms = clearAll || Boolean(clearedFlags?.algorithms);
  const clearSummaries = clearAll || Boolean(clearedFlags?.summaries);
  const clearEmbeddings = clearAll || Boolean(clearedFlags?.embeddings);
  const clearError = options?.clearError ?? true;
  await withWriteConn(async (wConn) => {
    await exec(
      wConn,
      "MERGE (d:DerivedState {repoId: $repoId}) SET d.clustersDirty = CASE WHEN $clearClusters THEN false ELSE d.clustersDirty END, d.processesDirty = CASE WHEN $clearProcesses THEN false ELSE d.processesDirty END, d.algorithmsDirty = CASE WHEN $clearAlgorithms THEN false ELSE d.algorithmsDirty END, d.summariesDirty = CASE WHEN $clearSummaries THEN false ELSE d.summariesDirty END, d.embeddingsDirty = CASE WHEN $clearEmbeddings THEN false ELSE d.embeddingsDirty END, d.computedVersionId = $computedVersionId, d.targetVersionId = $computedVersionId, d.updatedAt = $updatedAt, d.lastError = CASE WHEN $clearError THEN null ELSE d.lastError END",
      {
        repoId,
        clearClusters,
        clearProcesses,
        clearAlgorithms,
        clearSummaries,
        clearEmbeddings,
        clearError,
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

export async function markGraphIntegrityVerifying(
  repoId: string,
  versionId: string,
): Promise<void> {
  await setGraphIntegrityState(repoId, {
    state: "verifying",
    versionId,
    digest: null,
    error: null,
  });
}

export async function markGraphIntegrityVerified(
  repoId: string,
  versionId: string,
  digest: string,
): Promise<void> {
  await setGraphIntegrityState(repoId, {
    state: "verified",
    versionId,
    digest,
    error: null,
  });
}

/** Publish a digest only while the same verification attempt still owns state. */
export async function markGraphIntegrityVerifiedIfVerifying(
  repoId: string,
  versionId: string,
  digest: string,
): Promise<boolean> {
  const updatedAt = getCurrentTimestamp();
  return withWriteConn(async (wConn) => {
    const row = await querySingle<{ repoId: string }>(
      wConn,
      `MATCH (d:DerivedState {repoId: $repoId})
       WHERE d.graphIntegrityState = 'verifying'
         AND d.graphIntegrityVersionId = $versionId
       SET d.graphIntegrityState = 'verified',
           d.graphIntegrityDigest = $graphIntegrityDigest,
           d.graphIntegrityError = NULL,
           d.updatedAt = $updatedAt
       RETURN d.repoId AS repoId`,
      { repoId, versionId, graphIntegrityDigest: digest, updatedAt },
    );
    return row !== null;
  });
}

export async function markGraphIntegrityFailed(
  repoId: string,
  versionId: string,
  error: string,
): Promise<void> {
  await setGraphIntegrityState(repoId, {
    state: "failed",
    versionId,
    digest: null,
    error: error.slice(0, 1024),
  });
}

/** Fail closed when a durable mutation bypasses the versioned index lifecycle. */
export async function invalidateGraphIntegrity(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await exec(
    conn,
    `MERGE (d:DerivedState {repoId: $repoId})
     SET d.graphIntegrityState = 'unknown',
         d.graphIntegrityVersionId = NULL,
         d.graphIntegrityDigest = NULL,
         d.graphIntegrityError = NULL,
         d.updatedAt = $updatedAt`,
    { repoId, updatedAt: getCurrentTimestamp() },
  );
}

export function graphIntegrityIsVerifiedForVersion(
  row: Pick<
    DerivedStateRow,
    "graphIntegrityState" | "graphIntegrityVersionId" | "graphIntegrityDigest"
  > | null,
  versionId: string | null,
): boolean {
  return Boolean(
    row &&
      versionId &&
      row.graphIntegrityState === "verified" &&
      row.graphIntegrityVersionId === versionId &&
      /^[a-f0-9]{64}$/.test(row.graphIntegrityDigest ?? ""),
  );
}

async function setGraphIntegrityState(
  repoId: string,
  state: {
    state: GraphIntegrityState;
    versionId: string;
    digest: string | null;
    error: string | null;
  },
): Promise<void> {
  const updatedAt = getCurrentTimestamp();
  await withWriteConn(async (wConn) => {
    await exec(
      wConn,
      `MERGE (d:DerivedState {repoId: $repoId})
       SET d.graphIntegrityState = $graphIntegrityState,
           d.graphIntegrityVersionId = $graphIntegrityVersionId,
           d.graphIntegrityDigest = $graphIntegrityDigest,
           d.graphIntegrityError = $graphIntegrityError,
           d.updatedAt = $updatedAt`,
      {
        repoId,
        graphIntegrityState: state.state,
        graphIntegrityVersionId: state.versionId,
        graphIntegrityDigest: state.digest,
        graphIntegrityError: state.error,
        updatedAt,
      },
    );
  });
}

function normalizeGraphIntegrityState(value: unknown): GraphIntegrityState {
  return value === "verifying" || value === "verified" || value === "failed"
    ? value
    : "unknown";
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
  graphIntegrityState: GraphIntegrityState;
  graphIntegrityVersionId: string | null;
  graphIntegrityDigest: string | null;
  nextBestAction?: string;
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
    graphIntegrityState: row.graphIntegrityState,
    graphIntegrityVersionId: row.graphIntegrityVersionId,
    graphIntegrityDigest: row.graphIntegrityDigest,
  };
  if (row.lastError) {
    summary.lastError = row.lastError;
  }
  if (row.graphIntegrityState !== "verified") {
    summary.nextBestAction = graphIntegrityNextBestAction(
      row.graphIntegrityState,
    );
  } else if (summary.stale) {
    summary.nextBestAction = row.lastError
      ? "Derived state recomputation failed. Inspect derivedState.lastError, then run sdl.index.refresh with mode:\"incremental\"; use mode:\"full\" if stale flags remain."
      : "Derived state is stale, likely from an interrupted older refresh. Run sdl.index.refresh with mode:\"incremental\" to recompute derived state inline.";
  }
  return summary;
}

export function graphIntegrityNextBestAction(
  state: GraphIntegrityState | "version-mismatch",
): string {
  if (state === "verifying") {
    return "Graph integrity verification is in progress. Wait for the active index refresh to finish; if no refresh is active, run sdl.index.refresh with mode:\"full\".";
  }
  if (state === "failed") {
    return 'Graph integrity verification failed. Run sdl.index.refresh with mode:"full" to rebuild and verify the graph. If full verification fails again, stop SDL-MCP, delete the configured .lbug database directory, and rebuild from source.';
  }
  if (state === "version-mismatch") {
    return 'Graph integrity belongs to another graph version. Run sdl.index.refresh with mode:"full" to establish a current verified baseline.';
  }
  return 'Graph integrity is unverified. Run sdl.index.refresh with mode:"full" to establish a verified baseline.';
}
