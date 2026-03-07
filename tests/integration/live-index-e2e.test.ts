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

import { closeKuzuDb, initKuzuDb } from "../../src/db/kuzu.js";
import { indexRepo } from "../../src/indexer/indexer.js";
import { handleBufferPush, handleBufferStatus } from "../../src/mcp/tools/buffer.js";
import { handleSymbolSearch } from "../../src/mcp/tools/symbol.js";
import {
  getDefaultOverlayStore,
  resetDefaultLiveIndexCoordinator,
  waitForDefaultLiveIndexIdle,
} from "../../src/live-index/coordinator.js";
import * as kuzuDb from "../../src/db/kuzu-queries.js";
import { getKuzuConn } from "../../src/db/kuzu.js";

describe("live index end-to-end flow", () => {
  const repoId = "live-index-e2e-repo";
  const dbPath = join(tmpdir(), ".kuzu-live-index-e2e-test-db.kuzu");
  const configPath = join(tmpdir(), `sdl-live-index-e2e-${Date.now()}.json`);
  let repoDir = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), "sdl-live-index-e2e-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "example.ts"),
      [
        "export function originalName() {",
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
          liveIndex: {
            enabled: true,
            debounceMs: 75,
            idleCheckpointMs: 15_000,
            maxDraftFiles: 200,
            reconcileConcurrency: 1,
            clusterRefreshThreshold: 25,
          },
        },
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

  it("serves draft-aware reads immediately and leaves durable reads correct after save checkpoint", async () => {
    await handleBufferPush({
      repoId,
      eventType: "change",
      filePath: "src/example.ts",
      content: [
        "export function renamedName() {",
        "  return 2;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 2,
      dirty: true,
      timestamp: "2026-03-07T12:10:00.000Z",
    });
    await waitForDefaultLiveIndexIdle();

    const draftSearch = await handleSymbolSearch({
      repoId,
      query: "renamedName",
      limit: 10,
    });
    assert.ok(draftSearch.results.some((result) => result.name === "renamedName"));

    await handleBufferPush({
      repoId,
      eventType: "save",
      filePath: "src/example.ts",
      content: [
        "export function renamedName() {",
        "  return 2;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 3,
      dirty: false,
      timestamp: "2026-03-07T12:11:00.000Z",
    });
    await waitForDefaultLiveIndexIdle();

    assert.strictEqual(
      getDefaultOverlayStore().getDraft(repoId, "src/example.ts"),
      null,
    );

    const durableSearch = await handleSymbolSearch({
      repoId,
      query: "renamedName",
      limit: 10,
    });
    assert.ok(durableSearch.results.some((result) => result.name === "renamedName"));

    const liveStatus = await handleBufferStatus({ repoId });
    assert.strictEqual(liveStatus.pendingBuffers, 0);
    assert.strictEqual(liveStatus.lastCheckpointResult, "success");
    assert.ok(liveStatus.lastReconciledAt);
  });
});
