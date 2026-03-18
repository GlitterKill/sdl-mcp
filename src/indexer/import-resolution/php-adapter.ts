import { dirname, join, resolve } from "path";

import { existsAsync, readFileAsync } from "../../util/asyncFs.js";
import { normalizePath } from "../../util/paths.js";

import type {
  ImportResolutionAdapter,
  ResolveImportCandidatePathsParams,
} from "./types.js";

type Psr4Map = Record<string, string | string[]>;

async function findNearestComposerJson(
  repoRoot: string,
  importerRelPath: string,
): Promise<string | null> {
  let currentDir = resolve(repoRoot, dirname(importerRelPath));
  const repoRootAbs = resolve(repoRoot);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(currentDir, "composer.json");
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

async function readPsr4Mappings(
  composerJsonPath: string,
): Promise<Array<{ prefix: string; baseDir: string }>> {
  let content: string;
  try {
    content = await readFileAsync(composerJsonPath, "utf-8");
  } catch (error) {
    console.warn(
      `[php-adapter] Failed to read ${composerJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  let parsed: { autoload?: { "psr-4"?: Psr4Map } };
  try {
    parsed = JSON.parse(content) as { autoload?: { "psr-4"?: Psr4Map } };
  } catch (error) {
    console.warn(
      `[php-adapter] Failed to parse ${composerJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  const mappings = parsed.autoload?.["psr-4"] ?? {};
  const results: Array<{ prefix: string; baseDir: string }> = [];

  for (const [prefix, rawBaseDir] of Object.entries(mappings)) {
    const baseDirs = Array.isArray(rawBaseDir) ? rawBaseDir : [rawBaseDir];
    for (const baseDir of baseDirs) {
      results.push({
        prefix,
        baseDir: normalizePath(baseDir),
      });
    }
  }

  return results;
}

export class PhpImportResolutionAdapter implements ImportResolutionAdapter {
  readonly id = "php";

  supports(language: string): boolean {
    return language === "php";
  }

  async resolveImportCandidatePaths(
    params: ResolveImportCandidatePathsParams,
  ): Promise<string[]> {
    const composerJsonPath = await findNearestComposerJson(
      params.repoRoot,
      params.importerRelPath,
    );
    if (!composerJsonPath) {
      return [];
    }

    const specifier = params.specifier.replace(/^\\+/, "");
    if (!specifier.includes("\\")) {
      return [];
    }

    const mappings = await readPsr4Mappings(composerJsonPath);
    const candidates = new Set<string>();

    for (const mapping of mappings) {
      if (!specifier.startsWith(mapping.prefix)) {
        continue;
      }

      const suffix = specifier
        .slice(mapping.prefix.length)
        .replace(/\\/g, "/");

      for (const extension of params.extensions) {
        const relPath = normalizePath(
          join(mapping.baseDir, `${suffix}${extension}`),
        );
        if (await existsAsync(join(params.repoRoot, relPath))) {
          candidates.add(relPath);
        }
      }
    }

    return Array.from(candidates).sort();
  }
}
