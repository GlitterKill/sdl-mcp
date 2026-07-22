import type { Connection } from "kuzu";

import {
  getDerivedStateFromConnection,
  graphIntegrityIsAvailableForVersion,
} from "../db/ladybug-derived-state.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { IndexError } from "../domain/errors.js";

/**
 * Fail graph retrieval closed until the latest Version has an established
 * integrity manifest. Verification may continue in the background because the
 * manifest-backed graph is already the current retrieval graph.
 */
export async function assertGraphRetrievalAvailable(
  conn: Connection,
  repoId: string,
): Promise<void> {
  const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
  if (!latestVersion) {
    // Preserve handler-owned NOT_FOUND contracts for repositories that do not
    // exist. Registered repositories without a Version still fail closed.
    const repo = await ladybugDb.getRepo(conn, repoId);
    if (!repo) return;
  }
  const derivedState = await getDerivedStateFromConnection(conn, repoId);
  if (
    graphIntegrityIsAvailableForVersion(
      derivedState,
      latestVersion?.versionId ?? null,
    )
  ) {
    return;
  }

  throw new IndexError(
    `Graph retrieval is unavailable for repository ${repoId} because integrity is not established for the latest version. Run sdl.index.refresh with mode:"full" to rebuild and verify the graph.`,
  );
}
