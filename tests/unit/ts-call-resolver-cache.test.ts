import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  clearTsCallResolverCache,
  createTsCallResolver,
  getTsCallResolverCacheBuildId,
} from "../../dist/indexer/ts/tsParser.js";

describe("ts call resolver cache", () => {
  const tempDirs: string[] = [];

  const makeRepo = (): string => {
    const repoDir = mkdtempSync(join(tmpdir(), "sdl-ts-resolver-cache-"));
    tempDirs.push(repoDir);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "index.ts"),
      [
        "export function greet(name: string): string {",
        "  return `hello ${name}`;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    return repoDir;
  };

  const createFiles = (paths: string[]) =>
    paths.map((relPath, index) => ({
      path: relPath,
      size: 100 + index,
      mtime: Date.now() + index,
    }));

  afterEach(() => {
    clearTsCallResolverCache();
    while (tempDirs.length > 0) {
      const repoDir = tempDirs.pop();
      if (repoDir) {
        rmSync(repoDir, { recursive: true, force: true });
      }
    }
  });

  it("reuses the cached program when file set and options are unchanged", () => {
    const repoDir = makeRepo();
    const files = createFiles(["src/index.ts"]);

    const resolverA = createTsCallResolver(repoDir, files, {
      includeNodeModulesTypes: false,
    });
    assert.ok(resolverA);
    const firstBuildId = getTsCallResolverCacheBuildId(repoDir);
    assert.ok(firstBuildId);

    const resolverB = createTsCallResolver(repoDir, files, {
      includeNodeModulesTypes: false,
    });
    assert.ok(resolverB);
    const secondBuildId = getTsCallResolverCacheBuildId(repoDir);

    assert.equal(secondBuildId, firstBuildId);
  });

  it("rebuilds the cached program when dirty files are provided", () => {
    const repoDir = makeRepo();
    const files = createFiles(["src/index.ts"]);

    const resolverA = createTsCallResolver(repoDir, files, {
      includeNodeModulesTypes: false,
    });
    assert.ok(resolverA);
    const firstBuildId = getTsCallResolverCacheBuildId(repoDir);
    assert.ok(firstBuildId);

    const resolverB = createTsCallResolver(repoDir, files, {
      includeNodeModulesTypes: false,
      dirtyRelPaths: ["src/index.ts"],
    });
    assert.ok(resolverB);
    const secondBuildId = getTsCallResolverCacheBuildId(repoDir);
    assert.ok(secondBuildId);

    assert.notEqual(secondBuildId, firstBuildId);
  });

  it("rebuilds the cached program when the file set changes", () => {
    const repoDir = makeRepo();
    writeFileSync(
      join(repoDir, "src", "extra.ts"),
      "export const extra = 1;\n",
      "utf8",
    );

    const initialFiles = createFiles(["src/index.ts"]);
    const expandedFiles = createFiles(["src/index.ts", "src/extra.ts"]);

    const resolverA = createTsCallResolver(repoDir, initialFiles, {
      includeNodeModulesTypes: false,
    });
    assert.ok(resolverA);
    const firstBuildId = getTsCallResolverCacheBuildId(repoDir);
    assert.ok(firstBuildId);

    const resolverB = createTsCallResolver(repoDir, expandedFiles, {
      includeNodeModulesTypes: false,
    });
    assert.ok(resolverB);
    const secondBuildId = getTsCallResolverCacheBuildId(repoDir);
    assert.ok(secondBuildId);

    assert.notEqual(secondBuildId, firstBuildId);
  });

  it("preserves the cached program across hybrid Pass-1 fallback (tsResolver=null path)", () => {
    // Simulates the Task 1.1 Rust→TS fallback scenario: Pass-1 runs per-file
    // with `tsResolver: null` for both pure-Rust and fallback files. The shared
    // `TsCallResolver` is created once by indexer.ts after Pass-1 and must be
    // reused across Pass-2 calls on individual files without rebuilding the
    // underlying ts.Program.
    const repoDir = makeRepo();
    writeFileSync(
      join(repoDir, "src", "extra.ts"),
      "export const extra = 1;\n",
      "utf8",
    );
    const files = createFiles(["src/index.ts", "src/extra.ts"]);

    // Indexer.ts builds the resolver lazily once after Pass-1.
    const resolver = createTsCallResolver(repoDir, files, {
      includeNodeModulesTypes: false,
    });
    assert.ok(resolver);
    const initialBuildId = getTsCallResolverCacheBuildId(repoDir);
    assert.ok(initialBuildId);

    // Pass-2 resolves calls file-by-file; each call must reuse the cached program.
    const firstCalls = resolver.getResolvedCalls("src/index.ts");
    assert.ok(Array.isArray(firstCalls));
    const buildIdAfterFirstCall = getTsCallResolverCacheBuildId(repoDir);
    assert.equal(buildIdAfterFirstCall, initialBuildId);

    const secondCalls = resolver.getResolvedCalls("src/extra.ts");
    assert.ok(Array.isArray(secondCalls));
    const buildIdAfterSecondCall = getTsCallResolverCacheBuildId(repoDir);
    assert.equal(buildIdAfterSecondCall, initialBuildId);

    // A second indexer.ts-style lazy creation with identical inputs must also
    // reuse the cache — hybrid Pass-1 never calls invalidateFiles on
    // fallback files, so the next index cycle sees the same program.
    const resolverAgain = createTsCallResolver(repoDir, files, {
      includeNodeModulesTypes: false,
    });
    assert.ok(resolverAgain);
    const finalBuildId = getTsCallResolverCacheBuildId(repoDir);
    assert.equal(finalBuildId, initialBuildId);
  });
});