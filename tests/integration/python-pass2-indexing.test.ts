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

const REPO_ID = "test-python-pass2-repo";

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

describe("Python pass2 indexing", () => {
  const graphDbPath = join(tmpdir(), ".lbug-python-pass2-test-db.lbug");
  const configPath = join(tmpdir(), "sdl-python-pass2-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-python-pass2-repo-"));
    writeRepoFile(repoDir, "mypackage/__init__.py", "");
    writeRepoFile(
      repoDir,
      "mypackage/utils.py",
      ["def helper():", "    return None", ""].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "mypackage/service.py",
      [
        "from mypackage.utils import helper",
        "",
        "class Service:",
        "    def run(self):",
        "        helper()",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "main.py",
      [
        "from mypackage.service import Service",
        "",
        "def main():",
        "    svc = Service()",
        "    svc.run()",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "helpers.py",
      [
        "def orphan_helper():",
        "    return 1",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "consumer.py",
      [
        "def local_run():",
        "    orphan_helper()",
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
        languages: ["py"],
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

  it("creates import-matched call edges in pass2", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);

    const run = symbols.find(
      (symbol) => symbol.name === "Service.run" && symbol.kind === "method",
    );
    const helper = symbols.find(
      (symbol) => symbol.name === "helper" && symbol.kind === "function",
    );
    const serviceClass = symbols.find(
      (symbol) => symbol.name === "Service" && symbol.kind === "class",
    );

    assert.ok(run, "Service.run method should exist");
    assert.ok(helper);
    assert.ok(serviceClass);

    const runEdges = await ladybugDb.getEdgesFrom(conn, run.symbolId);
    const helperCall = runEdges.find(
      (edge) => edge.edgeType === "call" && edge.toSymbolId === helper.symbolId,
    );
    assert.ok(helperCall);
    assert.equal(helperCall.resolverId, "pass2-python");
    assert.equal(helperCall.resolutionPhase, "pass2");
    assert.equal(helperCall.resolution, "import-matched");

    const mainFile = await ladybugDb.getFileByRepoPath(
      conn,
      REPO_ID,
      "main.py",
    );
    assert.ok(mainFile);
    const mainFileSymbolIds = new Set(
      symbols
        .filter((symbol) => symbol.fileId === mainFile.fileId)
        .map((symbol) => symbol.symbolId),
    );
    type EdgeFromSymbol = Awaited<
      ReturnType<typeof ladybugDb.getEdgesFrom>
    >[number];
    let serviceCall: EdgeFromSymbol | undefined;
    for (const symbolId of mainFileSymbolIds) {
      const edges = await ladybugDb.getEdgesFrom(conn, symbolId);
      const match = edges.find(
        (edge) =>
          edge.edgeType === "call" && edge.toSymbolId === serviceClass.symbolId,
      );
      if (match) {
        serviceCall = match;
        break;
      }
    }

    assert.ok(serviceCall);
    assert.equal(serviceCall.resolverId, "pass2-python");
    assert.equal(serviceCall.resolutionPhase, "pass2");
    assert.equal(serviceCall.resolution, "import-matched");
  });

  it("creates imported-instance method call edges in pass2", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);

    const main = symbols.find(
      (symbol) => symbol.name === "main" && symbol.kind === "function",
    );
    const run = symbols.find(
      (symbol) => symbol.name === "Service.run" && symbol.kind === "method",
    );

    assert.ok(main);
    assert.ok(run, "Service.run method should exist");

    const mainEdges = await ladybugDb.getEdgesFrom(conn, main.symbolId);
    const runCall = mainEdges.find(
      (edge) => edge.edgeType === "call" && edge.toSymbolId === run.symbolId,
    );

    assert.ok(runCall);
    assert.equal(runCall.resolverId, "pass2-python");
    assert.equal(runCall.resolutionPhase, "pass2");
    assert.equal(runCall.resolution, "receiver-imported-instance");
  });

  it("does not create same-directory call edges without an import", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);

    const localRun = symbols.find(
      (symbol) => symbol.name === "local_run" && symbol.kind === "function",
    );
    const orphanHelper = symbols.find(
      (symbol) => symbol.name === "orphan_helper" && symbol.kind === "function",
    );

    assert.ok(localRun);
    assert.ok(orphanHelper);

    const edges = await ladybugDb.getEdgesFrom(conn, localRun.symbolId);
    const falsePositive = edges.find(
      (edge) =>
        edge.edgeType === "call" && edge.toSymbolId === orphanHelper.symbolId,
    );

    assert.equal(
      falsePositive,
      undefined,
      "bare Python calls must not resolve to sibling-module functions without an import",
    );
  });
});
