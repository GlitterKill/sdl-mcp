import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { getCachedSymbolMap } from "../../dist/indexer/symbol-map-cache.js";

const REPO_ID = "indexer-memory-release-repo";

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

describe("indexer memory release", () => {
  const graphDbPath = mkdtempSync(join(tmpdir(), "sdl-index-memory-test-db-"));
  const configPath = join(tmpdir(), "sdl-index-memory-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    repoDir = mkdtempSync(join(tmpdir(), "sdl-index-memory-repo-"));
    writeRepoFile(
      repoDir,
      "src/math.ts",
      [
        "export function double(value: number): number {",
        "  return value * 2;",
        "}",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "src/index.ts",
      [
        "import { double } from './math';",
        "",
        "export function run(value: number): number {",
        "  return double(value);",
        "}",
        "",
      ].join("\n"),
    );

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: { engine: "typescript", enableFileWatching: false },
          liveIndex: { enabled: false },
        },
        null,
        2,
      ),
      "utf8",
    );

    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: "2026-05-24T00:00:00.000Z",
    });
  });

  after(async () => {
    await closeLadybugDb();
    if (prevSDL_CONFIG === undefined) {
      delete process.env.SDL_CONFIG;
    } else {
      process.env.SDL_CONFIG = prevSDL_CONFIG;
    }
    if (prevSDL_CONFIG_PATH === undefined) {
      delete process.env.SDL_CONFIG_PATH;
    } else {
      process.env.SDL_CONFIG_PATH = prevSDL_CONFIG_PATH;
    }
    try {
      rmSync(graphDbPath, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(configPath, { force: true });
    } catch {}
    if (repoDir) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch {}
      repoDir = null;
    }
  });

  it("drops full-repo symbol maps before post-index phases", async () => {
    const result = await indexRepo(REPO_ID, "full");

    assert.ok(result.versionId.length > 0);
    assert.equal(
      getCachedSymbolMap(REPO_ID),
      undefined,
      "indexRepo should not retain the full-repo symbol map after pass 2",
    );
  });
});
