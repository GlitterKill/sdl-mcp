/**
 * m007 — Copy real embeddings from SymbolEmbedding nodes into Symbol node properties.
 *
 * Upgrades v6 databases to v7. Reads all SymbolEmbedding rows and copies the
 * serialised vector string into the corresponding Symbol's embeddingMiniLM or
 * embeddingNomic column depending on the model field.  After a successful copy
 * the migrated SymbolEmbedding nodes are deleted so data lives in one place.
 *
 * Skipped rows:
 *   - model = "mock-fallback"  → increment skippedMock counter, leave node
 *   - model = unknown value    → increment skippedUnknown counter, leave node
 */

import type { Connection } from "kuzu";
import { exec, queryAll, withTransaction } from "../ladybug-core.js";
import { logger } from "../../util/logger.js";

export const version = 7;
export const description =
  "Copy embeddings from SymbolEmbedding nodes into Symbol node properties";

/** Shape returned by MATCH (se:SymbolEmbedding) RETURN se.* */
interface EmbeddingRow {
  "se.symbolId": string;
  "se.model": string;
  "se.embeddingVector": string | null;
  "se.cardHash": string | null;
  "se.updatedAt": string | null;
}

export async function up(conn: Connection): Promise<void> {
  // ------------------------------------------------------------------
  // 1. Ensure the destination columns exist on Symbol.
  //    Older databases created before the schema change won't have them.
  //    ADD PROPERTY is idempotent-ish via IF NOT EXISTS where Kuzu supports it;
  //    otherwise we catch the "already exists" error and move on.
  // ------------------------------------------------------------------
  const alterStatements = [
    `ALTER TABLE Symbol ADD embeddingMiniLM STRING DEFAULT NULL`,
    `ALTER TABLE Symbol ADD embeddingMiniLMCardHash STRING DEFAULT NULL`,
    `ALTER TABLE Symbol ADD embeddingMiniLMUpdatedAt STRING DEFAULT NULL`,
    `ALTER TABLE Symbol ADD embeddingNomic STRING DEFAULT NULL`,
    `ALTER TABLE Symbol ADD embeddingNomicCardHash STRING DEFAULT NULL`,
    `ALTER TABLE Symbol ADD embeddingNomicUpdatedAt STRING DEFAULT NULL`,
  ];

  for (const stmt of alterStatements) {
    try {
      await exec(conn, stmt, {});
    } catch {
      // Column already exists — safe to ignore.
    }
  }

  // ------------------------------------------------------------------
  // 2. Read all SymbolEmbedding nodes.
  // ------------------------------------------------------------------
  let rows: EmbeddingRow[];
  try {
    rows = await queryAll<EmbeddingRow>(
      conn,
      `MATCH (se:SymbolEmbedding) RETURN se.*`,
      {},
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Table SymbolEmbedding does not exist") ||
      message.includes("Node table SymbolEmbedding does not exist")
    ) {
      logger.info("m007: SymbolEmbedding table absent in source DB; skipping migration", {});
      return;
    }
    throw error;
  }

  if (rows.length === 0) {
    logger.info("m007: no SymbolEmbedding nodes found — nothing to migrate", {});
    return;
  }

  logger.info(`m007: found ${rows.length} SymbolEmbedding rows to process`, {});

  // ------------------------------------------------------------------
  // 3. Copy vectors into Symbol nodes inside a transaction.
  // ------------------------------------------------------------------
  let migratedMiniLM = 0;
  let migratedNomic = 0;
  let skippedMock = 0;
  let skippedUnknown = 0;

  // Collect symbolIds that were successfully migrated so we can delete them.
  const migratedSymbolIds: string[] = [];

  await withTransaction(conn, async (txConn) => {
    for (const row of rows) {
      const symbolId = row["se.symbolId"];
      const model = row["se.model"];
      const vector = row["se.embeddingVector"];
      const cardHash = row["se.cardHash"];
      const updatedAt = row["se.updatedAt"];

      if (model === "mock-fallback") {
        skippedMock++;
        continue;
      }

      if (model === "all-MiniLM-L6-v2") {
        await exec(
          txConn,
          `MATCH (s:Symbol {symbolId: $symbolId})
           SET s.embeddingMiniLM = $vector,
               s.embeddingMiniLMCardHash = $cardHash,
               s.embeddingMiniLMUpdatedAt = $updatedAt`,
          {
            symbolId,
            vector: vector ?? null,
            cardHash: cardHash ?? null,
            updatedAt: updatedAt ?? null,
          },
        );
        migratedMiniLM++;
        migratedSymbolIds.push(symbolId);
        continue;
      }

      if (model === "nomic-embed-text-v1.5") {
        await exec(
          txConn,
          `MATCH (s:Symbol {symbolId: $symbolId})
           SET s.embeddingNomic = $vector,
               s.embeddingNomicCardHash = $cardHash,
               s.embeddingNomicUpdatedAt = $updatedAt`,
          {
            symbolId,
            vector: vector ?? null,
            cardHash: cardHash ?? null,
            updatedAt: updatedAt ?? null,
          },
        );
        migratedNomic++;
        migratedSymbolIds.push(symbolId);
        continue;
      }

      // Unknown model — log and skip.
      logger.warn(`m007: unknown embedding model "${model}" for symbol ${symbolId} — skipping`, {
        symbolId,
        model,
      });
      skippedUnknown++;
    }
  });

  logger.info(
    `m007: migration complete — ` +
      `migratedMiniLM=${migratedMiniLM}, ` +
      `migratedNomic=${migratedNomic}, ` +
      `skippedMock=${skippedMock}, ` +
      `skippedUnknown=${skippedUnknown}`,
    { migratedMiniLM, migratedNomic, skippedMock, skippedUnknown },
  );

  // ------------------------------------------------------------------
  // 4. Delete migrated SymbolEmbedding nodes (mock/unknown are kept).
  // ------------------------------------------------------------------
  if (migratedSymbolIds.length === 0) {
    return;
  }

  // Kuzu does not support IN with a list parameter in all versions, so we
  // delete in a single pass using the known-good list approach: unwind the
  // array as a parameter.
  await exec(
    conn,
    `UNWIND $symbolIds AS sid
     MATCH (se:SymbolEmbedding {symbolId: sid})
     WHERE se.model IN ['all-MiniLM-L6-v2', 'nomic-embed-text-v1.5']
     DELETE se`,
    { symbolIds: migratedSymbolIds },
  );

  logger.info(`m007: deleted ${migratedSymbolIds.length} migrated SymbolEmbedding nodes`, {
    count: migratedSymbolIds.length,
  });
}
