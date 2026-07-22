import {
  isScannedFileChanged,
  type ScanRepoForIndexResult,
} from "../scanner.js";

// Keep provider-first scan narrowing out of the indexer orchestrator.
export function filterProviderFirstFallbackScan(
  scan: ScanRepoForIndexResult,
  fallbackPaths: ReadonlySet<string>,
): ScanRepoForIndexResult {
  const existingByPath: ScanRepoForIndexResult["existingByPath"] = new Map();
  for (const [relPath, file] of scan.existingByPath) {
    if (fallbackPaths.has(relPath)) {
      existingByPath.set(relPath, file);
    }
  }

  return {
    ...scan,
    files: scan.files.filter((file) => fallbackPaths.has(file.path)),
    existingByPath,
    removedFileIds: [],
    allFilesUnchanged: false,
  };
}

export function providerFirstIncrementalChangedFiles(
  scan: ScanRepoForIndexResult,
): ScanRepoForIndexResult["files"] {
  return scan.files.filter((file) =>
    isScannedFileChanged(file, scan.existingByPath.get(file.path)),
  );
}

export function filterProviderFirstIncrementalScan(
  scan: ScanRepoForIndexResult,
  changedFiles: ScanRepoForIndexResult["files"],
): ScanRepoForIndexResult {
  const changedPaths = new Set(changedFiles.map((file) => file.path));
  const existingByPath: ScanRepoForIndexResult["existingByPath"] = new Map();
  for (const [relPath, file] of scan.existingByPath) {
    if (changedPaths.has(relPath)) {
      existingByPath.set(relPath, file);
    }
  }

  return {
    ...scan,
    files: changedFiles,
    existingByPath,
    allFilesUnchanged:
      changedFiles.length === 0 && scan.removedFileIds.length === 0,
  };
}
