/**
 * m005 — Add Memory node table and memory relationship edges.
 *
 * Upgrades v4 databases to v5. No data backfill needed —
 * Memory tables start empty since there is no prior memory data.
 */
import type { Connection } from "kuzu";
import { execDdl } from "../ladybug-core.js";
import { logger } from "../../util/logger.js";

export const version = 5;
export const description =
  "Add Memory node table and memory relationship edges";

export async function up(conn: Connection): Promise<void> {
  // Node table
  await execDdl(
    conn,
    `CREATE NODE TABLE IF NOT EXISTS Memory (
      memoryId STRING PRIMARY KEY,
      repoId STRING,
      type STRING,
      title STRING,
      content STRING,
      contentHash STRING,
      searchText STRING,
      tagsJson STRING DEFAULT '[]',
      confidence DOUBLE DEFAULT 0.8,
      createdAt STRING,
      updatedAt STRING,
      createdByVersion STRING,
      stale BOOLEAN DEFAULT false,
      staleVersion STRING,
      sourceFile STRING,
      deleted BOOLEAN DEFAULT false
    )`,
  );

  // Relationship tables
  await execDdl(
    conn,
    `CREATE REL TABLE IF NOT EXISTS HAS_MEMORY (FROM Repo TO Memory)`,
  );
  await execDdl(
    conn,
    `CREATE REL TABLE IF NOT EXISTS MEMORY_OF (FROM Memory TO Symbol)`,
  );
  await execDdl(
    conn,
    `CREATE REL TABLE IF NOT EXISTS MEMORY_OF_FILE (FROM Memory TO File)`,
  );

  // Performance-only secondary indexes. Older LadybugDB/Kuzu builds either do
  // not support scalar indexes or do not support IF NOT EXISTS for indexes, so
  // failures here must not block a historical schema upgrade.
  const indexes = [
    `CREATE INDEX idx_memory_repoId ON Memory(repoId)`,
    `CREATE INDEX idx_memory_type ON Memory(type)`,
    `CREATE INDEX idx_memory_contentHash ON Memory(contentHash)`,
  ];
  for (const idx of indexes) {
    try {
      await execDdl(conn, idx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug("m005: Memory secondary index creation skipped", {
        reason: msg,
      });
    }
  }
}
