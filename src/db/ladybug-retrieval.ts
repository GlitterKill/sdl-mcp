import type { Connection } from "kuzu";

import { EMBEDDING_MODELS } from "../retrieval/model-mapping.js";
import { queryAll, queryExactVectorAll } from "./ladybug-core.js";
import { resolveSymbolVectorPhysicalIdentity } from "./ladybug-symbol-embeddings.js";

export interface RetrievalSeedCandidateRow {
  symbolId: string;
  score: number;
}

export interface RepositorySymbolVectorCandidateRow
  extends RetrievalSeedCandidateRow {
  repoId: string;
  model: string;
  embeddingId: string;
}

/** Rank one repository exactly through its derived physical table. */
export async function rankRepoSymbolVectorsExact(
  conn: Connection,
  repoId: string,
  modelName: string,
  embedding: number[],
  limit: number,
): Promise<RepositorySymbolVectorCandidateRow[]> {
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

  const identity = resolveSymbolVectorPhysicalIdentity(repoId, modelName);
  return queryExactVectorAll<RepositorySymbolVectorCandidateRow>(
    conn,
    `MATCH (e:${identity.tableName})
     WHERE e.repoId = $repoId
       AND e.model = $model
       AND e.${identity.propertyName} IS NOT NULL
     WITH e.repoId AS repoId,
          e.model AS model,
          e.embeddingId AS embeddingId,
          e.symbolId AS symbolId,
          array_cosine_similarity(
            e.${identity.propertyName},
            CAST($embedding, 'DOUBLE[${model.dimension}]')
          ) AS score
     RETURN repoId, model, embeddingId, symbolId, score
     ORDER BY score DESC, symbolId ASC
     LIMIT $limit`,
    { repoId, model: modelName, embedding, limit },
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
