import type { DependencyFrontier } from "./dependency-frontier.js";

export interface ReconcileWorkPlan {
  repoId: string;
  filePaths: string[];
  touchedSymbolIds: string[];
  recomputeDerivedData: boolean;
  invalidations: Array<"metrics" | "clusters" | "processes">;
}

export function planReconcileWork(params: {
  repoId: string;
  frontier: DependencyFrontier;
}): ReconcileWorkPlan {
  const { repoId, frontier } = params;
  const filePaths = Array.from(
    new Set([...frontier.dependentFilePaths, ...frontier.importedFilePaths]),
  )
    .filter(Boolean)
    .sort();

  return {
    repoId,
    filePaths,
    touchedSymbolIds: [...frontier.touchedSymbolIds].sort(),
    recomputeDerivedData: frontier.invalidations.some(
      (item) => item === "clusters" || item === "processes",
    ),
    invalidations: [...frontier.invalidations],
  };
}
