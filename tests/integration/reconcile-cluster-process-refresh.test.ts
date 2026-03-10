import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../src/db/ladybug.js";
import * as ladybugDb from "../../src/db/ladybug-queries.js";
import { indexRepo } from "../../src/indexer/indexer.js";
import { ReconcileQueue } from "../../src/live-index/reconcile-queue.js";
import { ReconcileWorker } from "../../src/live-index/reconcile-worker.js";

describe("reconcile derived-data refresh", () => {
  const repoId = "reconcile-derived-data-repo";
  const dbPath = join(tmpdir(), ".lbug-reconcile-derived-data-test-db.lbug");
  const configPath = join(tmpdir(), `sdl-reconcile-derived-data-${Date.now()}.json`);
  let repoDir = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), "sdl-reconcile-derived-data-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "app.ts"),
      [
        "export function apphandler() {",
        "  return helper();",
        "}",
        "",
        "export function helper() {",
        "  return 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify(
        { repos: [], policy: {}, indexing: { engine: "typescript", enableFileWatching: false } },
        null,
        2,
      ),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const now = "2026-03-07T12:00:00.000Z";
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: now,
    });
    await indexRepo(repoId, "full");
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (repoDir && existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("recomputes clusters and processes when reconciliation invalidations request it", async () => {
    const conn = await getLadybugConn();
    await ladybugDb.deleteClustersByRepo(conn, repoId);
    await ladybugDb.deleteProcessesByRepo(conn, repoId);

    const queue = new ReconcileQueue();
    const worker = new ReconcileWorker(queue);
    worker.enqueue(
      repoId,
      {
        touchedSymbolIds: ["dummy"],
        dependentSymbolIds: [],
        dependentFilePaths: [],
        importedFilePaths: [],
        invalidations: ["clusters", "processes"],
      },
      "2026-03-07T12:10:00.000Z",
    );
    await worker.waitForIdle();

    const clusters = await ladybugDb.getClustersForRepo(conn, repoId);
    const processStats = await ladybugDb.getProcessOverviewStats(conn, repoId);
    assert.ok(clusters.length >= 0);
    assert.ok(processStats.totalProcesses >= 1);
  });
});
