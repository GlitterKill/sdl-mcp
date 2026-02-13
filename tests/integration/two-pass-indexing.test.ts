import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexRepo } from "../../src/indexer/indexer.js";
import { getDb } from "../../src/db/db.js";
import { createRepo, getEdgesByRepo } from "../../src/db/queries.js";

describe("two-pass indexing", () => {
  const repoId = "test-two-pass-indexing";
  let repoRoot = "";

  const cleanupRepoData = (): void => {
    const db = getDb();
    db.exec(
      `DELETE FROM symbol_versions WHERE version_id IN (SELECT version_id FROM versions WHERE repo_id='${repoId}')`,
    );
    db.exec(`DELETE FROM versions WHERE repo_id='${repoId}'`);
    db.exec(
      `DELETE FROM metrics WHERE symbol_id IN (SELECT symbol_id FROM symbols WHERE repo_id='${repoId}')`,
    );
    db.exec(`DELETE FROM edges WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM symbols WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM files WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM repos WHERE repo_id='${repoId}'`);
  };

  before(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "sdl-two-pass-"));
    writeFileSync(
      join(repoRoot, "a.ts"),
      [
        "import { b } from './b';",
        "export function a() {",
        "  return b();",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(repoRoot, "b.ts"),
      [
        "export function b() {",
        "  return 42;",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );

    cleanupRepoData();

    createRepo({
      repo_id: repoId,
      root_path: repoRoot,
      config_json: JSON.stringify({
        repoId,
        rootPath: repoRoot,
        ignore: ["**/node_modules/**"],
        languages: ["ts", "tsx", "js", "jsx"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
      }),
      created_at: new Date().toISOString(),
    });
  });

  after(() => {
    cleanupRepoData();
    if (repoRoot) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports explicit pass1 and pass2 progress for TypeScript repos", async () => {
    const stages: string[] = [];

    await indexRepo(repoId, "full", (progress) => {
      stages.push(progress.stage);
    });

    assert.ok(stages.includes("pass1"), "expected pass1 stage");
    assert.ok(stages.includes("pass2"), "expected pass2 stage");

    const callEdges = getEdgesByRepo(repoId).filter((edge) => edge.type === "call");
    assert.ok(callEdges.length > 0, "expected call edges after two-pass indexing");
  });
});
