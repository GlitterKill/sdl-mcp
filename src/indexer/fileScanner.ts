import { isAbsolute, resolve } from "path";
import { hash } from "crypto";

import { RepoConfig } from "../config/types.js";
import { normalizePath } from "../util/paths.js";
import {
  readFileAsync,
  readFileBufferAsync,
  statAsync,
} from "../util/asyncFs.js";
import { logger } from "../util/logger.js";

import { walkRepositoryFiles } from "./fileWalker.js";
import {
  getLanguageIdForExtension,
  getSupportedExtensions,
} from "./adapter/registry.js";
import {
  ensureConfiguredLanguagePackAdapters,
  resolveConfiguredLanguagePacks,
} from "./language-packs.js";

export interface FileMetadata {
  path: string;
  size: number;
  mtime: number;
  contentHash?: string;
}

export interface ScannedFileMetadata extends FileMetadata {
  contentHash: string;
}

const EXACT_CONFIG_LANGUAGE_EXTENSIONS = new Map<string, readonly string[]>([
  ["ts", [".ts"]],
  ["tsx", [".tsx"]],
  ["js", [".js"]],
  ["jsx", [".jsx"]],
]);

const CANONICAL_LANGUAGE_IDS_BY_CONFIG = new Map<string, string>([
  ["py", "python"],
  ["cs", "csharp"],
  ["rs", "rust"],
  ["kt", "kotlin"],
  ["sh", "shell"],
  ["ps1", "powershell"],
  ["psm1", "powershell"],
  ["psd1", "powershell"],
  ["rb", "ruby"],
  ["rake", "ruby"],
  ["groovy", "groovy"],
  ["gradle", "groovy"],
  ["pl", "perl"],
  ["pm", "perl"],
  ["t", "perl"],
  ["r", "r"],
  ["ex", "elixir"],
  ["exs", "elixir"],
  ["fs", "fsharp"],
  ["fsi", "fsharp"],
  ["fsx", "fsharp"],
  ["fsharp", "fsharp"],
  ["f#", "fsharp"],
  ["f90", "fortran"],
  ["f95", "fortran"],
  ["f03", "fortran"],
  ["f08", "fortran"],
  ["f", "fortran"],
  ["for", "fortran"],
  ["f77", "fortran"],
  ["hs", "haskell"],
  ["lhs", "haskell"],
  ["jl", "julia"],
  ["zig", "zig"],
  ["gleam", "gleam"],
]);

const PROVIDER_SCAN_COMPANION_EXTENSIONS = new Map<string, readonly string[]>([
  // scip-clang emits headers and generated include fragments beside C++ source
  // documents. Keep them in scan scope so provider-first coverage can accept
  // those facts even though fallback parsing may still route some extensions
  // through the C adapter or a skipped-file row.
  ["cpp", [".c", ".h", ".def", ".inc"]],
  ["python", [".pyi"]],
]);

export function getLanguageExtensions(languages: string[]): string[] {
  const extensions = new Set<string>();
  const supportedExtensions = getSupportedExtensions();

  for (const language of languages) {
    const normalizedLanguage = language.toLowerCase();
    const exactExtensions =
      EXACT_CONFIG_LANGUAGE_EXTENSIONS.get(normalizedLanguage);
    if (exactExtensions) {
      for (const extension of exactExtensions) extensions.add(extension);
      continue;
    }

    const canonicalLanguageId =
      CANONICAL_LANGUAGE_IDS_BY_CONFIG.get(normalizedLanguage) ??
      normalizedLanguage;
    let matchedAdapterExtension = false;
    for (const extension of supportedExtensions) {
      if (getLanguageIdForExtension(extension) !== canonicalLanguageId) {
        continue;
      }
      extensions.add(extension);
      matchedAdapterExtension = true;
    }

    if (!matchedAdapterExtension) {
      extensions.add(`.${normalizedLanguage}`);
    }

    for (const pack of resolveConfiguredLanguagePacks([normalizedLanguage])) {
      for (const extension of pack.extensions) extensions.add(extension);
    }

    const companionExtensions =
      PROVIDER_SCAN_COMPANION_EXTENSIONS.get(canonicalLanguageId);
    if (companionExtensions) {
      for (const extension of companionExtensions) extensions.add(extension);
    }
  }

  return [...extensions].sort();
}

async function resolveWorkspaces(
  repoPath: string,
  config: RepoConfig,
): Promise<string[]> {
  if (config.workspaceGlobs && config.workspaceGlobs.length > 0) {
    return config.workspaceGlobs;
  }

  const packageJsonPath = config.packageJsonPath
    ? resolve(repoPath, config.packageJsonPath)
    : resolve(repoPath, "package.json");

  try {
    const packageJsonContent = await readFileAsync(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent);
    const workspacesField = packageJson.workspaces;

    if (!workspacesField) {
      return [];
    }

    const workspaces: string[] = [];

    if (Array.isArray(workspacesField)) {
      workspaces.push(...workspacesField);
    } else if (
      typeof workspacesField === "object" &&
      workspacesField.packages
    ) {
      const packages = workspacesField.packages;
      if (Array.isArray(packages)) {
        workspaces.push(...packages);
      }
    }

    return workspaces;
  } catch (err) {
    logger.debug("Failed to detect workspaces from package.json", {
      packageJsonPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function discoverFiles(
  repoPath: string,
  config: RepoConfig,
): Promise<string[]> {
  const explicitFileList = await readSourceFileList(repoPath, config);
  if (explicitFileList) {
    return explicitFileList;
  }

  const extensions = getLanguageExtensions(config.languages);
  const patterns = extensions.map((ext) => `**/*${ext}`);

  const workspaces = await resolveWorkspaces(repoPath, config);
  const ignorePatterns = [...config.ignore];

  for (const workspace of workspaces) {
    const workspaceNodeModules = `${workspace}/**/node_modules/**`;
    const workspaceDist = `${workspace}/**/dist/**`;
    const workspaceBuild = `${workspace}/**/build/**`;
    const workspaceTarget = `${workspace}/**/target/**`;
    ignorePatterns.push(
      workspaceNodeModules,
      workspaceDist,
      workspaceBuild,
      workspaceTarget,
    );
  }

  return walkRepositoryFiles(repoPath, {
    patterns,
    ignorePatterns,
  });
}

async function readSourceFileList(
  repoPath: string,
  config: RepoConfig,
): Promise<string[] | undefined> {
  if (!config.sourceFileListPath) {
    return undefined;
  }

  const listPath = isAbsolute(config.sourceFileListPath)
    ? config.sourceFileListPath
    : resolve(repoPath, config.sourceFileListPath);
  const content = await readFileAsync(listPath, "utf-8");
  const files = new Set<string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = normalizePath(line);
    if (
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      isAbsolute(normalized)
    ) {
      logger.warn("Ignoring unsafe source file list entry", {
        sourceFileListPath: listPath,
        entry: line,
      });
      continue;
    }
    files.add(normalized);
  }

  logger.info("Using explicit source file list for repository scan", {
    sourceFileListPath: listPath,
    files: files.size,
  });
  return [...files].sort((a, b) => a.localeCompare(b));
}

async function filterFilesBySize(
  files: string[],
  repoPath: string,
  maxBytes: number,
): Promise<ScannedFileMetadata[]> {
  const metadata: ScannedFileMetadata[] = [];

  const stats = await Promise.allSettled(
    files.map((file) => statAsync(resolve(repoPath, file))),
  );
  const candidates: Array<{
    file: string;
    size: number;
    mtime: number;
  }> = [];

  for (let i = 0; i < files.length; i++) {
    const result = stats[i];

    if (result.status === "fulfilled" && result.value.size <= maxBytes) {
      candidates.push({
        file: files[i],
        size: result.value.size,
        mtime: result.value.mtimeMs,
      });
    }
  }

  const hashed = await Promise.allSettled(
    candidates.map(async (candidate) => {
      const content = await readFileBufferAsync(
        resolve(repoPath, candidate.file),
      );
      return {
        path: normalizePath(candidate.file),
        size: candidate.size,
        mtime: candidate.mtime,
        contentHash: hash("sha256", content, "hex"),
      };
    }),
  );

  for (const result of hashed) {
    if (result.status === "fulfilled") metadata.push(result.value);
  }

  return metadata;
}

const TS_SUPERSEDES_JS: Record<string, string> = {
  ".js": ".ts",
  ".jsx": ".tsx",
};

function deduplicateCompiledJs<TFile extends FileMetadata>(
  files: TFile[],
): TFile[] {
  const pathSet = new Set(files.map((f) => f.path));
  return files.filter((f) => {
    const ext = f.path.slice(f.path.lastIndexOf("."));
    const tsExt = TS_SUPERSEDES_JS[ext];
    if (!tsExt) return true;
    const tsCounterpart = f.path.slice(0, f.path.length - ext.length) + tsExt;
    return !pathSet.has(tsCounterpart);
  });
}

/**
 * Scans a repository for source files matching configured languages.
 * Filters by file extensions and size limits, resolves workspaces automatically.
 * When both a TS and JS file exist at the same path, the JS file is excluded
 * to avoid indexing compiled output alongside source.
 *
 * @param repoPath - Absolute path to repository root
 * @param config - Repository configuration with languages, ignore patterns, and limits
 * @returns Array of file metadata sorted by path
 */
export async function scanRepository(
  repoPath: string,
  config: RepoConfig,
): Promise<ScannedFileMetadata[]> {
  await ensureConfiguredLanguagePackAdapters(config.languages);
  const discoveredFiles = await discoverFiles(repoPath, config);
  const metadata = await filterFilesBySize(
    discoveredFiles,
    repoPath,
    config.maxFileBytes,
  );

  const deduplicated = deduplicateCompiledJs(metadata);

  return deduplicated.sort((a, b) => a.path.localeCompare(b.path));
}

export { walkRepositoryFiles } from "./fileWalker.js";
