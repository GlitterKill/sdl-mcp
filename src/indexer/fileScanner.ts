import fastGlob from "fast-glob";
import { resolve } from "path";
import { RepoConfig } from "../config/types.js";
import { normalizePath } from "../util/paths.js";
import { readFileAsync, statAsync } from "../util/asyncFs.js";

export interface FileMetadata {
  path: string;
  size: number;
  mtime: number;
}

function getLanguageExtensions(languages: string[]): string[] {
  return languages.map((lang) => `.${lang}`);
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
  } catch {
    return [];
  }
}

async function discoverFiles(
  repoPath: string,
  config: RepoConfig,
): Promise<string[]> {
  const extensions = getLanguageExtensions(config.languages);
  const patterns: string[] = [];

  for (const ext of extensions) {
    patterns.push(`**/*${ext}`);
  }

  const workspaces = await resolveWorkspaces(repoPath, config);
  const ignorePatterns = [...config.ignore];

  for (const workspace of workspaces) {
    const workspaceNodeModules = `${workspace}/**/node_modules/**`;
    const workspaceDist = `${workspace}/**/dist/**`;
    const workspaceBuild = `${workspace}/**/build/**`;
    ignorePatterns.push(workspaceNodeModules, workspaceDist, workspaceBuild);
  }

  const files = await fastGlob(patterns, {
    cwd: repoPath,
    ignore: ignorePatterns,
    absolute: false,
    onlyFiles: true,
    unique: true,
  });

  return files;
}

async function filterFilesBySize(
  files: string[],
  repoPath: string,
  maxBytes: number,
): Promise<FileMetadata[]> {
  const metadata: FileMetadata[] = [];

  const stats = await Promise.allSettled(
    files.map((file) => statAsync(resolve(repoPath, file))),
  );

  for (let i = 0; i < files.length; i++) {
    const result = stats[i];

    if (result.status === "fulfilled" && result.value.size <= maxBytes) {
      metadata.push({
        path: normalizePath(files[i]),
        size: result.value.size,
        mtime: result.value.mtimeMs,
      });
    }
  }

  return metadata;
}

/**
 * Scans a repository for source files matching configured languages.
 * Filters by file extensions and size limits, resolves workspaces automatically.
 *
 * @param repoPath - Absolute path to repository root
 * @param config - Repository configuration with languages, ignore patterns, and limits
 * @returns Array of file metadata sorted by path
 */
export async function scanRepository(
  repoPath: string,
  config: RepoConfig,
): Promise<FileMetadata[]> {
  const discoveredFiles = await discoverFiles(repoPath, config);
  const metadata = await filterFilesBySize(
    discoveredFiles,
    repoPath,
    config.maxFileBytes,
  );

  return metadata.sort((a, b) => a.path.localeCompare(b.path));
}
