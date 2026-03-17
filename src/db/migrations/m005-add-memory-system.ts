/**
 * m005 — Add Memory node table and memory relationship edges.
 *
 * Upgrades v4 databases to v5. No data backfill needed —
 * Memory tables start empty since there is no prior memory data.
 */
import type { Connection } from "kuzu";

export const version = 5;
export const description =
  "Add Memory node table and memory relationship edges";

async function execDdl(conn: Connection, ddl: string): Promise<void> {
  const result = await conn.query(ddl);
  result.close();
}

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

  // Indexes (may not be supported on all Kuzu versions)
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_memory_repoId ON Memory(repoId)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_type ON Memory(type)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_contentHash ON Memory(contentHash)`,
  ];
  for (const idx of indexes) {
    try {
      await execDdl(conn, idx);
    } catch {
      // Kùzu versions before 0.4 do not support CREATE INDEX. Since indexes
      // are performance-only (not correctness), silently skipping is safe.
    }
  }
}
