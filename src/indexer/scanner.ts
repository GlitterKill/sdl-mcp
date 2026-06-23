import type { RepoConfig } from "../config/types.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";

import { scanRepository, type ScannedFileMetadata } from "./fileScanner.js";
import type { IndexProgress } from "./indexer.js";

export interface ScanRepoForIndexResult {
  files: ScannedFileMetadata[];
  existingByPath: Map<string, ladybugDb.FileRow>;
  removedFiles: number;
  removedFileIds: string[];
  /** True when incremental mode can short-circuit: no removed files and all scanned files match DB state. */
  allFilesUnchanged: boolean;
}

export function isScannedFileChanged(
  file: ScannedFileMetadata,
  existing?: ladybugDb.FileRow,
): boolean {
  if (!existing?.lastIndexedAt) return true;
  if (existing.contentHash && existing.contentHash === file.contentHash) {
    return false;
  }
  if (existing.contentHash && existing.contentHash !== file.contentHash) {
    return true;
  }

  const lastIndexedMs = new Date(existing.lastIndexedAt).getTime();
  return !Number.isFinite(lastIndexedMs) || file.mtime > lastIndexedMs;
}

export async function scanRepoForIndex(params: {
  repoId: string;
  repoRoot: string;
  config: RepoConfig;
  onProgress?: (progress: IndexProgress) => void;
  deleteRemovedFiles?: boolean;
}): Promise<ScanRepoForIndexResult> {
  const {
    repoId,
    repoRoot,
    config,
    onProgress,
    deleteRemovedFiles = true,
  } = params;

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

  if (deleteRemovedFiles && removedFileIds.length > 0) {
    await withWriteConn(async (wConn) => {
      await ladybugDb.deleteFilesByIds(wConn, removedFileIds);
    });
  }

  // Prefer content hashes; mtime remains a fallback for old file rows without hashes.
  const allFilesUnchanged =
    removedFiles === 0 &&
    files.every((file) =>
      !isScannedFileChanged(file, existingByPath.get(file.path)),
    );

  return {
    files,
    existingByPath,
    removedFiles,
    removedFileIds,
    allFilesUnchanged,
  };
}
