import type { Connection } from "kuzu";

import { queryAll, querySingle } from "./ladybug-core.js";
import { inspectRepoSymbolVectorTable } from "./ladybug-symbol-embeddings.js";

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

export interface RepoSymbolVectorHealthRow {
  embeddingId: string | null;
  repoId: string | null;
  symbolId: string | null;
  model: string | null;
  embeddingVectorPresent: boolean;
  cardHashPresent: boolean;
  embeddingJinaCodeVecPresent: boolean;
  embeddingNomicVecPresent: boolean;
}

export interface RepoSymbolVectorHealthRows {
  tableName: string;
  tableState: "absent" | "present";
  rows: RepoSymbolVectorHealthRow[];
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

/** Read the exact eligible Symbol identities used by vector coverage. */
export async function getEligibleRepoSymbolIds(
  conn: Connection,
  repoId: string,
): Promise<string[]> {
  const rows = await queryAll<{ symbolId: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)-[:SYMBOL_IN_REPO]->(r)
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
       AND coalesce(s.external, false) = false
       AND trim(coalesce(s.searchText, '')) <> ''
     RETURN DISTINCT s.symbolId AS symbolId
     ORDER BY symbolId`,
    { repoId },
  );
  return rows
    .map((row) => (typeof row.symbolId === "string" ? row.symbolId : ""))
    .filter((symbolId) => symbolId.length > 0);
}

/**
 * Read only metadata and presence bits needed for durable vector validation.
 * Table inspection is strict and observational; an absent table stays absent.
 */
export async function getRepoSymbolVectorHealthRows(
  conn: Connection,
  repoId: string,
): Promise<RepoSymbolVectorHealthRows> {
  const inspection = await inspectRepoSymbolVectorTable(conn, repoId);
  if (inspection.state === "absent") {
    return {
      tableName: inspection.tableName,
      tableState: "absent",
      rows: [],
    };
  }

  const rows = await queryAll<Record<string, unknown>>(
    conn,
    `MATCH (e:${inspection.tableName})
     RETURN e.embeddingId AS embeddingId,
            e.repoId AS repoId,
            e.symbolId AS symbolId,
            e.model AS model,
            e.embeddingVector IS NOT NULL AS embeddingVectorPresent,
            e.cardHash IS NOT NULL AS cardHashPresent,
            e.embeddingJinaCodeVec IS NOT NULL AS embeddingJinaCodeVecPresent,
            e.embeddingNomicVec IS NOT NULL AS embeddingNomicVecPresent
     ORDER BY embeddingId`,
  );
  return {
    tableName: inspection.tableName,
    tableState: "present",
    rows: rows.map((row) => ({
      embeddingId:
        typeof row.embeddingId === "string" ? row.embeddingId : null,
      repoId: typeof row.repoId === "string" ? row.repoId : null,
      symbolId: typeof row.symbolId === "string" ? row.symbolId : null,
      model: typeof row.model === "string" ? row.model : null,
      embeddingVectorPresent: row.embeddingVectorPresent === true,
      cardHashPresent: row.cardHashPresent === true,
      embeddingJinaCodeVecPresent:
        row.embeddingJinaCodeVecPresent === true,
      embeddingNomicVecPresent: row.embeddingNomicVecPresent === true,
    })),
  };
}

/** Count searchable real symbols covered by one repository vector table. */
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
  const inspection = await inspectRepoSymbolVectorTable(conn, repoId);
  if (inspection.state === "absent") {
    return { eligible: eligible?.eligible ?? 0, covered: 0 };
  }

  const covered = await querySingle<{ covered: unknown }>(
    conn,
    `MATCH (e:${inspection.tableName})
     MATCH (r:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)<-[:SYMBOL_IN_FILE]-(s:Symbol)-[:SYMBOL_IN_REPO]->(r)
     WHERE e.repoId = $repoId
       AND e.model = $model
       AND e.embeddingId = $model + ':' + s.symbolId
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
