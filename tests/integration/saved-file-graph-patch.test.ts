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
import { handleBufferPush } from "../../dist/mcp/tools/buffer.js";
import {
  resetDefaultLiveIndexCoordinator,
  waitForDefaultLiveIndexIdle,
} from "../../dist/live-index/coordinator.js";

describe("saved file graph patch", () => {
  const repoId = "saved-file-graph-patch-repo";
  const dbPath = join(tmpdir(), ".lbug-saved-file-graph-patch-test-db.lbug");
  const configPath = join(tmpdir(), `sdl-saved-file-patch-${Date.now()}.json`);
  let repoDir = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), "sdl-saved-file-patch-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "example.ts"),
      [
        "export function alpha() {",
        "  return beta();",
        "}",
        "",
        "export function beta() {",
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

  beforeEach(() => {
    resetDefaultLiveIndexCoordinator();
  });

  after(async () => {
    resetDefaultLiveIndexCoordinator();
    await closeLadybugDb();
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (repoDir && existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("updates durable ladybug state on save without repo-wide reindex", async () => {
    await handleBufferPush({
      repoId,
      eventType: "save",
      filePath: "src/example.ts",
      content: [
        "export function alpha() {",
        "  return gamma();",
        "}",
        "",
        "export function gamma() {",
        "  return 2;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 2,
      dirty: false,
      timestamp: "2026-03-07T12:10:00.000Z",
    });
    await waitForDefaultLiveIndexIdle();

    const conn = await getLadybugConn();
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, "src/example.ts");
    assert.ok(file);
    const symbols = await ladybugDb.getSymbolsByFile(conn, file!.fileId);
    const names = symbols.map((symbol) => symbol.name).sort();
    assert.deepStrictEqual(names, ["alpha", "gamma"]);
  });
});
