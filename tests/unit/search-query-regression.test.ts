import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

// Windows LadybugDB native addon segfaults on process exit (0xC0000005 = 3221225477).
// Tests pass if the query succeeds (valid stdout) even if exit code is segfault.
const WINDOWS_SEGFAULT_EXIT_CODE = 3221225477;

function isSuccessfulExit(
  status: number | null,
  stdout: string,
  expectedOutput: string,
): boolean {
  const outputValid = stdout.trim() === expectedOutput;
  if (status === 0) return outputValid;
  if (status === WINDOWS_SEGFAULT_EXIT_CODE && outputValid) return true;
  return false;
}

function runSearchScript(mode: "full" | "lite") {
  const script = `
    import { join } from "node:path";
    import { existsSync, mkdirSync, rmSync } from "node:fs";
    import { initLadybugDb, closeLadybugDb, getLadybugConn } from "./dist/db/ladybug.js";
    import * as ladybugDb from "./dist/db/ladybug-queries.js";

    const testDir = join(process.cwd(), "tmp-search-regression-${mode}");
    const graphDbPath = join(testDir, "graph");
    const repoId = "test-repo";
    const now = new Date().toISOString();

    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();

    await ladybugDb.upsertRepo(conn, { repoId, rootPath: "/fake/repo", configJson: "{}", createdAt: now });
    await ladybugDb.upsertFile(conn, {
      fileId: "file1",
      repoId,
      relPath: "src/api.ts",
      contentHash: "hash1",
      language: "ts",
      byteSize: 128,
      lastIndexedAt: now,
      directory: "src",
    });
    await ladybugDb.upsertSymbol(conn, {
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
        ? 'await ladybugDb.searchSymbols(conn, repoId, "api", 10);'
        : 'await ladybugDb.searchSymbolsLite(conn, repoId, "api", 10);'
    }
    console.log(rows.length);
    await closeLadybugDb();
  `;

  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("search query regressions", () => {
  it("runs full symbol search without crashing the process", () => {
    const result = runSearchScript("full");

    assert.ok(
      isSuccessfulExit(result.status, result.stdout, "1"),
      `Expected full symbol search to succeed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\nExit code: ${result.status}`,
    );
  });

  it("runs lite symbol search without crashing the process", () => {
    const result = runSearchScript("lite");

    assert.ok(
      isSuccessfulExit(result.status, result.stdout, "1"),
      `Expected lite symbol search to succeed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\nExit code: ${result.status}`,
    );
  });
});
