import os from "os";

export { processFile, type ProcessFileParams } from "./parser/process-file.js";
export { processFileFromRustResult } from "./parser/rust-process-file.js";

export interface ResolveParserWorkerPoolSizeParams {
  configuredWorkerPoolSize?: number;
  concurrency: number;
  fileCount: number;
  cpuCount?: number;
}

export function resolveParserWorkerPoolSize(
  params: ResolveParserWorkerPoolSizeParams,
): number {
  const {
    configuredWorkerPoolSize,
    concurrency,
    fileCount,
    cpuCount = os.cpus().length,
  } = params;

  void concurrency;
  const boundedFileCount = Math.max(1, fileCount);
  const defaultPoolSize = Math.max(1, cpuCount - 1);
  const requestedPoolSize = configuredWorkerPoolSize ?? defaultPoolSize;

  return Math.max(
    1,
    Math.min(requestedPoolSize, boundedFileCount),
  );
}
