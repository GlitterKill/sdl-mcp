import type { EdgeResolutionStrategy } from "../db/schema.js";

export interface CalibrationInput {
  isResolved: boolean;
  strategy?: EdgeResolutionStrategy;
  candidateCount?: number;
  baseConfidence?: number;
}

export interface CalibrationOutput {
  confidence: number;
  strategy: EdgeResolutionStrategy;
}

function clampConfidence(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function defaultConfidenceForStrategy(
  strategy: EdgeResolutionStrategy,
): number {
  switch (strategy) {
    case "exact":
      return 0.92;
    case "heuristic":
      return 0.72;
    case "unresolved":
      return 0.2;
    default:
      return 0.5;
  }
}

export function calibrateResolutionConfidence(
  input: CalibrationInput,
): CalibrationOutput {
  const strategy: EdgeResolutionStrategy =
    input.strategy ?? (input.isResolved ? "heuristic" : "unresolved");

  const baseline =
    typeof input.baseConfidence === "number"
      ? input.baseConfidence
      : defaultConfidenceForStrategy(strategy);

  const ambiguityPenalty =
    input.candidateCount && input.candidateCount > 1
      ? Math.min(0.35, input.candidateCount * 0.04)
      : 0;

  const confidence = clampConfidence(baseline - ambiguityPenalty);
  return { confidence, strategy };
}
