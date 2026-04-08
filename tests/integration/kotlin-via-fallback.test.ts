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
import { isRustEngineAvailable } from "../../dist/indexer/rustIndexer.js";

const REPO_ID = "test-kotlin-via-fallback-repo";

function writeRepoFile(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  const fullPath = join(repoRoot, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

// Task 1.11 — Confirm .kt files are routed through the per-file Rust → TS
// fallback when engine: "rust" is configured. The Rust extractor has no
// tree-sitter-kotlin grammar, so parseFilesRust returns a parseError with
// "Unsupported language". runPass1WithRustEngine should then call the TS
// processFile path for that single file (with tsResolver: null), and the
// KotlinPass2Resolver should subsequently resolve call edges normally.
//
// When the native addon is unavailable the outer indexRepoImpl fallback
// degrades to the full TS engine for all files, which bypasses the per-file
// fallback we want to exercise. In that case the test skips cleanly.
const shouldSkip = (() => {
  if (!isRustEngineAvailable()) {
    return "native Rust addon unavailable — per-file fallback path not exercised";
  }
  const a = new KotlinAdapter();
  if (!a.getParser()) {
    return "tree-sitter-kotlin grammar not available on this platform";
  }
  return false as const;
})();

describe("Kotlin via Rust → TS per-file fallback", { skip: shouldSkip }, () => {
  const graphDbPath = join(tmpdir(), ".lbug-kotlin-via-fallback-test-db.lbug");
  const configPath = join(tmpdir(), "sdl-kotlin-via-fallback-config.json");
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  let repoDir: string | null = null;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    repoDir = mkdtempSync(join(tmpdir(), "sdl-mcp-kotlin-via-fallback-repo-"));
    // Single-file fixture with one class + one method + one intra-file call.
    // Keeps the test fast (< 5s budget) and avoids cross-file resolution.
    writeRepoFile(
      repoDir,
      "com/example/Greeter.kt",
      [
        "package com.example",
        "",
        "class Greeter {",
        "  fun greet(): String {",
        "    return build()",
        "  }",
        "",
        "  fun build(): String = \"hello\"",
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
          // Force Rust engine so the per-file fallback path is exercised
          // for Kotlin files (Rust extractor has no tree-sitter-kotlin).
          indexing: { engine: "rust", enableFileWatching: false },
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

  it("indexes Kotlin symbols via the per-file TS fallback when engine is rust", async () => {
    const result = await indexRepo(REPO_ID, "full");
    assert.ok(result.versionId.length > 0);
    assert.ok(
      result.symbolsIndexed > 0,
      "Kotlin symbols should be indexed via TS fallback even when engine is rust",
    );

    // Phase 1 Task 1.11 acceptance: `pass1.rustFallbackFiles` must report the
    // Kotlin file count when the Rust engine encounters an unsupported
    // language and routes the file through the per-file TS fallback.
    assert.ok(
      result.pass1Engine,
      "IndexResult.pass1Engine block should be populated when engine: rust",
    );
    assert.ok(
      result.pass1Engine!.rustFallbackFiles >= 1,
      `rustFallbackFiles should be >= 1 for the Kotlin fixture; got ${result.pass1Engine!.rustFallbackFiles}`,
    );
    assert.ok(
      (result.pass1Engine!.perLanguageFallback.kt ?? 0) >= 1,
      `perLanguageFallback.kt should be >= 1; got ${result.pass1Engine!.perLanguageFallback.kt ?? 0}`,
    );

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);

    const greeterClass = symbols.find(
      (symbol) => symbol.name === "Greeter" && symbol.kind === "class",
    );
    const greet = symbols.find(
      (symbol) => symbol.name === "greet" && symbol.kind === "function",
    );
    const build = symbols.find(
      (symbol) => symbol.name === "build" && symbol.kind === "function",
    );

    assert.ok(greeterClass, "Greeter class should be extracted via TS fallback");
    assert.ok(greet, "greet method should be extracted via TS fallback");
    assert.ok(build, "build method should be extracted via TS fallback");
  });

  it("runs KotlinPass2Resolver on fallback-routed Kotlin files", async () => {
    const conn = await getLadybugConn();
    const symbols = await ladybugDb.getSymbolsByRepo(conn, REPO_ID);

    const greet = symbols.find(
      (symbol) => symbol.name === "greet" && symbol.kind === "function",
    );
    const build = symbols.find(
      (symbol) => symbol.name === "build" && symbol.kind === "function",
    );
    assert.ok(greet);
    assert.ok(build);

    const greetEdges = await ladybugDb.getEdgesFrom(conn, greet.symbolId);
    const buildCall = greetEdges.find(
      (edge) => edge.edgeType === "call" && edge.toSymbolId === build.symbolId,
    );
    assert.ok(
      buildCall,
      "KotlinPass2Resolver should resolve greet() → build() call edge after fallback indexing",
    );
    assert.equal(buildCall.resolverId, "pass2-kotlin");
    assert.equal(buildCall.resolutionPhase, "pass2");
  });
});
