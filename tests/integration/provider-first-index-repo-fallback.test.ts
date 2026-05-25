import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";

describe("provider-first indexRepo fallback", () => {
  const previousConfig = process.env.SDL_CONFIG;
  const previousConfigPath = process.env.SDL_CONFIG_PATH;
  let graphDbPath = "";
  let repoDir = "";
  let configPath = "";

  afterEach(async () => {
    await closeLadybugDb();
    invalidateConfigCache();
    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = previousConfigPath;
    for (const path of [graphDbPath, repoDir, configPath]) {
      if (path && existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    graphDbPath = "";
    repoDir = "";
    configPath = "";
  });

  it("uses legacy fallback in auto mode while provider-first activation is gated", async () => {
    const repoId = await initIndexedRepo("auto");

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirst?.selectedPipeline, "providerFirst");
    assert.equal(result.providerFirstExecution?.status, "fallback");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /shadow.*activation/i,
    );
    assert.ok(result.symbolsIndexed > 0);

    const conn = await getLadybugConn();
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, "src/index.ts");
    assert.ok(file);
  });

  it("fails explicit providerFirst before unsafe active DB replacement", async () => {
    const repoId = await initIndexedRepo("providerFirst");

    await assert.rejects(
      () => indexRepo(repoId, "full"),
      /shadow.*activation/i,
    );
  });

  async function initIndexedRepo(
    pipeline: "auto" | "providerFirst",
  ): Promise<string> {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-index-db-"));
    repoDir = mkdtempSync(join(tmpdir(), "sdl-provider-first-index-repo-"));
    configPath = join(
      tmpdir(),
      `sdl-provider-first-index-${pipeline}-${Date.now()}.json`,
    );
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "index.ts"),
      [
        "export function main() {",
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
          indexing: {
            pipeline,
            engine: "typescript",
            enableFileWatching: false,
          },
          semantic: {
            generateSummaries: false,
          },
          scip: {
            enabled: true,
            indexes: [{ path: "missing.scip" }],
            generator: {
              enabled: false,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;
    invalidateConfigCache();

    await initLadybugDb(graphDbPath);
    const repoId = `provider-first-${pipeline}`;
    await withWriteConn(async (conn) => {
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
        createdAt: "2026-05-25T12:00:00.000Z",
      });
    });
    return repoId;
  }
});
