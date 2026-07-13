import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _setDraftSymbolFallbackObserverForTests,
  parseDraftFile,
} from "../../dist/live-index/draft-parser.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { loadBuiltInAdapters } from "../../dist/indexer/adapter/registry.js";

describe("parseDraftFile", () => {
  const testDbDir = mkdtempSync(join(tmpdir(), "sdl-draft-parser-test-"));
  const testDbPath = join(testDbDir, "test.lbug");

  const prevGraphDbPath = process.env.SDL_GRAPH_DB_PATH;

  before(async () => {
    process.env.SDL_GRAPH_DB_PATH = testDbPath;
    try {
      await closeLadybugDb();
    } catch {
      /* may already be closed */
    }
    await initLadybugDb(testDbPath);
    loadBuiltInAdapters();
  });

  after(async () => {
    try {
      await closeLadybugDb();
    } catch {
      /* ignore */
    }
    // Restore env var but don't re-init DB - let the next process handle it.
    // Re-initializing here leaves a connection open that causes segfault on exit.
    if (prevGraphDbPath) {
      process.env.SDL_GRAPH_DB_PATH = prevGraphDbPath;
    } else {
      delete process.env.SDL_GRAPH_DB_PATH;
    }
    // Clean up test DB and WAL file
    rmSync(testDbDir, { recursive: true, force: true });
  });

  it("extracts file-owned symbols, edges, and references from unsaved content", async () => {
    const result = await parseDraftFile({
      repoId: "demo-repo",
      repoRoot: process.cwd(),
      filePath: "tests/example.test.ts",
      content: [
        "export function alpha() {",
        "  return beta();",
        "}",
        "",
        "function beta() {",
        "  return 1;",
        "}",
      ].join("\n"),
      languages: ["ts"],
      language: "typescript",
      version: 5,
    });

    assert.strictEqual(result.file.relPath, "tests/example.test.ts");
    assert.strictEqual(result.symbols.length, 2);
    assert.ok(result.symbols.some((symbol) => symbol.name === "alpha"));
    assert.ok(result.symbols.some((symbol) => symbol.name === "beta"));
    const alpha = result.symbols.find((symbol) => symbol.name === "alpha");
    const beta = result.symbols.find((symbol) => symbol.name === "beta");
    assert.ok(
      result.edges.some(
        (edge) =>
          edge.edgeType === "call" &&
          edge.fromSymbolId === alpha?.symbolId &&
          edge.toSymbolId === beta?.symbolId,
      ),
    );
    assert.ok(result.references.some((ref) => ref.symbolName === "alpha"));
  });

  it("reports durable SymbolID fallback without changing draft output", async () => {
    const input = {
      repoId: "durable-fallback-repo",
      repoRoot: process.cwd(),
      filePath: "src/durable.ts",
      content: "export function stable() { return 1; }\n",
      languages: ["ts"],
      language: "typescript",
      version: 1,
    };
    const initial = await parseDraftFile(input);
    const durableSymbol = initial.symbols.find((symbol) => symbol.name === "stable");
    assert.ok(durableSymbol);

    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId: input.repoId,
      rootPath: input.repoRoot,
      configJson: "{}",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    await ladybugDb.upsertFile(conn, initial.file);
    await ladybugDb.upsertSymbol(conn, durableSymbol);

    const fallbacks: string[] = [];
    _setDraftSymbolFallbackObserverForTests((matchKey) => fallbacks.push(matchKey));
    try {
      const changed = await parseDraftFile({
        ...input,
        content: "export function stable() { return 2; }\n",
        version: 2,
      });
      assert.deepEqual(fallbacks, ["function:stable:1:7"]);
      assert.equal(changed.symbols[0]?.symbolId, durableSymbol.symbolId);
    } finally {
      _setDraftSymbolFallbackObserverForTests();
    }
  });
});
