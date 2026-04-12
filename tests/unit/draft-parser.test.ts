import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDraftFile } from "../../dist/live-index/draft-parser.js";
import { closeLadybugDb, initLadybugDb } from "../../dist/db/ladybug.js";
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
});
