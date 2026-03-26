import { dirname, join, resolve } from "path";

import { existsAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";

import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

async function findNearestCargoToml(
  repoRoot: string,
  importerRelPath: string,
): Promise<string | null> {
  let currentDir = resolve(repoRoot, dirname(importerRelPath));
  const repoRootAbs = resolve(repoRoot);

   
  while (true) {
    const candidate = join(currentDir, "Cargo.toml");
    if (await existsAsync(candidate)) {
      return candidate;
    }
    if (currentDir === repoRootAbs) {
      return null;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function resolveImporterModuleDir(importerRelPath: string): string {
  return dirname(normalizePath(importerRelPath));
}

async function resolveRustRootDir(
  repoRoot: string,
  importerRelPath: string,
): Promise<string> {
  const cargoTomlPath = await findNearestCargoToml(repoRoot, importerRelPath);
  if (!cargoTomlPath) {
    return "src";
  }
  return normalizePath(join(dirname(cargoTomlPath), "src"));
}

async function collectRustModuleCandidates(
  repoRoot: string,
  baseDir: string,
  moduleSegments: string[],
): Promise<string[]> {
  const basePath = normalizePath(join(baseDir, ...moduleSegments));
  const fileCandidate = `${basePath}.rs`;
  const modCandidate = normalizePath(join(basePath, "mod.rs"));
  const results: string[] = [];

  if (await existsAsync(join(repoRoot, fileCandidate))) {
    results.push(fileCandidate);
  }
  if (await existsAsync(join(repoRoot, modCandidate))) {
    results.push(modCandidate);
  }

  return results;
}

export class RustImportResolutionAdapter implements ImportResolutionAdapter {
  readonly id = "rust";

  supports(language: string): boolean {
    return language === "rust";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    const specifier = params.specifier.trim();
    if (!specifier) {
      return [];
    }

    const importerModuleDir = resolveImporterModuleDir(params.importerRelPath);
    const crateRootDir = await resolveRustRootDir(
      params.repoRoot,
      params.importerRelPath,
    );

    let baseDir = importerModuleDir;
    let rawSegments = specifier.split("::").filter(Boolean);

    if (specifier.startsWith("crate::")) {
      baseDir = crateRootDir;
      rawSegments = rawSegments.slice(1);
    } else if (specifier.startsWith("self::")) {
      rawSegments = rawSegments.slice(1);
    } else if (specifier.startsWith("super::")) {
      baseDir = dirname(importerModuleDir);
      rawSegments = rawSegments.slice(1);
    }

    if (rawSegments.length === 0) {
      return [];
    }

    const candidateSegmentSets = [
      rawSegments.slice(0, -1),
      rawSegments,
    ].filter((segments) => segments.length > 0);

    const resolvedCandidates = new Set<string>();
    for (const segments of candidateSegmentSets) {
      const candidates = await collectRustModuleCandidates(
        params.repoRoot,
        baseDir,
        segments,
      );
      for (const candidate of candidates) {
        resolvedCandidates.add(candidate);
      }
      if (resolvedCandidates.size > 0) {
        break;
      }
    }

    return Array.from(resolvedCandidates).sort();
  }
}
