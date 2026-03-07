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

import { closeKuzuDb, getKuzuConn, initKuzuDb } from "../../src/db/kuzu.js";
import * as kuzuDb from "../../src/db/kuzu-queries.js";
import { indexRepo } from "../../src/indexer/indexer.js";
import {
  routeLiveIndexApiRequest,
  type LiveIndexApiRequest,
} from "../../src/cli/transport/http.js";
import { handleBufferPush } from "../../src/mcp/tools/buffer.js";
import {
  getDefaultOverlayStore,
  resetDefaultLiveIndexCoordinator,
  waitForDefaultLiveIndexIdle,
} from "../../src/live-index/coordinator.js";

describe("explicit checkpoint API", () => {
  const repoId = "explicit-checkpoint-repo";
  const dbPath = join(tmpdir(), ".kuzu-explicit-checkpoint-test-db.kuzu");
  const configPath = join(tmpdir(), `sdl-explicit-checkpoint-${Date.now()}.json`);
  let repoDir = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), "sdl-explicit-checkpoint-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "example.ts"),
      ["export function original() {", "  return 1;", "}"].join("\n"),
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

    await closeKuzuDb();
    await initKuzuDb(dbPath);
    const conn = await getKuzuConn();
    await kuzuDb.upsertRepo(conn, {
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
    await closeKuzuDb();
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (repoDir && existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("flushes clean overlay entries through the checkpoint API", async () => {
    await handleBufferPush({
      repoId,
      eventType: "open",
      filePath: "src/example.ts",
      content: ["export function renamed() {", "  return 2;", "}"].join("\n"),
      language: "typescript",
      version: 2,
      dirty: false,
      timestamp: "2026-03-07T12:10:00.000Z",
    });
    await waitForDefaultLiveIndexIdle();

    const response = await routeLiveIndexApiRequest(
      {
        method: "POST",
        pathname: `/api/repo/${repoId}/checkpoint`,
        body: { reason: "manual" },
      } satisfies LiveIndexApiRequest,
    );

    assert.ok(response);
    assert.strictEqual(response?.status, 202);
    assert.partialDeepStrictEqual(response?.payload, {
      repoId,
      requested: true,
      checkpointedFiles: 1,
      failedFiles: 0,
      pendingBuffers: 0,
    });
    assert.strictEqual(
      getDefaultOverlayStore().getDraft(repoId, "src/example.ts"),
      null,
    );

    const conn = await getKuzuConn();
    const file = await kuzuDb.getFileByRepoPath(conn, repoId, "src/example.ts");
    assert.ok(file);
    const symbols = await kuzuDb.getSymbolsByFile(conn, file!.fileId);
    assert.deepStrictEqual(symbols.map((symbol) => symbol.name), ["renamed"]);
  });
});
