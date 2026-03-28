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
import { KotlinAdapter } from "../../dist/indexer/adapter/kotlin.js";

const REPO_ID = "test-kotlin-pass2-repo";

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

describe("Kotlin pass2 indexing", { skip: (() => { const a = new KotlinAdapter(); return !a.getParser() ? "tree-sitter-kotlin grammar not available on this platform" : false; })() }, () => {
  const graphDbPath = join(tmpdir(), ".lbug-kotlin-pass2-test-db.lbug");
  const configPath = join(tmpdir(), "sdl-kotlin-pass2-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-kotlin-pass2-repo-"));
    writeRepoFile(
      repoDir,
      "com/example/Utils.kt",
      ["package com.example", "", 'fun helper(): String = ""', ""].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "com/example/Service.kt",
      [
        "package com.example",
        "",
        "import com.example.helper",
        "",
        "class Service {",
        "  fun run() {",
        "    helper()",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "Main.kt",
      [
        "import com.example.Service",
        "",
        "fun main() {",
        "  val svc = Service()",
        "  svc.run()",
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
        languages: ["kt", "kts"],
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

  it("creates Kotlin pass2 call edges with expected resolver metadata", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);

    const run = symbols.find(
      (symbol) => symbol.name === "run" && symbol.kind === "function",
    );
    const helper = symbols.find(
      (symbol) => symbol.name === "helper" && symbol.kind === "function",
    );
    const main = symbols.find(
      (symbol) => symbol.name === "main" && symbol.kind === "function",
    );
    const serviceClass = symbols.find(
      (symbol) => symbol.name === "Service" && symbol.kind === "class",
    );

    assert.ok(run);
    assert.ok(helper);
    assert.ok(main);
    assert.ok(serviceClass);

    const runEdges = await ladybugDb.getEdgesFrom(conn, run.symbolId);
    const helperCall = runEdges.find(
      (edge) => edge.edgeType === "call" && edge.toSymbolId === helper.symbolId,
    );
    assert.ok(helperCall);
    assert.equal(helperCall.resolverId, "pass2-kotlin");
    assert.equal(helperCall.resolutionPhase, "pass2");
    assert.ok(
      helperCall.resolution === "same-package" ||
        helperCall.resolution === "global-fallback",
    );

    const mainEdges = await ladybugDb.getEdgesFrom(conn, main.symbolId);
    const serviceCtorCall = mainEdges.find(
      (edge) =>
        edge.edgeType === "call" && edge.toSymbolId === serviceClass.symbolId,
    );
    assert.ok(serviceCtorCall);
    assert.equal(serviceCtorCall.resolverId, "pass2-kotlin");
    assert.equal(serviceCtorCall.resolutionPhase, "pass2");
    assert.ok(
      serviceCtorCall.resolution === "import-matched" ||
        serviceCtorCall.resolution === "global-fallback",
    );

    const runCall = mainEdges.find(
      (edge) => edge.edgeType === "call" && edge.toSymbolId === run.symbolId,
    );
    assert.ok(runCall);
    assert.equal(runCall.resolverId, "pass2-kotlin");
    assert.equal(runCall.resolutionPhase, "pass2");
    assert.equal(runCall.resolution, "receiver-imported-instance");
  });
});
