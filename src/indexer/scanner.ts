import type { RepoConfig } from "../config/types.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";

import { scanRepository, type FileMetadata } from "./fileScanner.js";
import type { IndexProgress } from "./indexer.js";

export interface ScanRepoForIndexResult {
  files: FileMetadata[];
  existingByPath: Map<string, ladybugDb.FileRow>;
  removedFiles: number;
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
  const existingByPath = new Map(existingFiles.map((file) => [file.relPath, file]));

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

  return { files, existingByPath, removedFiles };
}
