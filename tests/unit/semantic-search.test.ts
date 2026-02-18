import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import {
  createRepo,
  getFileByRepoPath,
  upsertFile,
  upsertSymbolTransaction,
} from "../../src/db/queries.js";
import { getDb } from "../../src/db/db.js";
import { hashContent } from "../../src/util/hashing.js";
import {
  refreshSymbolEmbeddings,
  rerankByEmbeddings,
} from "../../src/indexer/embeddings.js";

describe("semantic search reranking", () => {
  const repoId = "test-semantic-search";
  const userSymbolId = `${repoId}:searchUser`;
  const fsSymbolId = `${repoId}:openFile`;

  function cleanupRepoRows(): void {
    const db = getDb();
    const hasEmbeddingsTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get("symbol_embeddings");
    if (hasEmbeddingsTable) {
      db.exec("DELETE FROM symbol_embeddings");
    }
    db.exec(`DELETE FROM edges WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM symbols WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM files WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM repos WHERE repo_id='${repoId}'`);
  }

  before(() => {
    cleanupRepoRows();
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_embeddings (
        symbol_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        embedding_vector BLOB NOT NULL,
        version TEXT NOT NULL,
        card_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    createRepo({
      repo_id: repoId,
      root_path: ".",
      config_json: JSON.stringify({
        repoId,
        rootPath: ".",
        languages: ["ts"],
        ignore: ["**/node_modules/**"],
      }),
      created_at: new Date().toISOString(),
    });

    upsertFile({
      repo_id: repoId,
      rel_path: "src/search.ts",
      content_hash: hashContent("search"),
      language: "ts",
      byte_size: 100,
      last_indexed_at: new Date().toISOString(),
    });
    const file = getFileByRepoPath(repoId, "src/search.ts");
    assert.ok(file);

    upsertSymbolTransaction({
      symbol_id: userSymbolId,
      repo_id: repoId,
      file_id: file!.file_id,
      kind: "function",
      name: "searchUser",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 1,
      range_end_col: 10,
      ast_fingerprint: "fp-user",
      signature_json: null,
      summary: "Search user records by keyword and ranking",
      invariants_json: null,
      side_effects_json: null,
      updated_at: new Date().toISOString(),
    });

    upsertSymbolTransaction({
      symbol_id: fsSymbolId,
      repo_id: repoId,
      file_id: file!.file_id,
      kind: "function",
      name: "openFile",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 2,
      range_start_col: 0,
      range_end_line: 2,
      range_end_col: 10,
      ast_fingerprint: "fp-file",
      signature_json: null,
      summary: "Open local file stream and parse bytes",
      invariants_json: null,
      side_effects_json: null,
      updated_at: new Date().toISOString(),
    });
  });

  after(() => {
    cleanupRepoRows();
  });

  it("prefers semantically aligned symbols after reranking", async () => {
    const allSymbols = getDb()
      .prepare("SELECT * FROM symbols WHERE repo_id = ?")
      .all(repoId) as Array<any>;

    await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "all-MiniLM-L6-v2",
      symbols: allSymbols,
    });

    const reranked = await rerankByEmbeddings({
      query: "user search ranking",
      symbols: allSymbols.map((symbol, idx) => ({
        symbol,
        lexicalScore: idx === 0 ? 0.5 : 0.5,
      })),
      provider: "mock",
      alpha: 0.4,
      model: "all-MiniLM-L6-v2",
    });

    assert.ok(reranked.length >= 2);
    assert.strictEqual(reranked[0].symbol.symbol_id, userSymbolId);
  });
});
