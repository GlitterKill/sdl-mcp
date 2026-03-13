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
} from "../../src/db/ladybug.js";
import * as ladybugDb from "../../src/db/ladybug-queries.js";
import { indexRepo } from "../../src/indexer/indexer.js";
import { CPass2Resolver } from "../../src/indexer/pass2/resolvers/c-pass2-resolver.js";

const REPO_ID = "test-c-pass2-repo";

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

describe("C pass2 indexing", () => {
  const graphDbPath = join(tmpdir(), ".lbug-c-pass2-test-db.lbug");
  const configPath = join(tmpdir(), "sdl-c-pass2-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-c-pass2-repo-"));
    writeRepoFile(
      repoDir,
      "include/utils.h",
      ["int helper(void);", ""].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "src/utils.c",
      ['#include "utils.h"', "int helper(void) { return 42; }", ""].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "src/main.c",
      ['#include "utils.h"', "int main(void) { return helper(); }", ""].join(
        "\n",
      ),
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
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();
    const now = new Date().toISOString();
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
        ignore: [],
        languages: ["c"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
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
      rmSync(configPath, { recursive: true, force: true });
    } catch {}
    if (repoDir) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch {}
      repoDir = null;
    }
  });

  it("creates pass2-c call edges with pass2 metadata", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);
    const globalNameToSymbolIds = new Map<string, string[]>();
    for (const symbol of symbols) {
      const byName = globalNameToSymbolIds.get(symbol.name) ?? [];
      byName.push(symbol.symbolId);
      globalNameToSymbolIds.set(symbol.name, byName);
    }

    const resolver = new CPass2Resolver();
    const resolveResult = await resolver.resolve(
      {
        repoId: REPO_ID,
        filePath: "src/main.c",
        extension: ".c",
        language: "c",
      },
      {
        repoRoot: repoDir as string,
        symbolIndex: new Map(),
        tsResolver: null,
        languages: ["c"],
        createdCallEdges: new Set<string>(),
        globalNameToSymbolIds,
      },
    );
    assert.ok(resolveResult.edgesCreated > 0);

    const mainSymbol = symbols.find(
      (s) => s.name === "main" && s.kind === "function",
    );
    assert.ok(mainSymbol, "main function symbol not found");

    const helperSymbolIds = new Set(
      symbols
        .filter((s) => s.name === "helper" && s.kind === "function")
        .map((s) => s.symbolId),
    );
    assert.ok(helperSymbolIds.size > 0, "helper function symbol(s) not found");

    const mainEdges = await ladybugDb.getEdgesFrom(conn, mainSymbol.symbolId);
    const helperCall = mainEdges.find(
      (edge) =>
        edge.edgeType === "call" && helperSymbolIds.has(edge.toSymbolId),
    );
    assert.ok(helperCall, "call edge from main to helper not found");
    assert.equal(helperCall.resolverId, "pass2-c");
    assert.equal(helperCall.resolutionPhase, "pass2");
    assert.ok(helperCall.resolution, "resolution strategy should be set");
    assert.notEqual(
      helperCall.resolution,
      "global-fallback",
      "should resolve via include path, not global fallback",
    );
  });
});
