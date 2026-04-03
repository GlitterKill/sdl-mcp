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
});
