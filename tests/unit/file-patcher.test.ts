import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { loadBuiltInAdapters } from "../../dist/indexer/adapter/registry.js";
import { patchSavedFile } from "../../dist/live-index/file-patcher.js";

describe("patchSavedFile", () => {
  const repoId = "file-patcher-repo";
  const configPath = join(tmpdir(), `sdl-file-patcher-${Date.now()}.json`);
  let dbDir = "";
  let dbPath = "";
  let repoDir = "";
  const prevConfig = process.env.SDL_CONFIG;
  const prevConfigPath = process.env.SDL_CONFIG_PATH;

  before(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "sdl-file-patcher-db-"));
    dbPath = join(dbDir, "sdl-mcp-graph.lbug");
    repoDir = mkdtempSync(join(tmpdir(), "sdl-file-patcher-repo-"));
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "example.ts"),
      [
        "export function alpha() {",
        "  return beta();",
        "}",
        "",
        "export function beta() {",
        "  return 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify(
        { repos: [], policy: {}, indexing: { engine: "typescript", enableFileWatching: false } },
        null,
        2,
      ),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    process.env.SDL_GRAPH_DB_PATH = dbPath;
    try { await closeLadybugDb(); } catch { /* may already be closed */ }
    await initLadybugDb(dbPath);
    loadBuiltInAdapters();
    const conn = await getLadybugConn();
    const now = "2026-03-07T12:00:00.000Z";
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: now,
    });
    await indexRepo(repoId, "full");
  });

  after(async () => {
    await closeLadybugDb();
    if (dbDir && existsSync(dbDir))
      rmSync(dbDir, { recursive: true, force: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });
    if (repoDir && existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = prevConfig;
    if (prevConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = prevConfigPath;
  });

  it("replaces one file's durable symbols and edges transactionally", async () => {
    const result = await patchSavedFile({
      repoId,
      filePath: "src/example.ts",
      content: [
        "export function alpha() {",
        "  return gamma();",
        "}",
        "",
        "export function gamma() {",
        "  return 2;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 2,
    });

    assert.strictEqual(result.symbolsUpserted, 2);
    assert.ok(result.edgesUpserted >= 1);

    const conn = await getLadybugConn();
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, "src/example.ts");
    assert.ok(file);
    const symbols = await ladybugDb.getSymbolsByFile(conn, file!.fileId);
    const names = symbols.map((symbol) => symbol.name).sort();
    assert.deepStrictEqual(names, ["alpha", "gamma"]);

    const alpha = symbols.find((symbol) => symbol.name === "alpha");
    const gamma = symbols.find((symbol) => symbol.name === "gamma");
    assert.ok(alpha);
    assert.ok(gamma);

    const outgoing = await ladybugDb.getEdgesFrom(conn, alpha!.symbolId);
    assert.ok(outgoing.some((edge) => edge.toSymbolId === gamma!.symbolId));
  });
});
