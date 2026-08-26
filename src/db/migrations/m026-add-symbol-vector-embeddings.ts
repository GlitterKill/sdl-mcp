import type { Connection } from "kuzu";

import { exec, execDdl } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";
import type { Migration } from "./types.js";

export const version = 26;
export const description = "Add per-model symbol vector embedding storage";

const DDL = `CREATE NODE TABLE IF NOT EXISTS SymbolVectorEmbedding (
  embeddingId STRING PRIMARY KEY,
  repoId STRING,
  symbolId STRING,
  model STRING,
  embeddingVector STRING,
  cardHash STRING,
  updatedAt STRING,
  embeddingJinaCodeVec DOUBLE[768],
  embeddingNomicVec DOUBLE[768]
)`;

export async function up(conn: Connection): Promise<void> {
  try {
    await execDdl(conn, DDL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!IDEMPOTENT_DDL_ERROR_RE.test(message)) throw error;
  }

  // Copy each complete model tuple independently so partial legacy rows stay dirty.
  await exec(
    conn,
    `MATCH (s:Symbol)
     WHERE s.embeddingJinaCode IS NOT NULL
       AND s.embeddingJinaCodeCardHash IS NOT NULL
       AND s.embeddingJinaCodeVec IS NOT NULL
     MERGE (e:SymbolVectorEmbedding {
       embeddingId: 'jina-embeddings-v2-base-code:' + s.symbolId
     })
     SET e.repoId = s.repoId,
         e.symbolId = s.symbolId,
         e.model = 'jina-embeddings-v2-base-code',
         e.embeddingVector = s.embeddingJinaCode,
         e.cardHash = s.embeddingJinaCodeCardHash,
         e.updatedAt = s.embeddingJinaCodeUpdatedAt,
         e.embeddingJinaCodeVec = s.embeddingJinaCodeVec,
         e.embeddingNomicVec = NULL`,
  );
  await exec(
    conn,
    `MATCH (s:Symbol)
     WHERE s.embeddingNomic IS NOT NULL
       AND s.embeddingNomicCardHash IS NOT NULL
       AND s.embeddingNomicVec IS NOT NULL
     MERGE (e:SymbolVectorEmbedding {
       embeddingId: 'nomic-embed-text-v1.5:' + s.symbolId
     })
     SET e.repoId = s.repoId,
         e.symbolId = s.symbolId,
         e.model = 'nomic-embed-text-v1.5',
         e.embeddingVector = s.embeddingNomic,
         e.cardHash = s.embeddingNomicCardHash,
         e.updatedAt = s.embeddingNomicUpdatedAt,
         e.embeddingJinaCodeVec = NULL,
         e.embeddingNomicVec = s.embeddingNomicVec`,
  );
}

export default { version, description, up } satisfies Migration;
