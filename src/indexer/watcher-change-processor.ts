import { getDefaultLiveIndexCoordinator } from "../live-index/coordinator.js";

import {
  GraphIntegrityBaselineError,
  SafeRebuildRequiredError,
  StorageIntegrityError,
} from "../domain/errors.js";
import { ConcurrencyQueueTimeoutError } from "../util/concurrency.js";

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
      cause.message.includes(
        "Cannot start a new write transaction in the system",
      )
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

/** Admission is synchronous: readiness and provider preparation belong to the worker. */
export function processWatchedFileChange(params: {
  repoId: string;
  repoRoot?: string;
  filePath: string;
  removed?: boolean;
  coordinator?: {
    recordDiskChange?(input: {
      repoId: string;
      filePath: string;
      removed?: boolean;
    }): boolean;
  };
  // Kept for existing callers; watchers never invoke index or patch callbacks.
  indexRepo?: IndexRepoFn;
  isWriteReady?: () => boolean;
  patchSavedFileFn?: (input: {
    repoId: string;
    filePath: string;
  }) => Promise<unknown>;
}): boolean {
  return (
    (params.coordinator ?? getDefaultLiveIndexCoordinator()).recordDiskChange?.(
      {
        repoId: params.repoId,
        filePath: params.filePath,
        ...(params.removed === undefined ? {} : { removed: params.removed }),
      },
    ) ?? false
  );
}
