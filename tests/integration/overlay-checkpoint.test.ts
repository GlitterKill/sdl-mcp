import { after, before, beforeEach, describe, it } from "node:test";
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

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { handleBufferPush, handleBufferStatus } from "../../dist/mcp/tools/buffer.js";
import {
  getDefaultLiveIndexCoordinator,
  getDefaultOverlayStore,
  resetDefaultLiveIndexCoordinator,
  waitForDefaultLiveIndexIdle,
} from "../../dist/live-index/coordinator.js";

describe("overlay checkpoint on save", () => {
  const repoId = "overlay-checkpoint-repo";
  const dbPath = join(tmpdir(), ".lbug-overlay-checkpoint-test-db.lbug");
  const configPath = join(tmpdir(), `sdl-overlay-checkpoint-${Date.now()}.json`);
  let repoDir = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    rmSync(dbPath + ".sdl-lineage.json", { recursive: true, force: true });
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), "sdl-overlay-checkpoint-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "example.ts"),
      ["export function current() {", "  return 1;", "}"].join("\n"),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          // Exercise the recorded parser without requiring external SCIP tooling.
          scip: { enabled: false },
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
      createdAt: "2026-03-07T12:00:00.000Z",
    });
    await indexRepo(repoId, "full");
  });

  beforeEach(() => {
    resetDefaultLiveIndexCoordinator();
  });

  after(async () => {
    resetDefaultLiveIndexCoordinator();
    await closeLadybugDb();
    rmSync(dbPath + ".sdl-lineage.json", { recursive: true, force: true });
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (repoDir && existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("compacts clean overlay state after save while keeping durable ladybug updated", async () => {
    const content = ["export function current() {", "  return 2;", "}"].join("\n");
    // Save events acknowledge disk writes; checkpointing retires the overlay.
    writeFileSync(join(repoDir, "src/example.ts"), content, "utf8");
    await handleBufferPush({
      repoId,
      eventType: "save",
      filePath: "src/example.ts",
      content,
      language: "typescript",
      version: 2,
      dirty: false,
      timestamp: "2026-03-07T12:10:00.000Z",
    });
    await waitForDefaultLiveIndexIdle();
    const checkpoint = await getDefaultLiveIndexCoordinator().checkpointRepo({
      repoId,
      reason: "manual",
    });
    assert.strictEqual(checkpoint.checkpointedFiles, 1);
    assert.strictEqual(checkpoint.failedFiles, 0);

    assert.strictEqual(
      getDefaultOverlayStore().getDraft(repoId, "src/example.ts"),
      null,
    );

    const liveStatus = await handleBufferStatus({ repoId });
    assert.strictEqual(liveStatus.pendingBuffers, 0);
    assert.strictEqual(liveStatus.checkpointPending, false);
    assert.strictEqual(liveStatus.lastCheckpointResult, "success");

    const conn = await getLadybugConn();
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, "src/example.ts");
    assert.ok(file);
    const symbols = await ladybugDb.getSymbolsByFile(conn, file!.fileId);
    assert.deepStrictEqual(symbols.map((symbol) => symbol.name), ["current"]);
  });
});
