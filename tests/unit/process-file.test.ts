import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  isTestFile,
  createEmptyProcessFileResult,
  buildSymbolReferences,
} from "../../dist/indexer/parser/helpers.js";
import {
  getAdapterForExtension,
  loadBuiltInAdapters,
} from "../../dist/indexer/adapter/registry.js";
import {
  processFile,
  type ProcessFileParams,
} from "../../dist/indexer/parser/process-file.js";

describe("process-file helpers — isTestFile", () => {
  const languages = ["ts", "tsx", "js", "jsx"];

  it("detects .test. suffix in TypeScript files", () => {
    assert.strictEqual(isTestFile("src/foo.test.ts", languages), true);
  });

  it("detects .spec. suffix in TypeScript files", () => {
    assert.strictEqual(isTestFile("src/foo.spec.ts", languages), true);
  });

  it("detects files in tests/ directory", () => {
    // isTestFile checks for "/tests/" (with surrounding slashes), not a leading "tests/"
    assert.strictEqual(isTestFile("src/tests/unit/bar.ts", languages), true);
  });

  it("detects files in __tests__/ directory", () => {
    assert.strictEqual(isTestFile("src/__tests__/baz.ts", languages), true);
  });

  it("returns false for regular source files", () => {
    assert.strictEqual(isTestFile("src/indexer/parser.ts", languages), false);
  });

  it("returns false for non-language files even with test suffix", () => {
    assert.strictEqual(isTestFile("src/foo.test.md", languages), false);
  });

  it("returns false for empty path", () => {
    assert.strictEqual(isTestFile("", languages), false);
  });

  it("handles Windows-style backslash paths in test directories", () => {
    // isTestFile checks for "\\tests\\" (with surrounding backslashes)
    assert.strictEqual(isTestFile("src\\tests\\unit\\bar.ts", languages), true);
    assert.strictEqual(
      isTestFile("src\\__tests__\\baz.ts", languages),
      true,
    );
  });
});

describe("process-file helpers — createEmptyProcessFileResult", () => {
  it("returns zero counts with changed=true", () => {
    const result = createEmptyProcessFileResult(true);
    assert.strictEqual(result.symbolsIndexed, 0);
    assert.strictEqual(result.edgesCreated, 0);
    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual(result.configEdges, []);
    assert.deepStrictEqual(result.pass2HintPaths, []);
  });

  it("returns zero counts with changed=false", () => {
    const result = createEmptyProcessFileResult(false);
    assert.strictEqual(result.symbolsIndexed, 0);
    assert.strictEqual(result.edgesCreated, 0);
    assert.strictEqual(result.changed, false);
    assert.deepStrictEqual(result.configEdges, []);
    assert.deepStrictEqual(result.pass2HintPaths, []);
  });
});

describe("process-file — binary skip cleanup", () => {
  const repoId = "binary-skip-repo";
  const graphDbPath = mkdtempSync(join(tmpdir(), "sdl-binary-skip-db-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "sdl-binary-skip-repo-"));
  const relPath = "src/binary.ts";
  const fileId = `${repoId}:${relPath}`;
  const filePath = join(repoRoot, "src", "binary.ts");
  const now = "2026-03-25T12:00:00.000Z";

  before(async () => {
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(filePath, Buffer.from([0x61, 0x00, 0x62]));

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoRoot,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoRoot,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: now,
    });

    await ladybugDb.upsertFile(conn, {
      fileId,
      repoId,
      relPath,
      contentHash: "old-hash",
      language: "ts",
      byteSize: 3,
      lastIndexedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
      symbolId: `${fileId}:stale-symbol`,
      repoId,
      fileId,
      kind: "function",
      name: "staleSymbol",
      exported: true,
      visibility: null,
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 10,
      astFingerprint: "stale-fingerprint",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
  });

  after(async () => {
    await closeLadybugDb();
    rmSync(graphDbPath, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("persists skipped binary files and clears stale symbols", async () => {
    const result = await processFile({
      repoId,
      repoRoot,
      fileMeta: {
        path: relPath,
        size: 3,
        mtime: Date.now(),
      },
      languages: ["ts"],
      mode: "incremental",
      existingFile: {
        fileId,
        contentHash: "old-hash",
        lastIndexedAt: null,
      },
    });

    assert.strictEqual(result.changed, true);

    const conn = await getLadybugConn();
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, relPath);
    assert.ok(file, "Expected skipped file metadata to be persisted");

    const symbols = await ladybugDb.getSymbolsByFile(conn, fileId);
    assert.deepStrictEqual(symbols, []);
  });
});

describe("process-file helpers — buildSymbolReferences", () => {
  it("extracts unique identifier tokens from content", () => {
    const content = `
import { foo } from "./bar";
function processData(input) {
  return foo(input);
}
`.trim();

    const refs = buildSymbolReferences(content, "repo1", "file1");
    assert.ok(refs.length > 0, "Should extract references");

    const names = refs.map((r) => r.symbolName);
    assert.ok(names.includes("foo"), "Should find 'foo' identifier");
    assert.ok(names.includes("processData"), "Should find 'processData'");
    assert.ok(names.includes("input"), "Should find 'input'");
  });

  it("deduplicates repeated identifiers", () => {
    const content = "foo foo foo bar bar";
    const refs = buildSymbolReferences(content, "repo1", "file1");
    const names = refs.map((r) => r.symbolName);

    // Each unique identifier should appear exactly once
    const fooCount = names.filter((n) => n === "foo").length;
    assert.strictEqual(fooCount, 1, "foo should appear once");
    const barCount = names.filter((n) => n === "bar").length;
    assert.strictEqual(barCount, 1, "bar should appear once");
  });

  it("returns empty array for content with no identifiers", () => {
    const refs = buildSymbolReferences("123 456 + - =", "repo1", "file1");
    assert.strictEqual(refs.length, 0);
  });

  it("includes repoId and fileId in each reference", () => {
    const refs = buildSymbolReferences("hello world", "myRepo", "myFile");
    for (const ref of refs) {
      assert.strictEqual(ref.repoId, "myRepo");
      assert.strictEqual(ref.fileId, "myFile");
    }
  });

  it("generates unique refId for each reference", () => {
    const refs = buildSymbolReferences("alpha beta gamma", "r1", "f1");
    const refIds = refs.map((r) => r.refId);
    const uniqueRefIds = new Set(refIds);
    assert.strictEqual(uniqueRefIds.size, refIds.length, "refIds should be unique");
  });
});

describe("process-file — adapter selection", () => {
  before(() => {
    loadBuiltInAdapters();
  });

  it("selects TypeScript adapter for .ts extension", () => {
    const adapter = getAdapterForExtension(".ts");
    assert.ok(adapter, "Should find adapter for .ts");
    assert.strictEqual(adapter.languageId, "typescript");
  });

  it("selects TypeScript adapter for .tsx extension", () => {
    const adapter = getAdapterForExtension(".tsx");
    assert.ok(adapter, "Should find adapter for .tsx");
    // tsx uses the typescript adapter
    assert.ok(
      adapter.languageId === "typescript" || adapter.languageId === "tsx",
    );
  });

  it("selects Python adapter for .py extension", () => {
    const adapter = getAdapterForExtension(".py");
    assert.ok(adapter, "Should find adapter for .py");
    assert.strictEqual(adapter.languageId, "python");
  });

  it("selects Go adapter for .go extension", () => {
    const adapter = getAdapterForExtension(".go");
    assert.ok(adapter, "Should find adapter for .go");
    assert.strictEqual(adapter.languageId, "go");
  });

  it("selects Rust adapter for .rs extension", () => {
    const adapter = getAdapterForExtension(".rs");
    assert.ok(adapter, "Should find adapter for .rs");
    assert.strictEqual(adapter.languageId, "rust");
  });

  it("returns null for unsupported extension", () => {
    const adapter = getAdapterForExtension(".xyz");
    assert.strictEqual(adapter, null);
  });

  it("returns null for empty extension", () => {
    const adapter = getAdapterForExtension("");
    assert.strictEqual(adapter, null);
  });
});

describe("process-file — TypeScript parsing via adapter", () => {
  before(() => {
    loadBuiltInAdapters();
  });

  it("parses a simple TypeScript function and extracts symbols", () => {
    const adapter = getAdapterForExtension(".ts");
    assert.ok(adapter, "TypeScript adapter must be available");

    const code = `
export function greet(name: string): string {
  return "Hello, " + name;
}

export const VERSION = "1.0.0";
`.trim();

    const tree = adapter.parse(code, "test.ts");
    assert.ok(tree, "Should parse TypeScript code");

    const symbols = adapter.extractSymbols(tree, code, "test.ts");
    assert.ok(symbols.length >= 2, `Expected at least 2 symbols, got ${symbols.length}`);

    const greetSymbol = symbols.find((s: any) => s.name === "greet");
    assert.ok(greetSymbol, "Should find 'greet' function");
    assert.strictEqual(greetSymbol.kind, "function");
    assert.strictEqual(greetSymbol.exported, true);

    const versionSymbol = symbols.find((s: any) => s.name === "VERSION");
    assert.ok(versionSymbol, "Should find 'VERSION' variable");
    assert.strictEqual(versionSymbol.exported, true);

    // Clean up tree
    if (typeof (tree as any).delete === "function") {
      (tree as any).delete();
    }
  });

  it("extracts imports from TypeScript code", () => {
    const adapter = getAdapterForExtension(".ts");
    assert.ok(adapter);

    const code = `
import { readFileSync } from "fs";
import { join } from "path";
import { logger } from "../util/logger.js";

export function readConfig(path: string): string {
  return readFileSync(join(path, "config.json"), "utf-8");
}
`.trim();

    const tree = adapter.parse(code, "test.ts");
    assert.ok(tree);

    const imports = adapter.extractImports(tree, code, "test.ts");
    assert.ok(imports.length >= 3, `Expected at least 3 imports, got ${imports.length}`);

    const fsImport = imports.find((i: any) => i.specifier === "fs");
    assert.ok(fsImport, "Should find 'fs' import");
    // Node built-in 'fs' is not relative
    assert.strictEqual(fsImport.isRelative, false);
    assert.ok(
      fsImport.imports.includes("readFileSync") ||
        fsImport.namedImports?.includes("readFileSync"),
      "Should have readFileSync in imports",
    );

    const loggerImport = imports.find((i: any) =>
      i.specifier.includes("logger"),
    );
    assert.ok(loggerImport, "Should find logger import");
    assert.strictEqual(loggerImport.isRelative, true);

    // Verify all imports have expected shape
    for (const imp of imports) {
      assert.ok(typeof imp.specifier === "string", "specifier should be string");
      assert.ok(typeof imp.isRelative === "boolean", "isRelative should be boolean");
      assert.ok(Array.isArray(imp.imports), "imports should be array");
    }

    if (typeof (tree as any).delete === "function") {
      (tree as any).delete();
    }
  });

  it("extracts calls from TypeScript code", () => {
    const adapter = getAdapterForExtension(".ts");
    assert.ok(adapter);

    const code = `
function helper() { return 42; }

export function main() {
  const result = helper();
  console.log(result);
}
`.trim();

    const tree = adapter.parse(code, "test.ts");
    assert.ok(tree);

    const symbols = adapter.extractSymbols(tree, code, "test.ts");
    const calls = adapter.extractCalls(tree, code, "test.ts", symbols as any);
    assert.ok(calls.length >= 1, `Expected at least 1 call, got ${calls.length}`);

    const helperCall = calls.find(
      (c: any) => c.calleeIdentifier === "helper",
    );
    assert.ok(helperCall, "Should find call to 'helper'");

    if (typeof (tree as any).delete === "function") {
      (tree as any).delete();
    }
  });

  it("handles parse errors gracefully", () => {
    const adapter = getAdapterForExtension(".ts");
    assert.ok(adapter);

    // Severely malformed TypeScript
    const code = "}{][export function ??? {}}}";
    const tree = adapter.parse(code, "broken.ts");

    // Adapter.parse typically returns a tree even for broken code (tree-sitter
    // is error-tolerant). The tree's rootNode.hasError indicates parse issues.
    if (tree) {
      const symbols = adapter.extractSymbols(tree, code, "broken.ts");
      // Malformed code may extract some symbols or none — either is acceptable
      assert.ok(Array.isArray(symbols), "Should return an array even for broken code");
      if (typeof (tree as any).delete === "function") {
        (tree as any).delete();
      }
    }
    // If parse returns null, that is also valid behavior
  });
});

describe("process-file — ProcessFileParams type contract", () => {
  it("has required fields", () => {
    const params: ProcessFileParams = {
      repoId: "test-repo",
      repoRoot: "/tmp/repo",
      fileMeta: { path: "src/index.ts", size: 1024, mtime: Date.now() },
      languages: ["ts", "js"],
      mode: "full",
    };

    assert.strictEqual(params.repoId, "test-repo");
    assert.strictEqual(params.mode, "full");
    assert.strictEqual(params.fileMeta.path, "src/index.ts");
  });

  it("accepts incremental mode with existing file info", () => {
    const params: ProcessFileParams = {
      repoId: "test-repo",
      repoRoot: "/tmp/repo",
      fileMeta: { path: "src/utils.ts", size: 512, mtime: Date.now() },
      languages: ["ts"],
      mode: "incremental",
      existingFile: {
        fileId: "test-repo:src/utils.ts",
        contentHash: "abc123",
        lastIndexedAt: new Date().toISOString(),
      },
    };

    assert.strictEqual(params.mode, "incremental");
    assert.ok(params.existingFile);
    assert.strictEqual(params.existingFile!.contentHash, "abc123");
  });

  it("accepts optional call resolution fields", () => {
    const symbolIndex = new Map();
    const pendingCallEdges: any[] = [];
    const createdCallEdges = new Set<string>();

    const params: ProcessFileParams = {
      repoId: "test-repo",
      repoRoot: "/tmp/repo",
      fileMeta: { path: "src/main.ts", size: 200, mtime: Date.now() },
      languages: ["ts"],
      mode: "full",
      symbolIndex: symbolIndex as any,
      pendingCallEdges,
      createdCallEdges,
      skipCallResolution: true,
    };

    assert.strictEqual(params.skipCallResolution, true);
    assert.ok(params.symbolIndex);
    assert.ok(params.createdCallEdges);
  });
});
