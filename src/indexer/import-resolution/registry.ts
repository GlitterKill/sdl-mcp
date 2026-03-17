import { dirname, join, resolve } from "path";

import { existsAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";

import { CIncludeImportResolutionAdapter } from "./c-include-adapter.js";
import { GoImportResolutionAdapter } from "./go-adapter.js";
import { CSharpImportResolutionAdapter } from "./csharp-adapter.js";
import { JavaKotlinImportResolutionAdapter } from "./java-kotlin-adapter.js";
import { PhpImportResolutionAdapter } from "./php-adapter.js";
import { PythonImportResolutionAdapter } from "./python-adapter.js";
import { RustImportResolutionAdapter } from "./rust-adapter.js";
import { ShellImportResolutionAdapter } from "./shell-adapter.js";
import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

const IMPORT_RESOLUTION_ADAPTERS: ImportResolutionAdapter[] = [
  new CIncludeImportResolutionAdapter(),
  new GoImportResolutionAdapter(),
  new CSharpImportResolutionAdapter(),
  new JavaKotlinImportResolutionAdapter(),
  new RustImportResolutionAdapter(),
  new PythonImportResolutionAdapter(),
  new PhpImportResolutionAdapter(),
  new ShellImportResolutionAdapter(),
];

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

  for (const adapter of IMPORT_RESOLUTION_ADAPTERS) {
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
