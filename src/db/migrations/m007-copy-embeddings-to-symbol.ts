/**
 * m007 — Copy embeddings from SymbolEmbedding nodes into Symbol node properties.
 *
 * Upgrades v6 databases to v7. Reads SymbolEmbedding rows, batches by model,
 * and uses UNWIND to write to Symbol nodes in chunks of 256 inside a single
 * transaction. This collapses N round-trips to ceil(N / 256) round-trips per
 * model, dramatically reducing time on the single-writer txn lock.
 *
 * Mock-fallback and unknown models are left in place. Migrated SymbolEmbedding
 * nodes for the recognised models are deleted at the end.
 */
import type { Connection } from "kuzu";
import { exec, execDdl, queryAll, withTransaction } from "../ladybug-core.js";
import { IDEMPOTENT_DDL_ERROR_RE } from "../migration-runner.js";
import { logger } from "../../util/logger.js";

export const version = 7;
export const description =
  "Copy embeddings from SymbolEmbedding nodes into Symbol node properties";

const CHUNK = 256;

/** Shape returned by MATCH (se:SymbolEmbedding) RETURN se.* */
interface EmbeddingRow {
  "se.symbolId": string;
  "se.model": string;
  "se.embeddingVector": string | null;
  "se.cardHash": string | null;
  "se.updatedAt": string | null;
}

interface CopyRow {
  symbolId: string;
  vector: string | null;
  cardHash: string | null;
  updatedAt: string | null;
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
      await execDdl(conn, stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Tolerate idempotent re-runs only; surface real failures.
      if (!IDEMPOTENT_DDL_ERROR_RE.test(msg)) {
        throw err;
      }
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
  // 3. Bucket rows by model.
  // ------------------------------------------------------------------
  const miniLM: CopyRow[] = [];
  const nomic: CopyRow[] = [];
  let skippedMock = 0;
  let skippedUnknown = 0;

  for (const row of rows) {
    const symbolId = row["se.symbolId"];
    const model = row["se.model"];
    const copy: CopyRow = {
      symbolId,
      vector: row["se.embeddingVector"] ?? null,
      cardHash: row["se.cardHash"] ?? null,
      updatedAt: row["se.updatedAt"] ?? null,
    };
    if (model === "mock-fallback") {
      skippedMock++;
    } else if (model === "all-MiniLM-L6-v2") {
      miniLM.push(copy);
    } else if (model === "nomic-embed-text-v1.5") {
      nomic.push(copy);
    } else {
      logger.warn(
        `m007: unknown embedding model "${model}" for symbol ${symbolId} — skipping`,
        { symbolId, model },
      );
      skippedUnknown++;
    }
  }

  // ------------------------------------------------------------------
  // 4. UNWIND-batched copy into Symbol nodes inside one transaction.
  //    Side-effect-only (no RETURN) per UNWIND-batched-writes pattern.
  // ------------------------------------------------------------------
  const migratedSymbolIds: string[] = [];

  await withTransaction(conn, async (txConn) => {
    for (let i = 0; i < miniLM.length; i += CHUNK) {
      const batch = miniLM.slice(i, i + CHUNK);
      await exec(
        txConn,
        `UNWIND $rows AS r
         MATCH (s:Symbol {symbolId: r.symbolId})
         SET s.embeddingMiniLM = r.vector,
             s.embeddingMiniLMCardHash = r.cardHash,
             s.embeddingMiniLMUpdatedAt = r.updatedAt`,
        { rows: batch },
      );
      for (const r of batch) migratedSymbolIds.push(r.symbolId);
    }
    for (let i = 0; i < nomic.length; i += CHUNK) {
      const batch = nomic.slice(i, i + CHUNK);
      await exec(
        txConn,
        `UNWIND $rows AS r
         MATCH (s:Symbol {symbolId: r.symbolId})
         SET s.embeddingNomic = r.vector,
             s.embeddingNomicCardHash = r.cardHash,
             s.embeddingNomicUpdatedAt = r.updatedAt`,
        { rows: batch },
      );
      for (const r of batch) migratedSymbolIds.push(r.symbolId);
    }
  });

  logger.info(
    `m007: migration complete — ` +
      `migratedMiniLM=${miniLM.length}, ` +
      `migratedNomic=${nomic.length}, ` +
      `skippedMock=${skippedMock}, ` +
      `skippedUnknown=${skippedUnknown}`,
    {
      migratedMiniLM: miniLM.length,
      migratedNomic: nomic.length,
      skippedMock,
      skippedUnknown,
    },
  );

  // ------------------------------------------------------------------
  // 5. Delete migrated SymbolEmbedding nodes (mock/unknown are kept).
  // ------------------------------------------------------------------
  if (migratedSymbolIds.length === 0) {
    return;
  }

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
