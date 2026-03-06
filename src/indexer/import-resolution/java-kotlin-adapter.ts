import fastGlob from "fast-glob";
import { dirname, join } from "path";

import { existsAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";

import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

const SOURCE_ROOT_MARKERS = [
  "src/main/java",
  "src/test/java",
  "src/main/kotlin",
  "src/test/kotlin",
  "src/java",
  "src/kotlin",
];

function resolveSourceRoot(importerRelPath: string): string {
  const normalizedPath = normalizePath(importerRelPath);
  for (const marker of SOURCE_ROOT_MARKERS) {
    const index = normalizedPath.indexOf(marker);
    if (index !== -1) {
      return normalizedPath.slice(0, index + marker.length);
    }
  }
  return dirname(normalizedPath);
}

function splitSpecifier(specifier: string): {
  packagePath: string;
  typeName: string;
} {
  const parts = specifier.split(".").filter(Boolean);
  if (parts.length === 0) {
    return { packagePath: "", typeName: "" };
  }
  return {
    packagePath: parts.slice(0, -1).join("/"),
    typeName: parts[parts.length - 1] ?? "",
  };
}

export class JavaKotlinImportResolutionAdapter
  implements ImportResolutionAdapter
{
  readonly id = "java-kotlin";

  supports(language: string): boolean {
    return language === "java" || language === "kotlin";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    if (!params.specifier.includes(".")) {
      return [];
    }

    const { packagePath, typeName } = splitSpecifier(params.specifier);
    if (!packagePath || !typeName) {
      return [];
    }

    const sourceRoot = resolveSourceRoot(params.importerRelPath);
    const matches: string[] = [];

    for (const extension of params.extensions) {
      const candidate = normalizePath(
        join(sourceRoot, packagePath, `${typeName}${extension}`),
      );
      if (await existsAsync(join(params.repoRoot, candidate))) {
        matches.push(candidate);
      }
    }

    if (matches.length > 0) {
      return Array.from(new Set(matches)).sort();
    }

    const fallbackPatterns = params.extensions.map(
      (extension) => `**/${packagePath}/${typeName}${extension}`,
    );
    const fallbackMatches = await fastGlob(fallbackPatterns, {
      cwd: params.repoRoot,
      onlyFiles: true,
      unique: true,
    });

    return fallbackMatches.map((path) => normalizePath(path)).sort();
  }
}
