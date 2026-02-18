import { describe, it } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migrations.js";

describe("embedding migration", () => {
  it("creates symbol_embeddings table and edge resolution strategy column", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const embeddingTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_embeddings'",
      )
      .get() as { name: string } | undefined;
    assert.ok(embeddingTable, "symbol_embeddings table should exist");

    const edgeColumns = db
      .prepare("PRAGMA table_info(edges)")
      .all() as Array<{ name: string }>;
    assert.ok(
      edgeColumns.some((column) => column.name === "resolution_strategy"),
      "edges.resolution_strategy column should exist",
    );
  });
});
