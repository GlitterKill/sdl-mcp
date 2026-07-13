import type { Connection } from "kuzu";

import { queryAll } from "./ladybug-core.js";

export interface RetrievalSeedCandidateRow {
  symbolId: string;
  score: number;
}

/** Resolve a full symbol ID without leaking Cypher into retrieval orchestration. */
export async function hasRetrievalSeedSymbol(
  conn: Connection,
  repoId: string,
  symbolId: string,
): Promise<boolean> {
  const rows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId = $symbolId AND s.repoId = $repoId
     RETURN s.symbolId AS symbolId
     LIMIT 1`,
    { symbolId, repoId },
  );
  return rows.length > 0;
}

/** Return at most two short-ID matches so the caller can reject ambiguity. */
export async function findRetrievalSeedSymbolsByIdPrefix(
  conn: Connection,
  repoId: string,
  prefix: string,
): Promise<string[]> {
  const rows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.repoId = $repoId AND s.symbolId STARTS WITH $prefix
     RETURN s.symbolId AS symbolId
     LIMIT 2`,
    { repoId, prefix },
  );
  return rows.map((row) => row.symbolId);
}

/** Return exact or prefix name matches for retrieval seed ranking. */
export async function findRetrievalSeedSymbolsByName(
  conn: Connection,
  repoId: string,
  name: string,
  mode: "exact" | "prefix",
): Promise<RetrievalSeedCandidateRow[]> {
  const predicate = mode === "exact" ? "s.name = $name" : "s.name STARTS WITH $name";
  return queryAll<RetrievalSeedCandidateRow>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.repoId = $repoId AND ${predicate}
     RETURN s.symbolId AS symbolId, 1.0 AS score
     LIMIT 2`,
    { repoId, name },
  );
}
