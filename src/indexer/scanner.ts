import type { RepoConfig } from "../config/types.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";

import { scanRepository, type FileMetadata } from "./fileScanner.js";
import type { IndexProgress } from "./indexer.js";

export interface ScanRepoForIndexResult {
  files: FileMetadata[];
  existingByPath: Map<string, ladybugDb.FileRow>;
  removedFiles: number;
  removedFileIds: string[];
  /** True when incremental mode can short-circuit: no removed files and all scanned file mtimes match DB. */
  allFilesUnchanged: boolean;
}

export async function scanRepoForIndex(params: {
  repoId: string;
  repoRoot: string;
  config: RepoConfig;
  onProgress?: (progress: IndexProgress) => void;
}): Promise<ScanRepoForIndexResult> {
  const { repoId, repoRoot, config, onProgress } = params;

  onProgress?.({ stage: "scanning", current: 0, total: 0 });
  const files = await scanRepository(repoRoot, config);

  const conn = await getLadybugConn();
  const existingFiles = await ladybugDb.getFilesByRepo(conn, repoId);

  // FileMetadata.path and FileRow.relPath are both forward-slash normalized relative paths;
  // they are used interchangeably as map keys throughout this module.
  const existingByPath = new Map(
    existingFiles.map((file) => [file.relPath, file]),
  );

  const scannedPaths = new Set(files.map((file) => file.path));
  const removedFileIds: string[] = [];
  let removedFiles = 0;

  for (const file of existingFiles) {
    if (!scannedPaths.has(file.relPath)) {
      removedFileIds.push(file.fileId);
      removedFiles++;
    }
  }

  if (removedFileIds.length > 0) {
    await withWriteConn(async (wConn) => {
      await ladybugDb.deleteFilesByIds(wConn, removedFileIds);
    });
  }

  // Check if all files have unchanged mtimes (enables fast early-exit in indexer)
  const allFilesUnchanged =
    removedFiles === 0 &&
    files.every((f) => {
      const existing = existingByPath.get(f.path);
      if (!existing?.lastIndexedAt) return false;
      const lastIndexedMs = new Date(existing.lastIndexedAt).getTime();
      return f.mtime <= lastIndexedMs;
    });

  return {
    files,
    existingByPath,
    removedFiles,
    removedFileIds,
    allFilesUnchanged,
  };
}
