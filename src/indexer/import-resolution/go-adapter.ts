import fastGlob from "fast-glob";
import { dirname, join, resolve } from "path";

import { existsAsync, readFileAsync } from "../../util/asyncFs.js";
import { logger } from "../../util/logger.js";
import { normalizePath } from "../../util/paths.js";

import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

async function findNearestGoMod(
  repoRoot: string,
  importerRelPath: string,
): Promise<string | null> {
  let currentDir = resolve(repoRoot, dirname(importerRelPath));
  const repoRootAbs = resolve(repoRoot);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(currentDir, "go.mod");
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

async function readGoModuleName(goModPath: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFileAsync(goModPath, "utf-8");
  } catch (error) {
    logger.warn(
      `[go-adapter] Failed to read ${goModPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  const match = content.match(/^\s*module\s+([^\s]+)\s*$/m);
  return match?.[1] ?? null;
}

export class GoImportResolutionAdapter implements ImportResolutionAdapter {
  readonly id = "go";

  supports(language: string): boolean {
    return language === "go";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    const goModPath = await findNearestGoMod(
      params.repoRoot,
      params.importerRelPath,
    );
    if (!goModPath) {
      return [];
    }

    const moduleName = await readGoModuleName(goModPath);
    if (!moduleName) {
      return [];
    }

    if (
      params.specifier !== moduleName &&
      !params.specifier.startsWith(`${moduleName}/`)
    ) {
      return [];
    }

    const packageRelPath = normalizePath(
      params.specifier.slice(moduleName.length).replace(/^\/+/, ""),
    );
    const packageDir = packageRelPath || ".";
    const patterns = params.extensions.map(
      (extension) => `${packageDir}/**/*${extension}`,
    );

    const matches = await fastGlob(patterns, {
      cwd: params.repoRoot,
      onlyFiles: true,
      unique: true,
    });

    return matches.map((path) => normalizePath(path)).sort();
  }
}
