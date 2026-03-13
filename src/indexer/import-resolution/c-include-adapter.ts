import { dirname, join } from "path";

import { existsAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";

import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

function hasKnownExtension(specifier: string, extensions: string[]): boolean {
  return extensions.some((extension) => specifier.endsWith(extension));
}

function buildSpecifierCandidates(
  specifier: string,
  extensions: string[],
): string[] {
  if (hasKnownExtension(specifier, extensions)) {
    return [specifier];
  }

  return [
    specifier,
    ...extensions.map((extension) => `${specifier}${extension}`),
  ];
}

export class CIncludeImportResolutionAdapter implements ImportResolutionAdapter {
  readonly id = "c-include";

  supports(language: string): boolean {
    return language === "c" || language === "cpp";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    const importerDir = dirname(params.importerRelPath);
    const specifierCandidates = buildSpecifierCandidates(
      params.specifier,
      params.extensions,
    );

    for (const specifierCandidate of specifierCandidates) {
      const relativeToImporter = normalizePath(
        join(importerDir, specifierCandidate),
      );
      if (await existsAsync(join(params.repoRoot, relativeToImporter))) {
        return [relativeToImporter];
      }
    }

    for (const specifierCandidate of specifierCandidates) {
      const relativeToRoot = normalizePath(specifierCandidate);
      if (await existsAsync(join(params.repoRoot, relativeToRoot))) {
        return [relativeToRoot];
      }
    }

    for (const includeDir of ["include", "inc", "src"]) {
      for (const specifierCandidate of specifierCandidates) {
        const includeCandidate = normalizePath(
          join(includeDir, specifierCandidate),
        );
        if (await existsAsync(join(params.repoRoot, includeCandidate))) {
          return [includeCandidate];
        }
      }
    }

    return [];
  }
}
