import type { Connection } from "kuzu";
import {
  normalizeDependencyPlaceholderSymbols,
  pruneIsolatedPlaceholderSymbols,
} from "../ladybug-symbols.js";
import { queryAll } from "../ladybug-core.js";

export const version = 17;
export const description =
  "Repair dependency placeholder metadata and prune isolated placeholders";

export async function up(conn: Connection): Promise<void> {
  const repos = await queryAll<{ repoId: string }>(
    conn,
    `MATCH (r:Repo) RETURN r.repoId AS repoId`,
    {},
  );
  for (const repo of repos) {
    await normalizeDependencyPlaceholderSymbols(conn, repo.repoId, {
      // v16 databases can predate columns referenced by the runtime's stable
      // field repair. The normal post-index finalizer runs the default path
      // once current schema DDL is available.
      normalizeStableFields: false,
    });
    await pruneIsolatedPlaceholderSymbols(conn, repo.repoId);
  }
}
