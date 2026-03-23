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

const REPO_ID = "test-java-pass2-repo";

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

describe("Java pass2 indexing", () => {
  const graphDbPath = join(tmpdir(), ".lbug-java-pass2-test-db.lbug");
  const configPath = join(tmpdir(), "sdl-java-pass2-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-java-pass2-repo-"));
    writeRepoFile(
      repoDir,
      "com/example/Utils.java",
      [
        "package com.example;",
        "",
        "public class Utils {",
        "  public static String helper() {",
        '    return "";',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "com/example/Service.java",
      [
        "package com.example;",
        "",
        "import com.example.Utils;",
        "",
        "public class Service {",
        "  public void run() {",
        "    Utils.helper();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "src/main/java/com/example/PackageHelper.java",
      [
        "package com.example;",
        "",
        "public class PackageHelper {",
        "  public static String samePackageHelper() {",
        '    return "";',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "src/generated/com/example/GeneratedService.java",
      [
        "package com.example;",
        "",
        "public class GeneratedService {",
        "  public void runGenerated() {",
        "    PackageHelper.samePackageHelper();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    writeRepoFile(
      repoDir,
      "Main.java",
      [
        "import com.example.Service;",
        "",
        "public class Main {",
        "  public void start() {",
        "    new Service().run();",
        "  }",
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
        languages: ["java"],
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

    const runMethod = symbols.find(
      (symbol) => symbol.name === "run" && symbol.kind === "method",
    );
    const helperMethod = symbols.find(
      (symbol) => symbol.name === "helper" && symbol.kind === "method",
    );
    const serviceClass = symbols.find(
      (symbol) => symbol.name === "Service" && symbol.kind === "class",
    );

    assert.ok(runMethod);
    assert.ok(helperMethod);
    assert.ok(serviceClass);

    const runEdges = await ladybugDb.getEdgesFrom(conn, runMethod.symbolId);
    const helperCall = runEdges.find(
      (edge) =>
        edge.edgeType === "call" && edge.toSymbolId === helperMethod.symbolId,
    );
    assert.ok(helperCall);
    assert.equal(helperCall.resolverId, "pass2-java");
    assert.equal(helperCall.resolutionPhase, "pass2");
    assert.equal(helperCall.resolution, "import-matched");

    const mainFile = await ladybugDb.getFileByRepoPath(
      conn,
      REPO_ID,
      "Main.java",
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
    assert.equal(serviceCall.resolverId, "pass2-java");
    assert.equal(serviceCall.resolutionPhase, "pass2");
    assert.equal(serviceCall.resolution, "import-matched");
  });

  it("creates same-package call edges across source roots", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);

    const generatedRunMethod = symbols.find(
      (symbol) => symbol.name === "runGenerated" && symbol.kind === "method",
    );
    const samePackageHelperMethod = symbols.find(
      (symbol) =>
        symbol.name === "samePackageHelper" && symbol.kind === "method",
    );

    assert.ok(generatedRunMethod);
    assert.ok(samePackageHelperMethod);

    const generatedRunEdges = await ladybugDb.getEdgesFrom(
      conn,
      generatedRunMethod.symbolId,
    );
    const helperCall = generatedRunEdges.find(
      (edge) =>
        edge.edgeType === "call" &&
        edge.toSymbolId === samePackageHelperMethod.symbolId,
    );

    assert.ok(helperCall);
    assert.equal(helperCall.resolverId, "pass2-java");
    assert.equal(helperCall.resolutionPhase, "pass2");
    assert.equal(helperCall.resolution, "same-package");
  });
});
