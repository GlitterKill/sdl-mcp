import { createHash } from "node:crypto";

import type { Connection } from "kuzu";

import { SYMBOL_VECTOR_EMBEDDING_TABLE } from "../retrieval/model-mapping.js";
import { execStoredProc, queryAll } from "./ladybug-core.js";

const symbolVectorProjectionPromises = new WeakMap<
  Connection,
  Map<string, Promise<string>>
>();

function cypherSingleQuotedString(value: string): string {
  return `'${value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/'/g, "\\'")}'`;
}

export interface RetrievalSeedCandidateRow {
  symbolId: string;
  score: number;
}

/** Ensure Symbol vector ANN ranking is scoped to one repository before top-K. */
export async function ensureRepoSymbolVectorProjection(
  conn: Connection,
  repoId: string,
): Promise<string> {
  const projectionName = `sdl_symbol_vectors_${createHash("sha256")
    .update(repoId)
    .digest("hex")
    .slice(0, 16)}`;
  let projections = symbolVectorProjectionPromises.get(conn);
  if (!projections) {
    projections = new Map();
    symbolVectorProjectionPromises.set(conn, projections);
  }
  const existing = projections.get(projectionName);
  if (existing) return existing;

  const projectionQuery =
    `MATCH (r:Repo {repoId: ${cypherSingleQuotedString(repoId)}})<-[:FILE_IN_REPO]-(:File)` +
    `<-[:SYMBOL_IN_FILE]-(s:Symbol), (e:${SYMBOL_VECTOR_EMBEDDING_TABLE}) ` +
    "WHERE e.symbolId = s.symbolId WITH DISTINCT e RETURN e";
  const creating = execStoredProc(
    conn,
    `CALL PROJECT_GRAPH_CYPHER(${cypherSingleQuotedString(projectionName)}, ${cypherSingleQuotedString(projectionQuery)})`,
  ).then(() => projectionName);
  projections.set(projectionName, creating);
  try {
    return await creating;
  } catch (err) {
    if (projections.get(projectionName) === creating) {
      projections.delete(projectionName);
    }
    throw err;
  }
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
     ORDER BY s.symbolId
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
     ORDER BY s.symbolId
     LIMIT 2`,
    { repoId, name },
  );
}
