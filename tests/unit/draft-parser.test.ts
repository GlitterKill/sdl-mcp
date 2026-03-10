import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDraftFile } from "../../src/live-index/draft-parser.js";
import { closeLadybugDb, initLadybugDb } from "../../src/db/ladybug.js";

describe("parseDraftFile", () => {
  const testDbPath = join(tmpdir(), ".lbug-draft-parser-unit-test-db.lbug");

  before(async () => {
    if (existsSync(testDbPath)) {
      rmSync(testDbPath, { recursive: true, force: true });
    }
    await closeLadybugDb();
    await initLadybugDb(testDbPath);
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(testDbPath)) {
      rmSync(testDbPath, { recursive: true, force: true });
    }
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
