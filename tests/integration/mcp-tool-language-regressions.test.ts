import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeKuzuDb, getKuzuConn, initKuzuDb } from "../../src/db/kuzu.js";
import * as kuzuDb from "../../src/db/kuzu-queries.js";
import { indexRepo } from "../../src/indexer/indexer.js";
import { handleSymbolSearch } from "../../src/mcp/tools/symbol.js";

/**
 * MCP tool-level regression test for language indexing reliability.
 *
 * Locks the bug at the MCP-tool boundary: after register + index,
 * handleSymbolSearch must find Kotlin, TSX, and JSX symbols.
 */
describe("MCP Tool Language Regressions", () => {
  const repoId = "lang-regression-repo";
  const dbPath = join(tmpdir(), ".kuzu-lang-regression-test.kuzu");
  const configPath = join(tmpdir(), `sdl-lang-regression-${Date.now()}.json`);
  let repoDir = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    // Clean up any leftover DB
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });

    // Create temp repo with multi-language source files
    repoDir = mkdtempSync(join(tmpdir(), "sdl-lang-regression-repo-"));

    // Write .kt fixture
    const ktDir = join(repoDir, "kotlin");
    mkdirSync(ktDir, { recursive: true });
    writeFileSync(
      join(ktDir, "smoke.kt"),
      readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      ),
      "utf8",
    );

    // Write .tsx fixture
    const tsxDir = join(repoDir, "tsx");
    mkdirSync(tsxDir, { recursive: true });
    writeFileSync(
      join(tsxDir, "components.tsx"),
      readFileSync(
        join(process.cwd(), "tests/fixtures/typescript/components.tsx"),
        "utf-8",
      ),
      "utf8",
    );

    // Write .jsx fixture
    const jsxDir = join(repoDir, "jsx");
    mkdirSync(jsxDir, { recursive: true });
    writeFileSync(
      join(jsxDir, "components.jsx"),
      readFileSync(
        join(process.cwd(), "tests/fixtures/typescript/components.jsx"),
        "utf-8",
      ),
      "utf8",
    );

    // Write config
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

    // Init KuzuDB and seed the repo record
    await closeKuzuDb();
    await initKuzuDb(dbPath);
    const conn = await getKuzuConn();
    await kuzuDb.upsertRepo(conn, {
      repoId,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoDir,
        ignore: [],
        // Languages are file extensions (without dot) used by the scanner
        languages: ["kt", "tsx", "jsx", "ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: new Date().toISOString(),
    });

    // Index the temp repo
    await indexRepo(repoId, "full");
  });

  after(async () => {
    await closeKuzuDb();
    if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (repoDir && existsSync(repoDir))
      rmSync(repoDir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("should discover TSX component symbols via handleSymbolSearch", async () => {
    const result = await handleSymbolSearch({
      repoId,
      query: "SdlSmokeTsxCard",
      limit: 10,
    });
    const found = result.results.some((r: any) => r.name === "SdlSmokeTsxCard");
    assert.ok(
      found,
      `SdlSmokeTsxCard not found via handleSymbolSearch. ` +
        `Got: ${result.results.map((r: any) => r.name).join(", ") || "(none)"}`,
    );
  });

  it("should discover JSX component symbols via handleSymbolSearch", async () => {
    const result = await handleSymbolSearch({
      repoId,
      query: "SdlSmokeJsxApp",
      limit: 10,
    });
    const found = result.results.some((r: any) => r.name === "SdlSmokeJsxApp");
    assert.ok(
      found,
      `SdlSmokeJsxApp not found via handleSymbolSearch. ` +
        `Got: ${result.results.map((r: any) => r.name).join(", ") || "(none)"}`,
    );
  });

  it("should discover Kotlin symbols via handleSymbolSearch", async () => {
    // Kotlin grammar may not be available on all platforms.
    // Probe by attempting to load the grammar before asserting on search results.
    const { getParser } =
      await import("../../src/indexer/treesitter/grammarLoader.js");
    const parser = getParser("kotlin");
    if (!parser) {
      // Grammar not available on this platform — skip with clear diagnostic
      console.log(
        `[SKIP] Kotlin grammar not loadable on ${process.platform}/${process.arch} ` +
          `Node ${process.version}. Kotlin MCP search test skipped.`,
      );
      return;
    }

    const result = await handleSymbolSearch({
      repoId,
      query: "User",
      limit: 20,
    });
    const found = result.results.some((r: any) => r.name === "User");
    assert.ok(
      found,
      `Kotlin symbol 'User' not found via handleSymbolSearch. ` +
        `Got: ${result.results.map((r: any) => r.name).join(", ") || "(none)"}. ` +
        `This means Kotlin indexing is broken despite grammar loading successfully.`,
    );
  });
});
