import type { Connection } from "kuzu";

import * as ladybugDb from "../db/ladybug-queries.js";

/** Durable metadata captured on the caller's read-snapshot connection. */
export interface PreparedSourceMetadata {
  readonly symbol: ladybugDb.SymbolRow | null;
  readonly file: ladybugDb.FileRow | null;
  readonly repo: ladybugDb.RepoRow | null;
}

export async function loadSourceMetadata(
  conn: Connection,
  repoId: string,
  symbolIds: string[],
): Promise<Map<string, PreparedSourceMetadata>> {
  const ids = [...new Set(symbolIds)];
  if (ids.length === 0) return new Map();
  const symbols = await ladybugDb.getSymbolsByIds(conn, ids);
  const fileIds = [
    ...new Set(
      [...symbols.values()]
        .filter((symbol) => symbol.repoId === repoId)
        .map((symbol) => symbol.fileId),
    ),
  ];
  const files = fileIds.length > 0
    ? await ladybugDb.getFilesByIds(conn, fileIds)
    : new Map<string, ladybugDb.FileRow>();
  const repo = files.size > 0 ? await ladybugDb.getRepo(conn, repoId) : null;
  return new Map(
    ids.map((id) => {
      const symbol = symbols.get(id) ?? null;
      return [id, {
        symbol,
        file: symbol ? files.get(symbol.fileId) ?? null : null,
        repo,
      }];
    }),
  );
}
