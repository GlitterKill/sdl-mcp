import { dirname, join } from "path";

import { existsAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";

import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

export class ShellImportResolutionAdapter implements ImportResolutionAdapter {
  readonly id = "shell";

  supports(language: string): boolean {
    return language === "shell";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    const specifier = params.specifier;

    const importerDir = dirname(params.importerRelPath);
    const relativeCandidate = normalizePath(join(importerDir, specifier));
    if (await existsAsync(join(params.repoRoot, relativeCandidate))) {
      return [relativeCandidate];
    }

    const rootCandidate = normalizePath(specifier);
    if (await existsAsync(join(params.repoRoot, rootCandidate))) {
      return [rootCandidate];
    }

    if (!specifier.includes(".")) {
      for (const extension of params.extensions) {
        const withExtRel = normalizePath(
          join(importerDir, `${specifier}${extension}`),
        );
        if (await existsAsync(join(params.repoRoot, withExtRel))) {
          return [withExtRel];
        }

        const withExtRoot = normalizePath(`${specifier}${extension}`);
        if (await existsAsync(join(params.repoRoot, withExtRoot))) {
          return [withExtRoot];
        }
      }
    }

    return [];
  }
}
