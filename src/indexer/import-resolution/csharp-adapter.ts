import fastGlob from "fast-glob";
import { join } from "path";

import { existsAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";

import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

function splitSpecifier(specifier: string): {
  namespacePath: string;
  typeName: string;
} {
  const parts = specifier.split(".").filter(Boolean);
  if (parts.length === 0) {
    return { namespacePath: "", typeName: "" };
  }

  return {
    namespacePath: parts.slice(0, -1).join("/"),
    typeName: parts[parts.length - 1] ?? "",
  };
}

export class CSharpImportResolutionAdapter implements ImportResolutionAdapter {
  readonly id = "csharp";

  supports(language: string): boolean {
    return language === "csharp";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    if (!params.specifier.includes(".")) {
      return [];
    }

    const { namespacePath, typeName } = splitSpecifier(params.specifier);
    if (!namespacePath || !typeName) {
      return [];
    }

    const matches: string[] = [];
    for (const extension of params.extensions) {
      const candidate = normalizePath(
        join(namespacePath, `${typeName}${extension}`),
      );
      if (await existsAsync(join(params.repoRoot, candidate))) {
        matches.push(candidate);
      }
    }

    if (matches.length > 0) {
      return Array.from(new Set(matches)).sort();
    }

    const fallbackPatterns = params.extensions.map(
      (extension) => `**/${typeName}${extension}`,
    );
    const fallbackMatches = await fastGlob(fallbackPatterns, {
      cwd: params.repoRoot,
      onlyFiles: true,
      unique: true,
    });

    return fallbackMatches.map((path) => normalizePath(path)).sort();
  }
}
