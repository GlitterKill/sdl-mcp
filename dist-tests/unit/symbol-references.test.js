import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { getDb } from "../../dist/db/db.js";
import { runMigrations } from "../../dist/db/migrations.js";
import { insertSymbolReference, getTestRefsForSymbol, deleteSymbolReferencesByFileId, } from "../../dist/db/queries.js";
describe("Symbol References (Inverted Index)", () => {
    const repoId = "test-symref-repo";
    let fileId1;
    let fileId2;
    before(() => {
        const db = getDb();
        // Ensure database tables exist by running migrations
        runMigrations(db);
        // Cleanup from previous runs
        try {
            db.exec(`DELETE FROM symbol_references WHERE repo_id = '${repoId}'`);
            db.exec(`DELETE FROM files WHERE repo_id = '${repoId}'`);
            db.exec(`DELETE FROM repos WHERE repo_id = '${repoId}'`);
        }
        catch (error) {
            console.warn("Cleanup error (non-fatal):", error);
        }
        // Create repo
        db.exec(`
      INSERT INTO repos (repo_id, root_path, config_json, created_at)
      VALUES ('${repoId}', '/tmp/test-symref', '{}', datetime('now'))
    `);
        // Create files and get their IDs
        db.exec(`
      INSERT INTO files (repo_id, rel_path, content_hash, language, byte_size, last_indexed_at, directory)
      VALUES ('${repoId}', 'test/file.test.ts', 'hash1', 'ts', 100, datetime('now'), 'test')
    `);
        const file1 = db.prepare("SELECT file_id FROM files WHERE repo_id = ? AND rel_path = ?").get(repoId, 'test/file.test.ts');
        fileId1 = file1.file_id;
        db.exec(`
      INSERT INTO files (repo_id, rel_path, content_hash, language, byte_size, last_indexed_at, directory)
      VALUES ('${repoId}', 'test/other.test.ts', 'hash2', 'ts', 200, datetime('now'), 'test')
    `);
        const file2 = db.prepare("SELECT file_id FROM files WHERE repo_id = ? AND rel_path = ?").get(repoId, 'test/other.test.ts');
        fileId2 = file2.file_id;
    });
    after(() => {
        const db = getDb();
        try {
            db.exec(`DELETE FROM symbol_references WHERE repo_id = '${repoId}'`);
            db.exec(`DELETE FROM files WHERE repo_id = '${repoId}'`);
            db.exec(`DELETE FROM repos WHERE repo_id = '${repoId}'`);
        }
        catch (error) {
            console.warn("Cleanup error (non-fatal):", error);
        }
    });
    it("should insert and retrieve symbol references", () => {
        insertSymbolReference({
            repo_id: repoId,
            symbol_name: "testFunction",
            file_id: fileId1,
            line_number: 10,
            created_at: new Date().toISOString(),
        });
        insertSymbolReference({
            repo_id: repoId,
            symbol_name: "testFunction",
            file_id: fileId2,
            line_number: 20,
            created_at: new Date().toISOString(),
        });
        const refs = getTestRefsForSymbol(repoId, "testFunction");
        assert.strictEqual(refs.length, 2);
        assert.ok(refs.includes("test/file.test.ts"));
        assert.ok(refs.includes("test/other.test.ts"));
    });
    it("should return empty array for non-existent symbol", () => {
        const refs = getTestRefsForSymbol(repoId, "nonExistent");
        assert.strictEqual(refs.length, 0);
        assert.deepStrictEqual(refs, []);
    });
    it("should delete references by file ID", () => {
        insertSymbolReference({
            repo_id: repoId,
            symbol_name: "tempSymbol",
            file_id: fileId1,
            line_number: null,
            created_at: new Date().toISOString(),
        });
        let refs = getTestRefsForSymbol(repoId, "tempSymbol");
        assert.strictEqual(refs.length, 1);
        deleteSymbolReferencesByFileId(fileId1);
        refs = getTestRefsForSymbol(repoId, "tempSymbol");
        assert.strictEqual(refs.length, 0);
    });
    it("should handle duplicate symbol names correctly", () => {
        insertSymbolReference({
            repo_id: repoId,
            symbol_name: "duplicateSymbol",
            file_id: fileId1,
            line_number: 5,
            created_at: new Date().toISOString(),
        });
        insertSymbolReference({
            repo_id: repoId,
            symbol_name: "duplicateSymbol",
            file_id: fileId2,
            line_number: 15,
            created_at: new Date().toISOString(),
        });
        const refs = getTestRefsForSymbol(repoId, "duplicateSymbol");
        assert.strictEqual(refs.length, 2);
    });
});
//# sourceMappingURL=symbol-references.test.js.map