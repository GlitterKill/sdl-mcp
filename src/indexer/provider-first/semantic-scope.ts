import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { logger } from "../../util/logger.js";
import { normalizePath } from "../../util/paths.js";
import { walkRepositoryFiles } from "../fileScanner.js";

const PROVIDER_FIRST_CPP_SEMANTIC_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".def",
  ".inc",
]);

export async function resolveProviderFirstSemanticEligiblePaths(params: {
  repoRoot: string;
  scannedPaths: readonly string[];
  providerPaths: Iterable<string>;
}): Promise<Set<string>> {
  const scannedPathSet = new Set(
    params.scannedPaths.map((path) => normalizePath(path)),
  );
  const eligible = new Set<string>();

  for (const relPath of params.providerPaths) {
    const normalized = normalizePath(relPath);
    if (scannedPathSet.has(normalized)) {
      eligible.add(normalized);
    }
  }

  if (!params.scannedPaths.some(isCppSemanticScanPath)) {
    return eligible;
  }

  const compileDatabases = await discoverProviderFirstCompileDatabases(
    params.repoRoot,
  );
  for (const databaseRelPath of compileDatabases) {
    const databasePath = resolve(params.repoRoot, databaseRelPath);
    let entries: unknown;
    try {
      entries = JSON.parse(await readFile(databasePath, "utf-8"));
    } catch (err) {
      logger.debug("provider-first compile database skipped", {
        path: databaseRelPath,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      const relPath = compileCommandEntryRepoRelativePath({
        repoRoot: params.repoRoot,
        databasePath,
        entry,
      });
      if (relPath && scannedPathSet.has(relPath)) {
        eligible.add(relPath);
      }
    }
  }

  return eligible;
}

async function discoverProviderFirstCompileDatabases(
  repoRoot: string,
): Promise<string[]> {
  const files = await walkRepositoryFiles(repoRoot, {
    patterns: ["compile_commands.json", "**/compile_commands.json"],
    ignorePatterns: [
      ".git/**",
      "**/.git/**",
      "node_modules/**",
      "**/node_modules/**",
      "target/**",
      "**/target/**",
      "dist/**",
      "**/dist/**",
      "vendor/**",
      "**/vendor/**",
    ],
  });
  return files
    .map((file) => normalizePath(file))
    .filter(isProviderFirstCompileDatabaseCandidate)
    .sort((left, right) => left.localeCompare(right));
}

function isProviderFirstCompileDatabaseCandidate(relPath: string): boolean {
  const normalized = normalizePath(relPath);
  if (normalized === "compile_commands.json") return true;
  const parts = normalized.split("/");
  parts.pop();
  return parts.some(isBuildOutputComponent);
}

function isBuildOutputComponent(component: string): boolean {
  return (
    component === "build" ||
    component.startsWith("build-") ||
    component.startsWith("build_") ||
    component.startsWith("cmake-build-") ||
    component === "out" ||
    component.startsWith("out-") ||
    component.startsWith("out_")
  );
}

function compileCommandEntryRepoRelativePath(params: {
  repoRoot: string;
  databasePath: string;
  entry: unknown;
}): string | null {
  if (!params.entry || typeof params.entry !== "object") return null;
  const entry = params.entry as Record<string, unknown>;
  const file = typeof entry.file === "string" ? entry.file : undefined;
  if (!file || !isCppSemanticScanPath(file)) return null;
  const directory =
    typeof entry.directory === "string" ? entry.directory : undefined;
  const absolutePath = compileCommandAbsolutePath({
    databasePath: params.databasePath,
    directory,
    file,
  });
  const relPath = repoRelativePathFromPossiblyForeignPath(
    params.repoRoot,
    absolutePath,
  );
  return relPath && isCppSemanticScanPath(relPath) ? relPath : null;
}

function compileCommandAbsolutePath(params: {
  databasePath: string;
  directory?: string;
  file: string;
}): string {
  const normalizedFile = normalizePath(params.file);
  if (compileCommandPathIsAbsolute(normalizedFile)) {
    return normalizedFile;
  }
  const directory = params.directory
    ? normalizePath(params.directory)
    : normalizePath(resolve(params.databasePath, ".."));
  if (compileCommandPathIsAbsolute(directory) && directory.startsWith("/")) {
    return normalizePath(`${directory}/${normalizedFile}`);
  }
  return normalizePath(resolve(directory, normalizedFile));
}

function repoRelativePathFromPossiblyForeignPath(
  repoRoot: string,
  absolutePath: string,
): string | null {
  const normalizedRoot = normalizePotentialWslMountPath(
    normalizePath(repoRoot),
  );
  const normalizedPath = normalizePotentialWslMountPath(
    normalizePath(absolutePath),
  );
  const windowsComparison =
    /^[A-Za-z]:\//.test(normalizedRoot) || /^[A-Za-z]:\//.test(normalizedPath);
  const rootKey = windowsComparison
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  const pathKey = windowsComparison
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  const rootPrefix = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;

  if (pathKey === rootKey) return null;
  if (!pathKey.startsWith(rootPrefix)) return null;
  return normalizePath(normalizedPath.slice(rootPrefix.length));
}

function normalizePotentialWslMountPath(path: string): string {
  const match = path.match(/^\/mnt\/([A-Za-z])\/(.+)$/);
  if (!match) return path;
  return `${match[1].toUpperCase()}:/${match[2]}`;
}

function compileCommandPathIsAbsolute(path: string): boolean {
  return isAbsolute(path) || path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

export function isCppSemanticScanPath(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  const index = normalized.lastIndexOf(".");
  if (index < 0) return false;
  return PROVIDER_FIRST_CPP_SEMANTIC_EXTENSIONS.has(normalized.slice(index));
}

export function providerPathCanBeIgnoredOutsideScanScope(
  relPath: string,
): boolean {
  const normalized = normalizePath(relPath);
  if (normalized === "" || normalized === "." || normalized === "..")
    return false;
  if (normalized.startsWith("../") || normalized.includes("/../")) return false;
  if (normalized.startsWith("/") || normalized.startsWith("//")) return false;
  return !/^[A-Za-z]:\//.test(normalized);
}
