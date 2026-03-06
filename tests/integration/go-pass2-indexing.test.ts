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

import { closeKuzuDb, getKuzuConn, initKuzuDb } from "../../src/db/kuzu.js";
import * as kuzuDb from "../../src/db/kuzu-queries.js";
import { indexRepo } from "../../src/indexer/indexer.js";

const REPO_ID = "test-go-pass2-repo";

function writeRepoFile(repoRoot: string, relPath: string, content: string): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

describe("Go pass2 indexing", () => {
  const graphDbPath = join(tmpdir(), ".kuzu-go-pass2-test-db.kuzu");
  const configPath = join(tmpdir(), "sdl-go-pass2-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-go-pass2-repo-"));
    writeRepoFile(repoDir, "go.mod", "module github.com/acme/project\n");
    writeRepoFile(
      repoDir,
      "app/main.go",
      [
        "package app",
        "",
        'import svc "github.com/acme/project/pkg/service"',
        "",
        "func Run() {",
        "  Helper()",
        "  client := Client{}",
        "  client.Handle()",
        "  svc.Process()",
        "}",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "app/helpers.go",
      [
        "package app",
        "",
        "func Helper() {}",
        "",
        "type Client struct{}",
        "",
        "func (Client) Handle() {}",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "pkg/service/service.go",
      [
        "package service",
        "",
        "func Process() {}",
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

    await closeKuzuDb();
    await initKuzuDb(graphDbPath);
    const conn = await getKuzuConn();
    const now = new Date().toISOString();
    await kuzuDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
        ignore: [],
        languages: ["go"],
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
    await closeKuzuDb();
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

  it("creates same-package, receiver-type, and imported-package call edges in pass2", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);

    const conn = await getKuzuConn();
    const symbols = await kuzuDb.getSymbolsByRepo(conn, REPO_ID);

    const run = symbols.find((symbol) => symbol.name === "Run" && symbol.kind === "function");
    const helper = symbols.find((symbol) => symbol.name === "Helper" && symbol.kind === "function");
    const handle = symbols.find((symbol) => symbol.name === "Handle" && symbol.kind === "method");
    const processFn = symbols.find((symbol) => symbol.name === "Process" && symbol.kind === "function");

    assert.ok(run);
    assert.ok(helper);
    assert.ok(handle);
    assert.ok(processFn);

    const edges = await kuzuDb.getEdgesFrom(conn, run.symbolId);
    const byTarget = new Map(
      edges
        .filter((edge) => edge.edgeType === "call")
        .map((edge) => [edge.toSymbolId, edge]),
    );

    assert.equal(byTarget.get(helper.symbolId)?.resolverId, "pass2-go");
    assert.equal(byTarget.get(helper.symbolId)?.resolutionPhase, "pass2");
    assert.equal(byTarget.get(handle.symbolId)?.resolverId, "pass2-go");
    assert.equal(byTarget.get(handle.symbolId)?.resolutionPhase, "pass2");
    assert.equal(byTarget.get(processFn.symbolId)?.resolverId, "pass2-go");
    assert.equal(byTarget.get(processFn.symbolId)?.resolutionPhase, "pass2");

    assert.equal(byTarget.get(helper.symbolId)?.resolution, "same-package");
    assert.equal(byTarget.get(handle.symbolId)?.resolution, "receiver-type");
    assert.equal(byTarget.get(processFn.symbolId)?.resolution, "module-qualified");
  });
});
