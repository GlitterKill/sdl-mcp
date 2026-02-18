import * as db from "../db/queries.js";
import type { HealthComponents } from "./types.js";
import type { RepoConfig } from "../config/types.js";
import { scanRepository } from "../indexer/fileScanner.js";

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
  const minIndexedSymbols = input.minIndexedSymbols ?? DEFAULT_MIN_INDEXED_SYMBOLS;
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
  const repo = db.getRepo(repoId);
  if (!repo) {
    throw new Error(`Repository ${repoId} not found`);
  }

  const repoConfig = JSON.parse(repo.config_json) as RepoConfig;
  const eligibleFiles = await scanRepository(repo.root_path, repoConfig);
  const files = db.getFilesByRepo(repoId);
  const indexedSymbols = db.countSymbolsByRepo(repoId);
  const edges = db.getEdgesByRepo(repoId);

  const lastIndexedFile = files
    .filter((f) => f.last_indexed_at !== null)
    .sort(
      (a, b) =>
        new Date(b.last_indexed_at ?? 0).getTime() -
        new Date(a.last_indexed_at ?? 0).getTime(),
    )[0];

  const lastIndexedAt = lastIndexedFile?.last_indexed_at ?? null;
  const minutesSinceLastIndex = lastIndexedAt
    ? Math.max(0, (Date.now() - new Date(lastIndexedAt).getTime()) / 60000)
    : null;

  const callEdges = edges.filter((edge) => edge.type === "call");
  const resolvedCallEdges = callEdges.filter(
    (edge) => !edge.to_symbol_id.startsWith("unresolved:"),
  );

  const score = computeHealthScore({
    indexedFiles: files.length,
    totalEligibleFiles: eligibleFiles.length,
    indexErrors: 0,
    totalFiles: Math.max(eligibleFiles.length, files.length),
    resolvedCallEdges: resolvedCallEdges.length,
    totalCallEdges: callEdges.length,
    minutesSinceLastIndex,
    indexedSymbols,
  });

  return {
    repoId,
    ...score,
    indexedFiles: files.length,
    indexedSymbols,
    totalEligibleFiles: eligibleFiles.length,
    totalCallEdges: callEdges.length,
    resolvedCallEdges: resolvedCallEdges.length,
    minutesSinceLastIndex,
  };
}

export function getBadgeColor(score: number): "green" | "yellow" | "red" {
  if (score >= 80) return "green";
  if (score >= 60) return "yellow";
  return "red";
}

