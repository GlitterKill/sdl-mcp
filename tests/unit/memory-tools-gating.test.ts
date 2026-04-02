import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests that memory tool handlers respect the memory config gating.
 * When memory is disabled in config, all 4 handlers should throw ConfigError.
 */
describe("memory tools config gating", () => {
  let tmpDir: string;
  let graphDbPath: string;
  let configPath: string;
  let origConfig: string | undefined;
  let origDbPath: string | undefined;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sdl-mem-gate-"));
    graphDbPath = join(tmpDir, "db");
    mkdirSync(graphDbPath, { recursive: true });

    // Create config with memory disabled
    configPath = join(tmpDir, "sdlmcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ repoId: "test-repo", rootPath: tmpDir }],
        policy: {},
        memory: { enabled: false },
      }),
    );

    origConfig = process.env.SDL_CONFIG;
    origDbPath = process.env.SDL_GRAPH_DB_PATH;
    process.env.SDL_CONFIG = configPath;
    process.env.SDL_GRAPH_DB_PATH = graphDbPath;

    // Invalidate cached config so loadConfig() picks up our test config
    const { invalidateConfigCache } = await import(
      "../../dist/config/loadConfig.js"
    );
    invalidateConfigCache();

    const { closeLadybugDb, initLadybugDb } = await import(
      "../../dist/db/ladybug.js"
    );
    await closeLadybugDb();
    await initLadybugDb(graphDbPath);

    // Register the test repo in the DB
    const { getLadybugConn } = await import("../../dist/db/ladybug.js");
    const ladybugDb = await import("../../dist/db/ladybug-queries.js");
    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId: "test-repo",
      rootPath: tmpDir,
      configJson: "{}",
      createdAt: new Date().toISOString(),
    });
  });

  after(async () => {
    const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
    await closeLadybugDb();

    // Restore env
    if (origConfig !== undefined) {
      process.env.SDL_CONFIG = origConfig;
    } else {
      delete process.env.SDL_CONFIG;
    }
    if (origDbPath !== undefined) {
      process.env.SDL_GRAPH_DB_PATH = origDbPath;
    } else {
      delete process.env.SDL_GRAPH_DB_PATH;
    }

    // Invalidate again to clean up
    const { invalidateConfigCache } = await import(
      "../../dist/config/loadConfig.js"
    );
    invalidateConfigCache();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handleMemoryStore throws ConfigError when memory disabled", async () => {
    const { handleMemoryStore } = await import(
      "../../dist/mcp/tools/memory.js"
    );
    await assert.rejects(
      () =>
        handleMemoryStore({
          repoId: "test-repo",
          type: "decision",
          title: "test",
          content: "test",
        }),
      (err: Error) =>
        err.constructor.name === "ConfigError" ||
        err.message.includes("disabled"),
    );
  });

  it("handleMemoryQuery throws ConfigError when memory disabled", async () => {
    const { handleMemoryQuery } = await import(
      "../../dist/mcp/tools/memory.js"
    );
    await assert.rejects(
      () => handleMemoryQuery({ repoId: "test-repo" }),
      (err: Error) =>
        err.constructor.name === "ConfigError" ||
        err.message.includes("disabled"),
    );
  });

  it("handleMemoryRemove throws ConfigError when memory disabled", async () => {
    const { handleMemoryRemove } = await import(
      "../../dist/mcp/tools/memory.js"
    );
    await assert.rejects(
      () =>
        handleMemoryRemove({ repoId: "test-repo", memoryId: "fake-id" }),
      (err: Error) =>
        err.constructor.name === "ConfigError" ||
        err.message.includes("disabled"),
    );
  });

  it("handleMemorySurface throws ConfigError when memory disabled", async () => {
    const { handleMemorySurface } = await import(
      "../../dist/mcp/tools/memory.js"
    );
    await assert.rejects(
      () => handleMemorySurface({ repoId: "test-repo" }),
      (err: Error) =>
        err.constructor.name === "ConfigError" ||
        err.message.includes("disabled"),
    );
  });
});
