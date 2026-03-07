import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeKuzuDb, getKuzuConn, initKuzuDb } from "../../src/db/kuzu.js";
import * as kuzuDb from "../../src/db/kuzu-queries.js";
import { buildSlice } from "../../src/graph/slice.js";
import { indexRepo } from "../../src/indexer/indexer.js";
import {
  handleBufferPush,
} from "../../src/mcp/tools/buffer.js";
import {
  handleSymbolGetCard,
  handleSymbolSearch,
} from "../../src/mcp/tools/symbol.js";
import {
  resetDefaultLiveIndexCoordinator,
  waitForDefaultLiveIndexIdle,
} from "../../src/live-index/coordinator.js";

const REPO_ID = "draft-live-read-repo";

function findSymbolByName(
  symbols: kuzuDb.SymbolRow[],
  name: string,
): kuzuDb.SymbolRow {
  const symbol = symbols.find((row) => row.name === name);
  assert.ok(symbol, `Expected symbol ${name} to exist`);
  return symbol!;
}

describe("draft live reads", () => {
  const graphDbPath = join(tmpdir(), ".kuzu-draft-live-read-test-db.kuzu");
  const configPath = join(tmpdir(), `sdl-draft-live-read-${Date.now()}.json`);
  let repoDir = "";
  let durableAlpha: kuzuDb.SymbolRow;
  let durableBeta: kuzuDb.SymbolRow;
  let latestVersionId = "";
  const previousSDL_CONFIG = process.env.SDL_CONFIG;
  const previousSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }

    repoDir = mkdtempSync(join(tmpdir(), "sdl-draft-live-read-repo-"));
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
    const now = "2026-03-07T12:00:00.000Z";
    await kuzuDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });

    const result = await indexRepo(REPO_ID, "full");
    latestVersionId = result.versionId;

    const symbols = await kuzuDb.getSymbolsByRepo(conn, REPO_ID);
    durableAlpha = findSymbolByName(symbols, "alpha");
    durableBeta = findSymbolByName(symbols, "beta");
  });

  beforeEach(() => {
    resetDefaultLiveIndexCoordinator();
  });

  after(async () => {
    resetDefaultLiveIndexCoordinator();
    await closeKuzuDb();
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    if (existsSync(configPath)) {
      rmSync(configPath, { force: true });
    }
    if (repoDir && existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true });
    }

    if (previousSDL_CONFIG === undefined) {
      delete process.env.SDL_CONFIG;
    } else {
      process.env.SDL_CONFIG = previousSDL_CONFIG;
    }
    if (previousSDL_CONFIG_PATH === undefined) {
      delete process.env.SDL_CONFIG_PATH;
    } else {
      process.env.SDL_CONFIG_PATH = previousSDL_CONFIG_PATH;
    }
  });

  it("surfaces renamed unsaved symbols through search and card reads", async () => {
    await handleBufferPush({
      repoId: REPO_ID,
      eventType: "change",
      filePath: "src/example.ts",
      content: [
        "export function alphaDraft() {",
        "  return beta();",
        "}",
        "",
        "export function beta() {",
        "  return 1;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 2,
      dirty: true,
      timestamp: "2026-03-07T12:05:00.000Z",
    });
    await waitForDefaultLiveIndexIdle();

    const search = await handleSymbolSearch({
      repoId: REPO_ID,
      query: "alphaDraft",
      limit: 5,
    });
    assert.ok(search.results.some((row) => row.name === "alphaDraft"));

    const alphaDraft = search.results.find((row) => row.name === "alphaDraft");
    assert.ok(alphaDraft);

    const cardResponse = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolId: alphaDraft!.symbolId,
    });

    assert.ok(!("notModified" in cardResponse));
    assert.strictEqual(cardResponse.card.name, "alphaDraft");
    assert.strictEqual(cardResponse.card.file, "src/example.ts");
  });

  it("merges draft symbols into slice cards when ids remain stable", async () => {
    await handleBufferPush({
      repoId: REPO_ID,
      eventType: "change",
      filePath: "src/example.ts",
      content: [
        "export function alpha() {",
        "  return beta();",
        "}",
        "",
        "export function beta() {",
        "  const value = 2;",
        "  return value;",
        "}",
      ].join("\n"),
      language: "typescript",
      version: 3,
      dirty: true,
      timestamp: "2026-03-07T12:10:00.000Z",
    });
    await waitForDefaultLiveIndexIdle();

    const slice = await buildSlice({
      repoId: REPO_ID,
      versionId: latestVersionId,
      entrySymbols: [durableAlpha.symbolId],
      budget: { maxCards: 10, maxEstimatedTokens: 10_000 },
      minConfidence: 0,
    });

    const betaCard = slice.cards.find((card) => card.symbolId === durableBeta.symbolId);
    assert.ok(betaCard, "Expected beta card in slice");
    assert.notStrictEqual(
      betaCard?.version.astFingerprint,
      durableBeta.astFingerprint,
    );
  });
});
