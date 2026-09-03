import type { Connection } from "kuzu";

import { SYMBOL_VECTOR_EMBEDDING_TABLE } from "../retrieval/model-mapping.js";
import { querySingle } from "./ladybug-core.js";

// Repository-scoped completeness and ownership checks live with storage so
// mutation callers and health reporting share one invariant implementation.
export {
  countCompleteRepoSymbolVectors,
  validateRepoSymbolVectorOwnership,
} from "./ladybug-symbol-embeddings.js";

export interface RetrievalCoverageRow {
  eligible: unknown;
  covered: unknown;
}

const TRUSTED_RETRIEVAL_VECTOR_PROPERTIES = new Map([
  ["embeddingJinaCodeVec", "jina-embeddings-v2-base-code"],
  ["embeddingNomicVec", "nomic-embed-text-v1.5"],
]);

function resolveTrustedVectorModel(property: string): string {
  const model = TRUSTED_RETRIEVAL_VECTOR_PROPERTIES.get(property);
  if (!model) {
    throw new Error(`Unsupported vector property: ${property}`);
  }
  return model;
}

/** Count searchable real symbols and those covered by one trusted vector property. */
export async function getSymbolRetrievalCoverage(
  conn: Connection,
  repoId: string,
  property: string,
): Promise<RetrievalCoverageRow> {
  const model = resolveTrustedVectorModel(property);
  const eligible = await querySingle<{ eligible: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)-[:SYMBOL_IN_REPO]->(r)
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
       AND coalesce(s.external, false) = false
       AND trim(coalesce(s.searchText, '')) <> ''
     RETURN count(DISTINCT s.symbolId) AS eligible`,
    { repoId },
  );
  const covered = await querySingle<{ covered: unknown }>(
    conn,
    `MATCH (e:${SYMBOL_VECTOR_EMBEDDING_TABLE} {model: $model})
     MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)-[:SYMBOL_IN_REPO]->(r)
     WHERE e.embeddingId = $model + ':' + s.symbolId
       AND e.${property} IS NOT NULL
       AND coalesce(s.symbolStatus, 'real') = 'real'
       AND coalesce(s.external, false) = false
       AND trim(coalesce(s.searchText, '')) <> ''
     RETURN count(DISTINCT e.symbolId) AS covered`,
    { repoId, model },
  );
  return {
    eligible: eligible?.eligible ?? 0,
    covered: covered?.covered ?? 0,
  };
}

/** Count searchable file summaries and those covered by one trusted vector property. */
export async function getFileSummaryRetrievalCoverage(
  conn: Connection,
  repoId: string,
  property: string,
): Promise<RetrievalCoverageRow> {
  resolveTrustedVectorModel(property);
  const row = await querySingle<RetrievalCoverageRow>(
    conn,
    `MATCH (fs:FileSummary {repoId: $repoId})
     WHERE trim(coalesce(fs.searchText, '')) <> ''
     RETURN count(DISTINCT fs.fileId) AS eligible,
            count(DISTINCT CASE WHEN fs.${property} IS NOT NULL THEN fs.fileId ELSE NULL END) AS covered`,
    { repoId },
  );
  return row ?? { eligible: 0, covered: 0 };
}
