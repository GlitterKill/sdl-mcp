import { opendir } from "node:fs/promises";
import { resolve } from "path";

import { globToSafeRegex } from "../util/safeRegex.js";
import { logger } from "../util/logger.js";
import { normalizePath } from "../util/paths.js";

export interface DirectoryEntryLike {
  name: string;
  isDirectory(): boolean;
  isFile?(): boolean;
  isSymbolicLink?(): boolean;
}

export interface DirectoryHandleLike {
  read(): Promise<DirectoryEntryLike | null>;
  close(): Promise<void>;
}

export interface WalkRepositoryFilesOptions {
  patterns: string[];
  ignorePatterns?: string[];
  openDirectory?: (directoryPath: string) => Promise<DirectoryHandleLike>;
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => globToSafeRegex(normalizePath(pattern)));
}

function matchesAnyPattern(path: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

function shouldIgnorePath(
  path: string,
  ignorePatterns: RegExp[],
  isDirectory: boolean,
): boolean {
  if (ignorePatterns.length === 0) {
    return false;
  }

  if (matchesAnyPattern(path, ignorePatterns)) {
    return true;
  }

  return isDirectory && matchesAnyPattern(`${path}/`, ignorePatterns);
}

function isFileLikeEntry(entry: DirectoryEntryLike): boolean {
  if (typeof entry.isFile === "function") {
    return entry.isFile();
  }
  // When isFile is not available, treat non-directory entries as files.
  // Symlinks to directories are excluded by isDirectory() returning false for
  // real fs.Dirent, but we do not attempt to stat-resolve them here.
  return !entry.isDirectory();
}

/**
 * Walk a repository tree with explicit directory-handle lifecycle control.
 * This avoids relying on runtime-specific async iterator cleanup behavior.
 */
export async function walkRepositoryFiles(
  repoPath: string,
  options: WalkRepositoryFilesOptions,
): Promise<string[]> {
  const includePatterns = compilePatterns(options.patterns);
  const ignorePatterns = compilePatterns(options.ignorePatterns ?? []);
  const openDirectory = options.openDirectory ?? opendir;
  const files: string[] = [];
  const directoriesToVisit = [""];

  while (directoriesToVisit.length > 0) {
    const relativeDirectory = directoriesToVisit.pop();
    if (relativeDirectory === undefined) {
      continue;
    }

    const absoluteDirectory = relativeDirectory
      ? resolve(repoPath, relativeDirectory)
      : repoPath;
    const directory = await openDirectory(absoluteDirectory);

    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) {
          break;
        }

        const relativePath = normalizePath(
          relativeDirectory
            ? `${relativeDirectory}/${entry.name}`
            : entry.name,
        );

        if (entry.isDirectory()) {
          if (shouldIgnorePath(relativePath, ignorePatterns, true)) {
            continue;
          }
          directoriesToVisit.push(relativePath);
          continue;
        }

        if (!isFileLikeEntry(entry)) {
          continue;
        }
        if (shouldIgnorePath(relativePath, ignorePatterns, false)) {
          continue;
        }
        if (!matchesAnyPattern(relativePath, includePatterns)) {
          continue;
        }

        files.push(relativePath);
      }
    } finally {
      try {
        await directory.close();
      } catch (closeErr) {
        const msg = closeErr instanceof Error ? closeErr.message : String(closeErr);
        if (!msg.includes("closed")) {
          logger.warn("Failed closing directory handle after repository walk", {
            directoryPath: absoluteDirectory,
            error: msg,
          });
        }
      }
    }
  }

  return files;
}
