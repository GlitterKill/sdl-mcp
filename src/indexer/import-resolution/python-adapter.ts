import { dirname, join, resolve } from "path";

import { existsAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";

import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

function splitLeadingDots(specifier: string): {
  leadingDotCount: number;
  remainder: string;
} {
  const match = specifier.match(/^\.+/);
  const leadingDotCount = match?.[0].length ?? 0;
  return {
    leadingDotCount,
    remainder: specifier.slice(leadingDotCount),
  };
}

function resolveRelativeBaseDir(
  importerRelPath: string,
  leadingDotCount: number,
): string {
  let baseDir = normalizePath(dirname(importerRelPath));
  const levelsToAscend = Math.max(leadingDotCount - 1, 0);
  for (let index = 0; index < levelsToAscend; index += 1) {
    baseDir = normalizePath(dirname(baseDir));
  }
  return baseDir;
}

function buildModuleCandidateBases(
  baseDir: string,
  modulePath: string,
): { fileBase: string; packageBase: string } {
  const normalizedModulePath = modulePath.split(".").filter(Boolean).join("/");
  const moduleBase = normalizedModulePath
    ? normalizePath(join(baseDir, normalizedModulePath))
    : normalizePath(baseDir);

  return {
    fileBase: moduleBase,
    packageBase: normalizePath(join(moduleBase, "__init__")),
  };
}

export class PythonImportResolutionAdapter implements ImportResolutionAdapter {
  readonly id = "python";

  supports(language: string): boolean {
    return language === "python";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    const specifier = params.specifier.trim();
    if (!specifier) {
      return [];
    }

    const { leadingDotCount, remainder } = splitLeadingDots(specifier);
    const baseDir =
      leadingDotCount > 0
        ? resolveRelativeBaseDir(params.importerRelPath, leadingDotCount)
        : "";

    const { fileBase, packageBase } = buildModuleCandidateBases(
      baseDir,
      remainder,
    );
    const candidates = params.extensions.flatMap((extension) => [
      `${fileBase}${extension}`,
      `${packageBase}${extension}`,
    ]);

    const matches: string[] = [];
    for (const candidate of candidates) {
      if (await existsAsync(resolve(params.repoRoot, candidate))) {
        matches.push(normalizePath(candidate));
      }
    }

    return Array.from(new Set(matches)).sort();
  }
}
