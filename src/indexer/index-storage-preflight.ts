import type { Connection } from "kuzu";

import { getFileCount } from "../db/ladybug-repos.js";
import { assertPhysicalSymbolUniqueness } from "../db/ladybug-symbols.js";
import { SafeRebuildRequiredError } from "../domain/errors.js";

export interface IndexStoragePreflightOptions {
  isolatedRebuild?: boolean;
}

/**
 * Reject unsafe storage before provider generation, checkpoints, or graph
 * writes. A full index is destructive once files exist, so it may only target
 * an explicitly isolated rebuild candidate.
 */
export async function assertIndexStoragePreflight(
  conn: Connection,
  repoId: string,
  requestedMode: "full" | "incremental",
  options: IndexStoragePreflightOptions = {},
): Promise<void> {
  await assertPhysicalSymbolUniqueness(conn);

  if (
    requestedMode === "full" &&
    !options.isolatedRebuild &&
    (await getFileCount(conn, repoId)) > 0
  ) {
    throw new SafeRebuildRequiredError(
      `Refusing an in-place full refresh for populated repository ${repoId}. ` +
        "Build and validate a fresh whole-database candidate with " +
        "`sdl-mcp index --force --safe-rebuild <absolute-new-path>`.",
    );
  }
}
