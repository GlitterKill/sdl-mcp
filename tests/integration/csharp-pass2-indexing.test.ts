import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
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

const REPO_ID = "test-csharp-pass2-repo";

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

describe("CSharp pass2 indexing", () => {
  const graphDbPath = join(tmpdir(), ".lbug-csharp-pass2-test-db.lbug");
  const configPath = join(tmpdir(), "sdl-csharp-pass2-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-csharp-pass2-repo-"));
    writeRepoFile(
      repoDir,
      "Models/User.cs",
      [
        "namespace App.Models;",
        "public class User { public string Name { get; set; } }",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "Services/UserService.cs",
      [
        "using App.Models;",
        "namespace App.Services;",
        "public class UserService { public User GetUser() { return new User(); } }",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "Program.cs",
      [
        "using App.Services;",
        "public class Program { public static void Main() { var svc = new UserService(); svc.GetUser(); } }",
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
        },
        null,
        2,
      ),
      "utf8",
    );

    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await closeLadybugDb();
    // Clean up stale WAL/lock files from previous test runs
    for (const suffix of [".wal", ".lock"]) {
      try { unlinkSync(graphDbPath + suffix); } catch { /* may not exist */ }
    }
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
        languages: ["cs"],
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

  it("creates using-import call edges in pass2", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);

    const pass2CallEdges = (
      await Promise.all(
        symbols.map((symbol) => ladybugDb.getEdgesFrom(conn, symbol.symbolId)),
      )
    )
      .flat()
      .filter(
        (edge) =>
          edge.edgeType === "call" &&
          edge.resolverId === "pass2-csharp" &&
          edge.resolutionPhase === "pass2",
      );

    assert.ok(pass2CallEdges.length > 0);

    const firstPass2Call = pass2CallEdges[0];
    assert.equal(firstPass2Call.resolverId, "pass2-csharp");
    assert.equal(firstPass2Call.resolutionPhase, "pass2");
  });
});
