import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
// @ts-expect-error — node:sqlite types not available in this TS target
import { DatabaseSync } from "node:sqlite";

import { migrateSqliteToKuzu } from "../../scripts/migrate-sqlite-to-kuzu.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SQLITE_DB_PATH = join(
  __dirname,
  "..",
  "..",
  ".sqlite-to-kuzu-migration-test.sqlite",
);
const KUZU_DB_PATH = join(
  __dirname,
  "..",
  "..",
  ".kuzu-migration-test-db.kuzu",
);

function cleanup(): void {
  if (existsSync(SQLITE_DB_PATH)) {
    rmSync(SQLITE_DB_PATH, { force: true });
  }
  if (existsSync(KUZU_DB_PATH)) {
    rmSync(KUZU_DB_PATH, { recursive: true, force: true });
  }
}

describe("SQLite → Kuzu migration (integration)", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(dirname(SQLITE_DB_PATH), { recursive: true });
    mkdirSync(dirname(KUZU_DB_PATH), { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("migrates core tables and verifies counts", async () => {
    const sqlite = new DatabaseSync(SQLITE_DB_PATH);
    const now = "2026-03-04T00:00:00.000Z";

    sqlite.exec(`
      CREATE TABLE repos (
        repo_id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE files (
        file_id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        language TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        last_indexed_at TEXT,
        directory TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE symbols (
        symbol_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        file_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        exported INTEGER NOT NULL,
        visibility TEXT,
        language TEXT NOT NULL,
        range_start_line INTEGER NOT NULL,
        range_start_col INTEGER NOT NULL,
        range_end_line INTEGER NOT NULL,
        range_end_col INTEGER NOT NULL,
        ast_fingerprint TEXT NOT NULL,
        signature_json TEXT,
        summary TEXT,
        invariants_json TEXT,
        side_effects_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE edges (
        edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id TEXT NOT NULL,
        from_symbol_id TEXT NOT NULL,
        to_symbol_id TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL NOT NULL,
        provenance TEXT,
        created_at TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        resolution_strategy TEXT DEFAULT 'exact'
      );
      CREATE TABLE versions (
        version_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reason TEXT,
        prev_version_hash TEXT,
        version_hash TEXT
      );
      CREATE TABLE symbol_versions (
        version_id TEXT NOT NULL,
        symbol_id TEXT NOT NULL,
        ast_fingerprint TEXT NOT NULL,
        signature_json TEXT,
        summary TEXT,
        invariants_json TEXT,
        side_effects_json TEXT,
        PRIMARY KEY(version_id, symbol_id)
      );
      CREATE TABLE metrics (
        symbol_id TEXT PRIMARY KEY,
        fan_in INTEGER NOT NULL DEFAULT 0,
        fan_out INTEGER NOT NULL DEFAULT 0,
        churn_30d INTEGER NOT NULL DEFAULT 0,
        test_refs_json TEXT,
        canonical_test_json TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    sqlite.exec(
      `INSERT INTO repos(repo_id, root_path, config_json, created_at) VALUES ('r1', 'C:/repo', '{}', '${now}')`,
    );
    sqlite.exec(
      `INSERT INTO files(repo_id, rel_path, content_hash, language, byte_size, last_indexed_at, directory)
       VALUES ('r1', 'src/app.ts', 'hash', 'ts', 10, '${now}', 'src')`,
    );
    sqlite.exec(
      `INSERT INTO symbols(symbol_id, repo_id, file_id, kind, name, exported, visibility, language,
                           range_start_line, range_start_col, range_end_line, range_end_col,
                           ast_fingerprint, signature_json, summary, invariants_json, side_effects_json, updated_at)
       VALUES ('s1', 'r1', 1, 'function', 's1', 1, 'public', 'ts', 1, 0, 2, 1, 'fp1', NULL, NULL, NULL, NULL, '${now}')`,
    );
    sqlite.exec(
      `INSERT INTO symbols(symbol_id, repo_id, file_id, kind, name, exported, visibility, language,
                           range_start_line, range_start_col, range_end_line, range_end_col,
                           ast_fingerprint, signature_json, summary, invariants_json, side_effects_json, updated_at)
       VALUES ('s2', 'r1', 1, 'function', 's2', 1, 'public', 'ts', 1, 0, 2, 1, 'fp2', NULL, NULL, NULL, NULL, '${now}')`,
    );
    sqlite.exec(
      `INSERT INTO edges(repo_id, from_symbol_id, to_symbol_id, type, weight, provenance, created_at, confidence, resolution_strategy)
       VALUES ('r1', 's1', 's2', 'call', 1.0, 'static', '${now}', 1.0, 'exact')`,
    );
    sqlite.exec(
      `INSERT INTO versions(version_id, repo_id, created_at, reason, prev_version_hash, version_hash)
       VALUES ('v1', 'r1', '${now}', 'test', NULL, NULL)`,
    );
    sqlite.exec(
      `INSERT INTO symbol_versions(version_id, symbol_id, ast_fingerprint, signature_json, summary, invariants_json, side_effects_json)
       VALUES ('v1', 's1', 'fp1', NULL, NULL, NULL, NULL)`,
    );
    sqlite.exec(
      `INSERT INTO metrics(symbol_id, fan_in, fan_out, churn_30d, test_refs_json, canonical_test_json, updated_at)
       VALUES ('s1', 1, 2, 3, '[]', NULL, '${now}')`,
    );

    sqlite.close();

    await migrateSqliteToKuzu({
      sqlitePath: SQLITE_DB_PATH,
      kuzuPath: KUZU_DB_PATH,
      quiet: true,
    });

    const kuzu = await import("kuzu");
    const db = new kuzu.Database(KUZU_DB_PATH);
    const conn = new kuzu.Connection(db);

    try {
      const getCount = async (statement: string): Promise<number> => {
        const prepared = await conn.prepare(statement);
        const result = await conn.execute(prepared, {});
        const queryResult = Array.isArray(result)
          ? result[result.length - 1]
          : result;
        try {
          const rows = (await queryResult.getAll()) as Array<{ c: unknown }>;
          const c = rows[0]?.c ?? 0;
          return typeof c === "bigint" ? Number(c) : Number(c);
        } finally {
          queryResult.close();
        }
      };

      assert.strictEqual(
        await getCount("MATCH (r:Repo) RETURN COUNT(r) AS c"),
        1,
      );
      assert.strictEqual(
        await getCount("MATCH (f:File) RETURN COUNT(f) AS c"),
        1,
      );
      assert.strictEqual(
        await getCount("MATCH (s:Symbol) RETURN COUNT(s) AS c"),
        2,
      );
      assert.strictEqual(
        await getCount("MATCH ()-[d:DEPENDS_ON]->() RETURN COUNT(d) AS c"),
        1,
      );
    } finally {
      await conn.close();
      await db.close();
    }
  });
});
