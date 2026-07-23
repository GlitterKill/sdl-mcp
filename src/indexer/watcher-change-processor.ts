import { resolve } from "node:path";

import {
  GraphIntegrityBaselineError,
  SafeRebuildRequiredError,
  StorageIntegrityError,
} from "../domain/errors.js";
import { withIndexingGate } from "../mcp/indexing-gate.js";
import { ConcurrencyQueueTimeoutError } from "../util/concurrency.js";
import { logger } from "../util/logger.js";
import { normalizePath } from "../util/paths.js";

import { ProviderFirstIncrementalReplacementError } from "./indexer-pass1-policy.js";
import { GraphIntegrityVerificationError } from "./provider-first/persisted-graph-integrity.js";

export type IndexRepoFn = (
  repoId: string,
  mode: "full" | "incremental",
) => Promise<unknown>;

export type WatcherReindexFailureDisposition =
  | "permanent"
  | "transient"
  | "unknown";

export class WatcherReadPoolUnhealthyError extends Error {}

function boundedCauseChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && chain.length < 8 && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current =
      current instanceof Error
        ? current.cause
        : typeof current === "object" && current !== null && "cause" in current
          ? (current as { cause?: unknown }).cause
          : undefined;
  }
  return chain;
}

export function classifyWatcherReindexFailure(
  error: unknown,
): WatcherReindexFailureDisposition {
  for (const cause of boundedCauseChain(error)) {
    if (
      cause instanceof StorageIntegrityError ||
      cause instanceof GraphIntegrityBaselineError ||
      cause instanceof GraphIntegrityVerificationError ||
      cause instanceof ProviderFirstIncrementalReplacementError ||
      cause instanceof SafeRebuildRequiredError
    ) {
      return "permanent";
    }
    if (
      cause instanceof WatcherReadPoolUnhealthyError ||
      cause instanceof ConcurrencyQueueTimeoutError
    ) {
      return "transient";
    }
    if (
      cause instanceof Error &&
      cause.message.includes("Cannot start a new write transaction in the system")
    ) {
      return "transient";
    }
    const code =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof (cause as { code?: unknown }).code === "string"
        ? (cause as { code: string }).code
        : undefined;
    if (
      code === "EAGAIN" ||
      code === "EBUSY" ||
      code === "EMFILE" ||
      code === "ENFILE" ||
      code === "ETIMEDOUT"
    ) {
      return "transient";
    }
  }
  return "unknown";
}

function pathsIdentifySameWatchedFile(
  errorPath: string,
  watchedPath: string,
  repoRoot?: string,
): boolean {
  const normalizedError = normalizePath(errorPath);
  const normalizedWatched = normalizePath(watchedPath);
  const normalizedResolvedWatched = repoRoot
    ? normalizePath(resolve(repoRoot, watchedPath))
    : undefined;
  const comparableError =
    process.platform === "win32"
      ? normalizedError.toLowerCase()
      : normalizedError;
  const comparableWatched =
    process.platform === "win32"
      ? normalizedWatched.toLowerCase()
      : normalizedWatched;
  const comparableResolvedWatched =
    process.platform === "win32"
      ? normalizedResolvedWatched?.toLowerCase()
      : normalizedResolvedWatched;
  if (comparableError === comparableWatched) return true;
  if (
    comparableResolvedWatched &&
    comparableError === comparableResolvedWatched
  ) {
    return true;
  }
  return (
    !repoRoot &&
    comparableWatched.includes("/") &&
    comparableError.endsWith(`/${comparableWatched}`)
  );
}

function isMissingWatchedPathError(
  error: unknown,
  watchedPath: string,
  repoRoot?: string,
): boolean {
  return boundedCauseChain(error).some((cause) => {
    if (typeof cause !== "object" || cause === null) return false;
    const candidate = cause as { code?: unknown; path?: unknown };
    return (
      (candidate.code === "ENOENT" || candidate.code === "ENOTDIR") &&
      typeof candidate.path === "string" &&
      pathsIdentifySameWatchedFile(candidate.path, watchedPath, repoRoot)
    );
  });
}

export async function processWatchedFileChange(params: {
  repoId: string;
  repoRoot?: string;
  filePath: string;
  indexRepo: IndexRepoFn;
  patchSavedFileFn?: (input: {
    repoId: string;
    filePath: string;
  }) => Promise<unknown>;
}): Promise<void> {
  const { repoId, repoRoot, filePath, indexRepo, patchSavedFileFn } = params;
  if (patchSavedFileFn) {
    try {
      await withIndexingGate(() => patchSavedFileFn({ repoId, filePath }));
      return;
    } catch (patchError: unknown) {
      if (!isMissingWatchedPathError(patchError, filePath, repoRoot)) {
        throw patchError;
      }
      // A delete/rename can invalidate more than one file identity, so let the
      // incremental index reconcile repository scope exactly once.
      logger.debug("patchSavedFile failed, falling back to incremental index", {
        repoId,
        filePath,
        error:
          patchError instanceof Error ? patchError.message : String(patchError),
      });
    }
  }

  await indexRepo(repoId, "incremental");
}
