import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RepoConfig } from "../../dist/config/types.js";
import {
  _buildTestRefSymbolLookupForTesting,
  _getTestRefCachePathForTesting,
  clearTestRefCache,
  collectTestRefs,
} from "../../dist/graph/metrics.js";

describe("test reference cache", () => {
  it("persists matched test symbols for reuse across CLI processes", async () => {
    const repoRoot = join(
      tmpdir(),
      `sdl-mcp-test-ref-cache-${process.pid}-${Date.now()}`,
    );
    const config = {
      languages: ["ts"],
      ignore: [],
    } as RepoConfig;
    const cachePath = _getTestRefCachePathForTesting(repoRoot);

    try {
      rmSync(cachePath, { force: true });
      clearTestRefCache(repoRoot);
      await mkdir(join(repoRoot, "tests"), { recursive: true });
      await writeFile(
        join(repoRoot, "tests", "alpha.test.ts"),
        "alpha();\nbeta();\n",
        "utf8",
      );

      const refs = await collectTestRefs(
        repoRoot,
        [
          { symbolId: "symbol-alpha", name: "alpha" },
          { symbolId: "symbol-beta", name: "beta" },
          { symbolId: "symbol-gamma", name: "gamma" },
        ],
        config,
      );

      assert.deepEqual(Array.from(refs.get("symbol-alpha") ?? []), [
        "tests/alpha.test.ts",
      ]);
      assert.deepEqual(Array.from(refs.get("symbol-beta") ?? []), [
        "tests/alpha.test.ts",
      ]);
      assert.equal(refs.has("symbol-gamma"), false);

      assert.equal(existsSync(cachePath), true);
      const persisted = JSON.parse(await readFile(cachePath, "utf8")) as {
        version: number;
        testRefs: Record<string, string[]>;
      };
      assert.equal(persisted.version, 1);
      assert.deepEqual(persisted.testRefs["tests/alpha.test.ts"].sort(), [
        "alpha",
        "beta",
      ]);

      clearTestRefCache(repoRoot);
      const rehydrated = await collectTestRefs(
        repoRoot,
        [{ symbolId: "renamed-alpha", name: "alpha" }],
        config,
      );
      assert.deepEqual(Array.from(rehydrated.get("renamed-alpha") ?? []), [
        "tests/alpha.test.ts",
      ]);
    } finally {
      clearTestRefCache(repoRoot);
      rmSync(cachePath, { force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("ignores duplicate-heavy symbol names when collecting test refs", async () => {
    const repoRoot = join(
      tmpdir(),
      `sdl-mcp-test-ref-duplicates-${process.pid}-${Date.now()}`,
    );
    const config = {
      languages: ["ts"],
      ignore: [],
    } as RepoConfig;
    const cachePath = _getTestRefCachePathForTesting(repoRoot);

    try {
      rmSync(cachePath, { force: true });
      clearTestRefCache(repoRoot);
      await mkdir(join(repoRoot, "tests"), { recursive: true });
      await writeFile(
        join(repoRoot, "tests", "duplicate.test.ts"),
        "sharedName();\nuniqueTarget();\n",
        "utf8",
      );

      const duplicateSymbols = Array.from({ length: 300 }, (_, index) => ({
        symbolId: `shared-${index}`,
        name: "sharedName",
      }));

      const refs = await collectTestRefs(
        repoRoot,
        [
          ...duplicateSymbols,
          { symbolId: "symbol-unique", name: "uniqueTarget" },
        ],
        config,
      );

      assert.equal(refs.has("shared-0"), false);
      assert.deepEqual(Array.from(refs.get("symbol-unique") ?? []), [
        "tests/duplicate.test.ts",
      ]);
    } finally {
      clearTestRefCache(repoRoot);
      rmSync(cachePath, { force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("builds test-ref symbol lookup only for names seen in tests", () => {
    const lookup = _buildTestRefSymbolLookupForTesting(
      [
        { symbolId: "used-1", name: "usedName" },
        { symbolId: "unused-1", name: "unusedName" },
        ...Array.from({ length: 300 }, (_, index) => ({
          symbolId: `too-common-${index}`,
          name: "tooCommon",
        })),
      ],
      new Set(["usedName", "tooCommon"]),
    );

    assert.deepEqual(Array.from(lookup.symbolNames), ["usedName"]);
    assert.deepEqual(lookup.nameToSymbolIds.get("usedName"), ["used-1"]);
    assert.equal(lookup.nameToSymbolIds.has("unusedName"), false);
    assert.equal(lookup.nameToSymbolIds.has("tooCommon"), false);
  });

  it("can use indexed repo files instead of filesystem glob discovery", async () => {
    const repoRoot = join(
      tmpdir(),
      `sdl-mcp-test-ref-indexed-files-${process.pid}-${Date.now()}`,
    );
    const config = {
      languages: ["ts"],
      ignore: [],
    } as RepoConfig;
    const cachePath = _getTestRefCachePathForTesting(repoRoot);

    try {
      rmSync(cachePath, { force: true });
      clearTestRefCache(repoRoot);
      await mkdir(join(repoRoot, "tests"), { recursive: true });
      await writeFile(
        join(repoRoot, "tests", "indexed.test.ts"),
        "indexedOnly();\n",
        "utf8",
      );
      await writeFile(
        join(repoRoot, "tests", "outside-scan.test.ts"),
        "outsideScan();\n",
        "utf8",
      );

      const refs = await collectTestRefs(
        repoRoot,
        [
          { symbolId: "symbol-indexed", name: "indexedOnly" },
          { symbolId: "symbol-outside", name: "outsideScan" },
        ],
        config,
        undefined,
        ["tests/indexed.test.ts"],
      );

      assert.deepEqual(Array.from(refs.get("symbol-indexed") ?? []), [
        "tests/indexed.test.ts",
      ]);
      assert.equal(refs.has("symbol-outside"), false);
    } finally {
      clearTestRefCache(repoRoot);
      rmSync(cachePath, { force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reuses cached refs from indexed content hashes without touching the filesystem", async () => {
    const repoRoot = join(
      tmpdir(),
      `sdl-mcp-test-ref-indexed-hash-${process.pid}-${Date.now()}`,
    );
    const config = {
      languages: ["ts"],
      ignore: [],
    } as RepoConfig;
    const cachePath = _getTestRefCachePathForTesting(repoRoot);

    try {
      rmSync(cachePath, { force: true });
      clearTestRefCache(repoRoot);
      await mkdir(join(repoRoot, "tests"), { recursive: true });
      await writeFile(
        join(repoRoot, "tests", "cached.test.ts"),
        "cachedTarget();\n",
        "utf8",
      );

      await collectTestRefs(
        repoRoot,
        [{ symbolId: "symbol-cached", name: "cachedTarget" }],
        config,
      );
      const persisted = JSON.parse(await readFile(cachePath, "utf8")) as {
        fileHashes: Record<string, string>;
      };
      const cachedHash = persisted.fileHashes["tests/cached.test.ts"];
      assert.equal(typeof cachedHash, "string");

      rmSync(join(repoRoot, "tests", "cached.test.ts"), { force: true });
      clearTestRefCache(repoRoot);

      const refs = await collectTestRefs(
        repoRoot,
        [{ symbolId: "symbol-cached-renamed", name: "cachedTarget" }],
        config,
        undefined,
        ["tests/cached.test.ts"],
        new Map([["tests/cached.test.ts", cachedHash]]),
      );

      assert.deepEqual(Array.from(refs.get("symbol-cached-renamed") ?? []), [
        "tests/cached.test.ts",
      ]);
    } finally {
      clearTestRefCache(repoRoot);
      rmSync(cachePath, { force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
