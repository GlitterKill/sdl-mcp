/**
 * Post-ingest cleanup for the scip-io generator's `<repoRoot>/index.scip`.
 *
 * Extracted from `src/indexer/indexer.ts` so the cleanup gating logic
 * (config flags + custom-output detection) and the actual unlink can
 * be unit-tested without spinning up the full indexer pipeline.
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../util/logger.js";

/**
 * Returns `true` when the user has passed an explicit output path to
 * scip-io (via `--output`, `-o`, or `--output=<path>`). In that case the
 * generated file lives somewhere outside the default `<repoRoot>/index.scip`
 * location and cleanup must be skipped — the user is on the hook for
 * managing that file.
 */
export function hasCustomOutputArg(args: readonly string[]): boolean {
  return args.some(
    (arg) => arg === "--output" || arg === "-o" || arg.startsWith("--output="),
  );
}

export interface ScipCleanupOptions {
  generatorEnabled: boolean;
  cleanupAfterIngest: boolean;
  args: readonly string[];
  repoRootPath: string;
  /** Test seam — defaults to `fs/promises.unlink`. */
  unlinkFn?: (path: string) => Promise<void>;
}

/**
 * Decide-and-act for the post-ingest cleanup of `<repoRoot>/index.scip`.
 *
 * Skips silently when:
 *   - `generatorEnabled` is false (nothing was generated, nothing to clean)
 *   - `cleanupAfterIngest` is false (user opted out)
 *   - args contain a custom output flag (cleanup target is unknown)
 *
 * On unlink:
 *   - `ENOENT` is treated as success (the file was already absent)
 *   - other errors are logged at `warn` and swallowed (non-fatal)
 */
export async function maybeCleanupGeneratedScipIndex(
  opts: ScipCleanupOptions,
): Promise<{ skipped: boolean; reason?: string; unlinked?: boolean }> {
  if (!opts.generatorEnabled) {
    return { skipped: true, reason: "generator-disabled" };
  }
  if (!opts.cleanupAfterIngest) {
    return { skipped: true, reason: "cleanup-disabled" };
  }
  if (hasCustomOutputArg(opts.args)) {
    return { skipped: true, reason: "custom-output" };
  }
  const generatedPath = join(opts.repoRootPath, "index.scip");
  const fn = opts.unlinkFn ?? unlink;
  try {
    await fn(generatedPath);
    logger.info("scip-io: cleaned up generated index after ingest", {
      path: generatedPath,
    });
    return { skipped: false, unlinked: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { skipped: false, unlinked: false };
    }
    logger.warn("scip-io: cleanup failed (non-fatal, file remains on disk)", {
      path: generatedPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { skipped: false, unlinked: false };
  }
}
