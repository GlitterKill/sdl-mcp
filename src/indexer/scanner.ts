import type { RepoConfig } from "../config/types.js";
import { deleteFileTransaction, getFilesByRepo } from "../db/queries.js";
import type { FileRow } from "../db/schema.js";

import { scanRepository, type FileMetadata } from "./fileScanner.js";
import type { IndexProgress } from "./indexer.js";

export interface ScanRepoForIndexResult {
  files: FileMetadata[];
  existingByPath: Map<string, FileRow>;
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

  const existingFiles = getFilesByRepo(repoId);
  const existingByPath = new Map(existingFiles.map((file) => [file.rel_path, file]));

  const scannedPaths = new Set(files.map((file) => file.path));
  let removedFiles = 0;

  for (const file of existingFiles) {
    if (!scannedPaths.has(file.rel_path)) {
      deleteFileTransaction(file.file_id);
      removedFiles++;
    }
  }

  return { files, existingByPath, removedFiles };
}

