import { readdir } from "node:fs/promises";
import { hash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import type { RepoConfig } from "../config/types.js";
import { dirtyPathMatchesScipGeneratorConfig } from "../scip/scip-io-runner.js";
import { readRepositoryFileBounded } from "../indexer/provider-first/executor.js";
import { normalizePath } from "../util/paths.js";
import type { DependencyFrontier } from "./dependency-frontier.js";

/** Capture concrete ancestor build inputs, not a whole repository source scan. */
export async function captureReconcileDependencyInputs(
  repoRoot: string,
  config: RepoConfig,
  files: readonly string[],
) {
  repoRoot = resolve(repoRoot);
  const directories = new Set<string>([repoRoot]);
  for (const file of files) {
    let directory = dirname(resolve(repoRoot, file));
    while (directory !== repoRoot) {
      const rel = relative(repoRoot, directory);
      if (
        rel.startsWith("..") ||
        resolve(directory) === dirname(resolve(directory))
      )
        throw new Error("Reconciliation dependency path outside repository");
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  const paths = new Set<string>();
  for (const directory of directories) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        dirtyPathMatchesScipGeneratorConfig(entry.name)
      )
        paths.add(
          normalizePath(relative(repoRoot, join(directory, entry.name))),
        );
    }
  }
  for (const path of [
    config.packageJsonPath,
    config.tsconfigPath,
    config.sourceFileListPath,
  ]) {
    if (path)
      paths.add(normalizePath(relative(repoRoot, resolve(repoRoot, path))));
  }
  if (paths.size > 256)
    throw new Error("Reconciliation has too many concrete project inputs");
  const inputs = [];
  for (const path of [...paths].sort()) {
    const source = await readRepositoryFileBounded(
      repoRoot,
      path,
      config.maxFileBytes,
    );
    if (source.kind !== "ok")
      throw new Error(`Reconciliation project input unavailable: ${path}`);
    inputs.push({
      path,
      contentHash: hash("sha256", source.content, "hex"),
    });
  }
  return inputs;
}

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
