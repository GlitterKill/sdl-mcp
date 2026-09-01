import type { Connection } from "kuzu";

import {
  EMBEDDING_MODELS,
  SYMBOL_VECTOR_EMBEDDING_TABLE,
} from "../retrieval/model-mapping.js";
import { queryAll, queryExactVectorAll } from "./ladybug-core.js";

export interface RetrievalSeedCandidateRow {
  symbolId: string;
  score: number;
}

/** Rank one repository exactly when bounded global ANN cannot provide enough owned rows. */
export async function rankRepoSymbolVectorsExact(
  conn: Connection,
  repoId: string,
  modelName: string,
  embedding: number[],
  limit: number,
): Promise<RetrievalSeedCandidateRow[]> {
  const model = EMBEDDING_MODELS[modelName];
  if (!model) {
    throw new Error(`Unknown embedding model "${modelName}"`);
  }
  if (embedding.length !== model.dimension) {
    throw new Error(
      `Embedding for "${modelName}" must contain ${model.dimension} values`,
    );
  }
  if (embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding contains a non-finite value");
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error(`limit must be an integer from 1 to 10000, got ${limit}`);
  }

  return queryExactVectorAll<RetrievalSeedCandidateRow>(
    conn,
    `MATCH (e:${SYMBOL_VECTOR_EMBEDDING_TABLE})
     WHERE e.repoId = $repoId
       AND e.${model.vecProperty} IS NOT NULL
     WITH e.symbolId AS symbolId,
          array_cosine_similarity(
            e.${model.vecProperty},
            CAST($embedding, 'DOUBLE[${model.dimension}]')
          ) AS score
     RETURN symbolId, score
     ORDER BY score DESC, symbolId ASC
     LIMIT $limit`,
    { repoId, embedding, limit },
  );
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
