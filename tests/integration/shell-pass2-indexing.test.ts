import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { ShellPass2Resolver } from "../../dist/indexer/pass2/resolvers/shell-pass2-resolver.js";

const REPO_ID = "test-shell-pass2-repo";

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function removeGraphDbFiles(graphDbPath: string): void {
  // LadybugDB can leave sidecar files behind after interrupted test runs.
  for (const suffix of ["", ".wal", ".lock", ".shm"]) {
    try {
      rmSync(graphDbPath + suffix, { recursive: true, force: true });
    } catch {}
  }
}

describe("Shell pass2 indexing", () => {
  const graphDbPath = join(tmpdir(), ".lbug-shell-pass2-test-db.lbug");
  const configPath = join(tmpdir(), "sdl-shell-pass2-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  before(async () => {
    removeGraphDbFiles(graphDbPath);

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-shell-pass2-repo-"));
    writeRepoFile(
      repoDir,
      "lib/utils.sh",
      [
        'log_info() { echo "[INFO] $1"; }',
        'log_error() { echo "[ERROR] $1"; }',
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "scripts/deploy.sh",
      [
        "#!/bin/bash",
        "source ../lib/utils.sh",
        'deploy() { log_info "Deploying..."; }',
        "deploy",
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
        languages: ["sh", "bash"],
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
    removeGraphDbFiles(graphDbPath);
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

  it("creates shell call edges in pass2", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);
    const globalNameToSymbolIds = new Map<string, string[]>();
    for (const symbol of symbols) {
      const existing = globalNameToSymbolIds.get(symbol.name) ?? [];
      existing.push(symbol.symbolId);
      globalNameToSymbolIds.set(symbol.name, existing);
    }

    const resolver = new ShellPass2Resolver();
    const resolution = await resolver.resolve(
      {
        repoId: REPO_ID,
        filePath: "scripts/deploy.sh",
        extension: ".sh",
        language: "shell",
      },
      {
        repoRoot: repoDir as string,
        symbolIndex: new Map(),
        tsResolver: null,
        languages: ["sh", "bash"],
        createdCallEdges: new Set<string>(),
        globalNameToSymbolIds,
        cache: new Map(),
      },
    );
    assert.ok(resolution.edgesCreated > 0);

    const deploySymbol = symbols.find(
      (s) => s.name === "deploy" && s.kind === "function",
    );
    assert.ok(deploySymbol, "deploy function symbol not found");

    const logInfoSymbol = symbols.find(
      (s) => s.name === "log_info" && s.kind === "function",
    );
    assert.ok(logInfoSymbol, "log_info function symbol not found");

    const deployEdges = await ladybugDb.getEdgesFrom(
      conn,
      deploySymbol.symbolId,
    );
    const logInfoCall = deployEdges.find(
      (edge) =>
        edge.edgeType === "call" && edge.toSymbolId === logInfoSymbol.symbolId,
    );
    assert.ok(logInfoCall, "call edge from deploy to log_info not found");
    assert.equal(logInfoCall.resolverId, "pass2-shell");
    assert.equal(logInfoCall.resolutionPhase, "pass2");
    assert.ok(logInfoCall.resolution, "resolution strategy should be set");
    assert.notEqual(
      logInfoCall.resolution,
      "global-fallback",
      "should resolve via source import, not global fallback",
    );
  });
});
