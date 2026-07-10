import type { Connection } from "kuzu";

import { execDdl } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";
import { remediateSymbolEmbeddings } from "./symbol-embedding-remediation.js";

/**
 * m007 — Add model-aware Symbol embedding properties and conservatively
 * remediate compatible legacy SymbolEmbedding rows.
 *
 * Source rows are deleted only after a committed copy or a verified existing
 * destination survives complete fingerprint revalidation.
 */
export const version = 7;
export const description =
  "Copy embeddings from SymbolEmbedding nodes into Symbol node properties";

const ALTER_STATEMENTS = [
  "ALTER TABLE Symbol ADD embeddingMiniLM STRING DEFAULT NULL",
  "ALTER TABLE Symbol ADD embeddingMiniLMCardHash STRING DEFAULT NULL",
  "ALTER TABLE Symbol ADD embeddingMiniLMUpdatedAt STRING DEFAULT NULL",
  "ALTER TABLE Symbol ADD embeddingNomic STRING DEFAULT NULL",
  "ALTER TABLE Symbol ADD embeddingNomicCardHash STRING DEFAULT NULL",
  "ALTER TABLE Symbol ADD embeddingNomicUpdatedAt STRING DEFAULT NULL",
] as const;

export async function up(conn: Connection): Promise<void> {
  for (const statement of ALTER_STATEMENTS) {
    try {
      await execDdl(conn, statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!IDEMPOTENT_DDL_ERROR_RE.test(message)) throw error;
    }
  }

  await remediateSymbolEmbeddings(conn, "m007");
}
