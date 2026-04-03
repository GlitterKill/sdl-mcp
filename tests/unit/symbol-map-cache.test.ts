import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import type { FileRow, SymbolLiteRow } from "../../dist/db/ladybug-queries.js";
import {
  applySymbolMapFileUpdates,
  buildSymbolMapCacheFromRows,
  clearSymbolMapCache,
  getCachedSymbolMap,
  removeFilesFromSymbolMapCache,
  syncSymbolIndexFromCache,
} from "../../dist/indexer/symbol-map-cache.js";

describe("symbol map cache", () => {
  afterEach(() => {
    clearSymbolMapCache();
  });

  it("hydrates cache state from repo files and symbol rows", () => {
    const cache = buildSymbolMapCacheFromRows({
      repoId: "repo-1",
      files: [
        createFileRow("repo-1", "src/a.ts"),
        createFileRow("repo-1", "src/b.ts"),
      ],
      symbols: [
        createLiteSymbol("repo-1", "src/a.ts", "alpha-1", "alpha", "function", true),
        createLiteSymbol("repo-1", "src/b.ts", "alpha-2", "alpha", "function", false),
        createLiteSymbol("repo-1", "src/b.ts", "beta-1", "beta", "class", true),
      ],
    });

    assert.equal(getCachedSymbolMap("repo-1"), cache);
    assert.equal(cache.allSymbolsByName.get("alpha")?.length, 2);
    assert.deepEqual(cache.globalNameToSymbolIds.get("beta"), ["beta-1"]);
    assert.equal(cache.globalPreferredSymbolId.get("alpha"), "alpha-1");
    assert.deepEqual(
      cache.symbolIndex.get("src/b.ts")?.get("beta")?.get("class"),
      ["beta-1"],
    );
  });

  it("removes deleted files and applies changed-file symbol deltas without a repo reload", () => {
    const cache = buildSymbolMapCacheFromRows({
      repoId: "repo-2",
      files: [
        createFileRow("repo-2", "src/a.ts"),
        createFileRow("repo-2", "src/b.ts"),
      ],
      symbols: [
        createLiteSymbol("repo-2", "src/a.ts", "alpha-1", "alpha", "function", true),
        createLiteSymbol("repo-2", "src/b.ts", "beta-1", "beta", "class", true),
      ],
    });

    removeFilesFromSymbolMapCache(cache, ["repo-2:src/b.ts"]);
    applySymbolMapFileUpdates(cache, [
      {
        fileId: "repo-2:src/a.ts",
        relPath: "src/a.ts",
        symbols: [
          createLiteSymbol("repo-2", "src/a.ts", "alpha-2", "alpha", "function", false),
          createLiteSymbol("repo-2", "src/a.ts", "gamma-1", "gamma", "interface", true),
        ],
      },
    ]);

    const refreshedSymbolIndex = new Map();
    syncSymbolIndexFromCache(cache, refreshedSymbolIndex);

    assert.equal(cache.allSymbolsByName.has("beta"), false);
    assert.deepEqual(cache.globalNameToSymbolIds.get("alpha"), ["alpha-2"]);
    assert.equal(cache.globalPreferredSymbolId.has("alpha"), false);
    assert.deepEqual(
      refreshedSymbolIndex.get("src/a.ts")?.get("gamma")?.get("interface"),
      ["gamma-1"],
    );
    assert.equal(refreshedSymbolIndex.has("src/b.ts"), false);
  });

  it("clears repo-scoped cache entries", () => {
    buildSymbolMapCacheFromRows({
      repoId: "repo-3",
      files: [createFileRow("repo-3", "src/a.ts")],
      symbols: [createLiteSymbol("repo-3", "src/a.ts", "alpha-1", "alpha", "function", true)],
    });
    buildSymbolMapCacheFromRows({
      repoId: "repo-4",
      files: [createFileRow("repo-4", "src/b.ts")],
      symbols: [createLiteSymbol("repo-4", "src/b.ts", "beta-1", "beta", "function", true)],
    });

    clearSymbolMapCache("repo-3");

    assert.equal(getCachedSymbolMap("repo-3"), undefined);
    assert.ok(getCachedSymbolMap("repo-4"));
  });
});

function createFileRow(repoId: string, relPath: string): FileRow {
  return {
    fileId: `${repoId}:${relPath}`,
    repoId,
    relPath,
    contentHash: `hash:${relPath}`,
    language: relPath.endsWith(".ts") ? "ts" : "txt",
    byteSize: 128,
    lastIndexedAt: "2026-04-02T00:00:00.000Z",
    directory: relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "",
  };
}

function createLiteSymbol(
  repoId: string,
  relPath: string,
  symbolId: string,
  name: string,
  kind: string,
  exported: boolean,
): SymbolLiteRow {
  return {
    symbolId,
    repoId,
    fileId: `${repoId}:${relPath}`,
    name,
    kind,
    exported,
  };
}
