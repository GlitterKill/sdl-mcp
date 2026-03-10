import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

function runFeedbackQueryScript(queryMode: "repo" | "version") {
  const script = `
    import { join } from "node:path";
    import { existsSync, mkdirSync, rmSync } from "node:fs";
    import { initLadybugDb, closeLadybugDb, getLadybugConn } from "./dist/db/ladybug.js";
    import * as ladybugDb from "./dist/db/ladybug-queries.js";

    const testDir = join(process.cwd(), "tmp-agent-feedback-regression-${queryMode}");
    const graphDbPath = join(testDir, "graph");
    const repoId = "test-repo";
    const versionId = "v1";

    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, { repoId, rootPath: "/fake/repo", configJson: "{}", createdAt: now });
    await ladybugDb.createVersion(conn, {
      versionId,
      repoId,
      createdAt: now,
      reason: "test-version",
      prevVersionHash: null,
      versionHash: null,
    });
    await ladybugDb.upsertAgentFeedback(conn, {
      feedbackId: "fb1",
      repoId,
      versionId,
      sliceHandle: "slice1",
      usefulSymbolsJson: "[\\"sym1\\"]",
      missingSymbolsJson: "[]",
      taskTagsJson: null,
      taskType: "debug",
      taskText: null,
      createdAt: now,
    });

    const rows = ${
      queryMode === "repo"
        ? "await ladybugDb.getAgentFeedbackByRepo(conn, repoId, 10);"
        : "await ladybugDb.getAgentFeedbackByVersion(conn, repoId, versionId, 10);"
    }
    console.log(rows.length);
    await closeLadybugDb();
  `;

  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("agent feedback query regressions", () => {
  it("reads repo-scoped feedback rows without crashing the process", () => {
    const result = runFeedbackQueryScript("repo");

    assert.strictEqual(
      result.status,
      0,
      `Expected repo feedback query to succeed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  });

  it("reads version-scoped feedback rows without crashing the process", () => {
    const result = runFeedbackQueryScript("version");

    assert.strictEqual(
      result.status,
      0,
      `Expected version feedback query to succeed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  });
});
