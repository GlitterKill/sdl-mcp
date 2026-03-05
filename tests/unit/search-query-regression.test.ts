import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

function runSearchScript(mode: "full" | "lite") {
  const script = `
    import { join } from "node:path";
    import { existsSync, mkdirSync, rmSync } from "node:fs";
    import { initKuzuDb, closeKuzuDb, getKuzuConn } from "./dist/db/kuzu.js";
    import * as kuzuDb from "./dist/db/kuzu-queries.js";

    const testDir = join(process.cwd(), "tmp-search-regression-${mode}");
    const graphDbPath = join(testDir, "graph");
    const repoId = "test-repo";
    const now = new Date().toISOString();

    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    await closeKuzuDb();
    await initKuzuDb(graphDbPath);
    const conn = await getKuzuConn();

    await kuzuDb.upsertRepo(conn, { repoId, rootPath: "/fake/repo", configJson: "{}", createdAt: now });
    await kuzuDb.upsertFile(conn, {
      fileId: "file1",
      repoId,
      relPath: "src/api.ts",
      contentHash: "hash1",
      language: "ts",
      byteSize: 128,
      lastIndexedAt: now,
      directory: "src",
    });
    await kuzuDb.upsertSymbol(conn, {
      symbolId: "sym-api",
      repoId,
      fileId: "file1",
      kind: "function",
      name: "apiHandler",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 3,
      rangeEndCol: 1,
      astFingerprint: "fp-api",
      signatureJson: "{}",
      summary: "Handles api requests",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });

    const rows = ${
      mode === "full"
        ? 'await kuzuDb.searchSymbols(conn, repoId, "api", 10);'
        : 'await kuzuDb.searchSymbolsLite(conn, repoId, "api", 10);'
    }
    console.log(rows.length);
    await closeKuzuDb();
  `;

  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("search query regressions", () => {
  it("runs full symbol search without crashing the process", () => {
    const result = runSearchScript("full");

    assert.strictEqual(
      result.status,
      0,
      `Expected full symbol search to succeed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  });

  it("runs lite symbol search without crashing the process", () => {
    const result = runSearchScript("lite");

    assert.strictEqual(
      result.status,
      0,
      `Expected lite symbol search to succeed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  });
});
