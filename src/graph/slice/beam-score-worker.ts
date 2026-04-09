import { parentPort } from "worker_threads";
import type { SymbolRow, MetricsRow, FileRow } from "../../db/schema.js";
import {
  applyCentralityTiebreak,
  scoreSymbolWithCentralityContext,
  type CentralityStats,
  type SliceContext,
} from "../score.js";

export interface ScoreCandidate {
  symbolId: string;
  neighborSymbol: SymbolRow;
  edgeWeight: number;
}

export interface ScoreWorkerInput {
  candidates: ScoreCandidate[];
  context: SliceContext;
  metricsMap: Record<string, MetricsRow | null>;
  filesMap: Record<number, FileRow | undefined>;
  centralityStats: CentralityStats;
  scoreThreshold: number;
}

export interface ScoreWorkerOutput {
  results: Array<{
    symbolId: string;
    score: number;
    passed: boolean;
  }>;
  error?: string;
}

parentPort?.on("message", (msg: ScoreWorkerInput) => {
  try {
    const results: ScoreWorkerOutput["results"] = [];

    for (const candidate of msg.candidates) {
      const { primaryScore, centralitySignal } =
        scoreSymbolWithCentralityContext(
        candidate.neighborSymbol,
        msg.context,
        msg.metricsMap[candidate.symbolId] ?? null,
        msg.filesMap[candidate.neighborSymbol.file_id],
        msg.centralityStats,
      );

      const finalScore = applyCentralityTiebreak(
        primaryScore * candidate.edgeWeight,
        centralitySignal,
      );
      const passed = finalScore >= msg.scoreThreshold;

      results.push({
        symbolId: candidate.symbolId,
        score: finalScore,
        passed,
      });
    }

    const output: ScoreWorkerOutput = { results };
    parentPort?.postMessage(output);
  } catch (error) {
    const output: ScoreWorkerOutput = {
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
    parentPort?.postMessage(output);
  }
});
