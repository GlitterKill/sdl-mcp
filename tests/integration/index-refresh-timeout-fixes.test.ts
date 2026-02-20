import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDb } from "../../src/db/db.js";
import { createRepo, getLatestVersion, listVersions } from "../../src/db/queries.js";
import { indexRepo } from "../../src/indexer/indexer.js";
import { handleIndexRefresh } from "../../src/mcp/tools/repo.js";

function cleanupRepoData(repoId: string): void {
  const db = getDb();
  db.prepare(
    "DELETE FROM symbol_versions WHERE version_id IN (SELECT version_id FROM versions WHERE repo_id = ?)",
  ).run(repoId);
  db.prepare("DELETE FROM versions WHERE repo_id = ?").run(repoId);
  db.prepare(
    "DELETE FROM metrics WHERE symbol_id IN (SELECT symbol_id FROM symbols WHERE repo_id = ?)",
  ).run(repoId);
  db.prepare("DELETE FROM edges WHERE repo_id = ?").run(repoId);
  db.prepare("DELETE FROM symbols WHERE repo_id = ?").run(repoId);
  db.prepare("DELETE FROM files WHERE repo_id = ?").run(repoId);
  db.prepare("DELETE FROM repos WHERE repo_id = ?").run(repoId);
}

describe("index.refresh timeout fixes", () => {
  let repoId = "";
  let repoRoot = "";

  beforeEach(() => {
    repoId = `test-index-refresh-timeout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    repoRoot = mkdtempSync(join(tmpdir(), "sdl-index-refresh-timeout-"));

    writeFileSync(
      join(repoRoot, "index.ts"),
      [
        "export function value(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );

    cleanupRepoData(repoId);
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

  afterEach(() => {
    cleanupRepoData(repoId);
    if (repoRoot) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reuses latest version for no-op incremental refresh", async () => {
    const full = await indexRepo(repoId, "full");
    const latestAfterFull = getLatestVersion(repoId);
    assert.ok(latestAfterFull, "expected version after full index");
    assert.strictEqual(latestAfterFull.version_id, full.versionId);
    assert.strictEqual(listVersions(repoId, 10).length, 1);

    const incremental = await indexRepo(repoId, "incremental");
    assert.strictEqual(incremental.changedFiles, 0);
    assert.strictEqual(incremental.versionId, full.versionId);
    assert.strictEqual(listVersions(repoId, 10).length, 1);
  });

  it("creates a new version for incremental refresh after file changes", async () => {
    const full = await indexRepo(repoId, "full");

    writeFileSync(
      join(repoRoot, "index.ts"),
      [
        "export function value(): number {",
        "  return 2;",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );

    const incremental = await indexRepo(repoId, "incremental");
    assert.ok(incremental.changedFiles > 0, "expected changed files after edit");
    assert.notStrictEqual(incremental.versionId, full.versionId);
    assert.strictEqual(listVersions(repoId, 10).length, 2);
  });

  it("emits MCP progress notifications when progress context is provided", async () => {
    const notifications: Array<{
      method?: string;
      params?: {
        progressToken?: string | number;
        progress?: number;
        total?: number;
      };
    }> = [];

    await handleIndexRefresh(
      {
        repoId,
        mode: "full",
      },
      {
        progressToken: "progress-1",
        signal: new AbortController().signal,
        sendNotification: async (notification) => {
          notifications.push(notification);
        },
      },
    );

    const progressNotifications = notifications.filter(
      (notification) => notification.method === "notifications/progress",
    );
    assert.ok(
      progressNotifications.length > 0,
      "expected notifications/progress events",
    );
    assert.strictEqual(
      progressNotifications[0].params?.progressToken,
      "progress-1",
    );
    assert.strictEqual(
      typeof progressNotifications[0].params?.progress,
      "number",
    );
    assert.strictEqual(typeof progressNotifications[0].params?.total, "number");
  });
});
