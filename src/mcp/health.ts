import type { HealthComponents } from "./types.js";
import { RepoConfigSchema } from "../config/types.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { scanRepository } from "../indexer/fileScanner.js";
import { DatabaseError, NotFoundError } from "../domain/errors.js";

const DEFAULT_MIN_INDEXED_FILES = 1;
const DEFAULT_MIN_INDEXED_SYMBOLS = 1;

const WEIGHTS = {
  freshness: 0.25,
  coverage: 0.35,
  errorRate: 0.2,
  edgeQuality: 0.2,
} as const;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export interface HealthScoreInput {
  indexedFiles: number;
  totalEligibleFiles: number;
  indexErrors: number;
  totalFiles: number;
  resolvedCallEdges: number;
  totalCallEdges: number;
  /**
   * Number of call edges with `resolution_strategy = 'exact'` or
   * `confidence >= 0.9`. Used to compute `callResolution`. When omitted,
   * falls back to `resolvedCallEdges` for backward compatibility.
   */
  exactCallEdges?: number;
  minutesSinceLastIndex: number | null;
  minIndexedFiles?: number;
  minIndexedSymbols?: number;
  indexedSymbols: number;
}

export interface HealthScoreResult {
  score: number;
  available: boolean;
  components: HealthComponents;
}

export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  const minIndexedFiles = input.minIndexedFiles ?? DEFAULT_MIN_INDEXED_FILES;
  const minIndexedSymbols =
    input.minIndexedSymbols ?? DEFAULT_MIN_INDEXED_SYMBOLS;
  const available =
    input.indexedFiles >= minIndexedFiles &&
    input.indexedSymbols >= minIndexedSymbols;

  if (!available) {
    return {
      score: 0,
      available: false,
      components: {
        freshness: 0,
        coverage: 0,
        errorRate: 0,
        edgeQuality: 0,
        callResolution: 0,
      },
    };
  }

  const freshness = clamp01(
    input.minutesSinceLastIndex === null
      ? 0
      : 1 - input.minutesSinceLastIndex / 1440,
  );
  const coverage = clamp01(
    input.totalEligibleFiles <= 0
      ? 0
      : input.indexedFiles / input.totalEligibleFiles,
  );
  const errorRate = clamp01(
    input.totalFiles <= 0 ? 1 : 1 - input.indexErrors / input.totalFiles,
  );
  const edgeQuality = clamp01(
    input.totalCallEdges <= 0
      ? 1
      : input.resolvedCallEdges / input.totalCallEdges,
  );

  // callResolution: ratio of call edges resolved to 'exact' strategy or with
  // confidence >= 0.9 (high-confidence threshold). Falls back to edgeQuality
  // when resolution_strategy-level counts are unavailable (legacy code paths).
  const callResolution = clamp01(
    input.totalCallEdges <= 0
      ? 0
      : (input.exactCallEdges ?? input.resolvedCallEdges) /
          input.totalCallEdges,
  );

  const weighted =
    WEIGHTS.freshness * freshness +
    WEIGHTS.coverage * coverage +
    WEIGHTS.errorRate * errorRate +
    WEIGHTS.edgeQuality * edgeQuality;

  return {
    score: Math.round(clamp01(weighted) * 100),
    available: true,
    components: {
      freshness,
      coverage,
      errorRate,
      edgeQuality,
      callResolution,
    },
  };
}

export interface RepoHealthSnapshot extends HealthScoreResult {
  repoId: string;
  indexedFiles: number;
  indexedSymbols: number;
  totalEligibleFiles: number;
  totalCallEdges: number;
  resolvedCallEdges: number;
  minutesSinceLastIndex: number | null;
}

export async function getRepoHealthSnapshot(
  repoId: string,
): Promise<RepoHealthSnapshot> {
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new NotFoundError(`Repository ${repoId} not found`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(repo.configJson);
  } catch {
    throw new DatabaseError(
      `Repository ${repoId} has corrupt configJson in database`,
    );
  }
  const repoConfig = RepoConfigSchema.parse(parsed);
  const eligibleFiles = await scanRepository(repo.rootPath, repoConfig);
  const files = await ladybugDb.getFilesByRepo(conn, repoId);
  const indexedSymbols = await ladybugDb.getSymbolCount(conn, repoId);
  const callCounts = await ladybugDb.getCallEdgeResolutionCounts(conn, repoId);

  const lastIndexedFile = files
    .filter((f) => f.lastIndexedAt !== null)
    .sort(
      (a, b) =>
        new Date(b.lastIndexedAt ?? 0).getTime() -
        new Date(a.lastIndexedAt ?? 0).getTime(),
    )[0];

  const lastIndexedAt = lastIndexedFile?.lastIndexedAt ?? null;
  const minutesSinceLastIndex = lastIndexedAt
    ? Math.max(0, (Date.now() - new Date(lastIndexedAt).getTime()) / 60000)
    : null;

  const score = computeHealthScore({
    indexedFiles: files.length,
    totalEligibleFiles: eligibleFiles.length,
    indexErrors: 0,
    totalFiles: Math.max(eligibleFiles.length, files.length),
    resolvedCallEdges: callCounts.resolvedCallEdges,
    totalCallEdges: callCounts.totalCallEdges,
    exactCallEdges: callCounts.exactCallEdges,
    minutesSinceLastIndex,
    indexedSymbols,
  });

  return {
    repoId,
    ...score,
    indexedFiles: files.length,
    indexedSymbols,
    totalEligibleFiles: eligibleFiles.length,
    totalCallEdges: callCounts.totalCallEdges,
    resolvedCallEdges: callCounts.resolvedCallEdges,
    minutesSinceLastIndex,
  };
}

export function getBadgeColor(score: number): "green" | "yellow" | "red" {
  if (score >= 80) return "green";
  if (score >= 60) return "yellow";
  return "red";
}
