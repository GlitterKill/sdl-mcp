import { dirname, join, resolve } from "path";

import { existsAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";
import { createBuiltInImportResolutionAdapters } from "../language-support.js";

import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

let importResolutionAdapters: ImportResolutionAdapter[] | undefined;

function getImportResolutionAdapters(): readonly ImportResolutionAdapter[] {
  importResolutionAdapters ??= createBuiltInImportResolutionAdapters();
  return importResolutionAdapters;
}

/**
 * ESM-style imports use `.js` extensions that map to `.ts` source files at
 * build time.  When the literal `.js` path does not exist on disk we try the
 * TypeScript counterpart so that import resolution succeeds for the indexed
 * source tree.
 */
const TS_IMPORT_EXT_REMAPS: Record<string, string> = {
  ".js": ".ts",
  ".jsx": ".tsx",
  ".mjs": ".mts",
  ".cjs": ".cts",
};

async function resolveRelativeImportCandidatePaths(
  params: ResolveImportCandidatePathsParams,
): Promise<string[]> {
  if (
    !params.specifier.startsWith("./") &&
    !params.specifier.startsWith("../")
  ) {
    return [];
  }

  const importerDir = dirname(params.importerRelPath);
  const baseRelPath = normalizePath(join(importerDir, params.specifier));
  const hasExtension = params.extensions.some((ext) =>
    baseRelPath.endsWith(ext),
  );
  const candidates: string[] = [];

  if (hasExtension) {
    candidates.push(baseRelPath);

    // Try TS counterpart for ESM .js → .ts remapping
    const ext = params.extensions.find((e) => baseRelPath.endsWith(e));
    const tsExt = ext ? TS_IMPORT_EXT_REMAPS[ext] : undefined;
    if (tsExt) {
      candidates.push(baseRelPath.slice(0, -ext!.length) + tsExt);
    }
  } else {
    for (const extension of params.extensions) {
      candidates.push(`${baseRelPath}${extension}`);
      candidates.push(normalizePath(join(baseRelPath, `index${extension}`)));
    }
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await existsAsync(resolve(params.repoRoot, candidate))) {
      existing.push(normalizePath(candidate));
    }
  }

  return Array.from(new Set(existing)).sort();
}

export async function resolveImportCandidatePaths(
  params: ResolveImportCandidatePathsParams,
): Promise<string[]> {
  const relativeCandidates = await resolveRelativeImportCandidatePaths(params);
  if (relativeCandidates.length > 0) {
    return relativeCandidates;
  }

  for (const adapter of getImportResolutionAdapters()) {
    if (!adapter.supports(params.language)) {
      continue;
    }

    const candidates = await adapter.resolveImportCandidatePaths(params);
    if (candidates.length > 0) {
      return Array.from(
        new Set(candidates.map((candidate) => normalizePath(candidate))),
      ).sort();
    }
  }

  return [];
}
