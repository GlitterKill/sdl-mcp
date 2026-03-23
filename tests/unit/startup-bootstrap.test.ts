import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfigSchema } from "../../dist/config/types.js";
import { initGraphDb } from "../../dist/db/initGraphDb.js";
import { closeLadybugDb, getLadybugConn } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { ensureConfiguredReposRegistered } from "../../dist/startup/bootstrap.js";

describe("ensureConfiguredReposRegistered", () => {
  let tempDir: string;
  let repoARoot: string;
  let repoBRoot: string;
  let originalGraphDbPath: string | undefined;
  let originalDbPath: string | undefined;
  let originalGraphDbDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sdl-startup-bootstrap-"));
    repoARoot = join(tempDir, "repo-a");
    repoBRoot = join(tempDir, "repo-b");
    mkdirSync(repoARoot, { recursive: true });
    mkdirSync(repoBRoot, { recursive: true });

    originalGraphDbPath = process.env.SDL_GRAPH_DB_PATH;
    originalDbPath = process.env.SDL_DB_PATH;
    originalGraphDbDir = process.env.SDL_GRAPH_DB_DIR;
    delete process.env.SDL_GRAPH_DB_PATH;
    delete process.env.SDL_DB_PATH;
    delete process.env.SDL_GRAPH_DB_DIR;
  });

  afterEach(async () => {
    await closeLadybugDb();

    if (originalGraphDbPath === undefined) {
      delete process.env.SDL_GRAPH_DB_PATH;
    } else {
      process.env.SDL_GRAPH_DB_PATH = originalGraphDbPath;
    }
    if (originalDbPath === undefined) {
      delete process.env.SDL_DB_PATH;
    } else {
      process.env.SDL_DB_PATH = originalDbPath;
    }
    if (originalGraphDbDir === undefined) {
      delete process.env.SDL_GRAPH_DB_DIR;
    } else {
      process.env.SDL_GRAPH_DB_DIR = originalGraphDbDir;
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers configured repos in a fresh database and is idempotent", async () => {
    const config = AppConfigSchema.parse({
      repos: [
        { repoId: "repo-a", rootPath: repoARoot },
        { repoId: "repo-b", rootPath: repoBRoot },
      ],
      graphDatabase: {
        path: join(tempDir, "startup-bootstrap.lbug"),
      },
      policy: { maxWindowLines: 180, maxWindowTokens: 1400 },
    });
    const configPath = join(tempDir, "sdlmcp.config.json");

    await initGraphDb(config, configPath);

    const conn = await getLadybugConn();
    assert.strictEqual(await ladybugDb.getRepo(conn, "repo-a"), null);
    assert.strictEqual(await ladybugDb.getRepo(conn, "repo-b"), null);

    const logMessages: string[] = [];
    await ensureConfiguredReposRegistered(config, (message) => {
      logMessages.push(message);
    });

    const repoA = await ladybugDb.getRepo(conn, "repo-a");
    const repoB = await ladybugDb.getRepo(conn, "repo-b");
    assert.ok(repoA);
    assert.ok(repoB);
    assert.strictEqual(repoA.rootPath, repoARoot.replace(/\\/g, "/"));
    assert.strictEqual(repoB.rootPath, repoBRoot.replace(/\\/g, "/"));
    assert.deepStrictEqual(logMessages, [
      "Registering repository in database: repo-a",
      "Registering repository in database: repo-b",
    ]);

    logMessages.length = 0;
    await ensureConfiguredReposRegistered(config, (message) => {
      logMessages.push(message);
    });
    assert.deepStrictEqual(logMessages, []);
  });
});
