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

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { ReconcileQueue } from "../../dist/live-index/reconcile-queue.js";
import { ReconcileWorker } from "../../dist/live-index/reconcile-worker.js";

describe("background reconcile worker", () => {
  const repoId = "background-reconcile-repo";
  const dbPath = join(tmpdir(), ".lbug-background-reconcile-test-db.lbug");
  const configPath = join(
    tmpdir(),
    `sdl-background-reconcile-${Date.now()}.json`,
  );
  let repoDir = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    // Clean up both database and WAL file from previous runs
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
    if (existsSync(dbPath + ".wal")) rmSync(dbPath + ".wal", { force: true });
    repoDir = mkdtempSync(join(tmpdir(), "sdl-background-reconcile-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "consumer.ts"),
      [
        "export function consumer() {",
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
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
        },
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
    try {
      await closeLadybugDb();
      if (existsSync(dbPath)) rmSync(dbPath, { force: true });
      if (existsSync(dbPath + ".wal")) rmSync(dbPath + ".wal", { force: true });
      if (existsSync(configPath)) rmSync(configPath, { force: true });
      if (repoDir && existsSync(repoDir))
        rmSync(repoDir, { recursive: true, force: true });
    } finally {
      if (prevConfig === undefined) delete process.env.SDL_CONFIG;
      else process.env.SDL_CONFIG = prevConfig;
      if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
      else process.env.SDL_CONFIG_PATH = prevConfigPath;
    }
  });

  it("patches queued dependent files from disk in the background", async () => {
    const conn = await getLadybugConn();
    const beforeFile = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      "src/consumer.ts",
    );
    assert.ok(beforeFile);

    writeFileSync(
      join(repoDir, "src", "consumer.ts"),
      [
        "export function consumer() {",
        "  return helper();",
        "}",
        "",
        "export function helper() {",
        "  return 2;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const queue = new ReconcileQueue();
    const worker = new ReconcileWorker(queue);
    worker.enqueue(
      repoId,
      {
        touchedSymbolIds: [],
        dependentSymbolIds: [],
        dependentFilePaths: ["src/consumer.ts"],
        importedFilePaths: [],
        invalidations: ["metrics"],
      },
      "2026-03-07T12:10:00.000Z",
    );
    await worker.waitForIdle();

    const afterFile = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      "src/consumer.ts",
    );
    assert.ok(afterFile);
    assert.notStrictEqual(afterFile?.contentHash, beforeFile?.contentHash);
  });
});
