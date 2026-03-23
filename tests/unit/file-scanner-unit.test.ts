import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scanRepository } from "../../dist/indexer/fileScanner.js";
import type { RepoConfig } from "../../dist/config/types.js";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdl-mcp-file-scanner-test-"));
  tempDirs.push(dir);
  return dir;
}

function repoConfig(
  repoPath: string,
  overrides: Partial<RepoConfig> = {},
): RepoConfig {
  return {
    repoId: "repo-test",
    rootPath: repoPath,
    ignore: [],
    languages: ["ts"],
    maxFileBytes: 1_000_000,
    includeNodeModulesTypes: true,
    packageJsonPath: null,
    tsconfigPath: null,
    workspaceGlobs: null,
    ...overrides,
  };
}

describe("fileScanner.scanRepository", () => {
  before(() => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
  });

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("returns an empty array for an empty repository", async () => {
    const repoPath = makeTempRepo();

    const files = await scanRepository(repoPath, repoConfig(repoPath));

    assert.deepStrictEqual(files, []);
  });

  it("discovers files matching configured language extensions", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "a.ts"), "export const a = 1;", "utf8");
    writeFileSync(join(repoPath, "src", "b.ts"), "export const b = 2;", "utf8");
    writeFileSync(join(repoPath, "src", "ignore.py"), "print('x')", "utf8");

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, { languages: ["ts"] }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/a.ts", "src/b.ts"],
    );
    assert.ok(files.every((f) => f.size > 0));
    assert.ok(files.every((f) => f.mtime > 0));
  });

  it("returns metadata sorted by normalized path", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src", "z"), { recursive: true });
    mkdirSync(join(repoPath, "src", "a"), { recursive: true });
    writeFileSync(join(repoPath, "src", "z", "later.ts"), "z", "utf8");
    writeFileSync(join(repoPath, "src", "a", "first.ts"), "a", "utf8");

    const files = await scanRepository(repoPath, repoConfig(repoPath));

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/a/first.ts", "src/z/later.ts"],
    );
  });

  it("respects ignore patterns from repository config", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(
      join(repoPath, "src", "keep.ts"),
      "export const keep = true;",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "src", "skip.ts"),
      "export const skip = true;",
      "utf8",
    );

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, { ignore: ["**/skip.ts"] }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/keep.ts"],
    );
  });

  it("filters out files larger than maxFileBytes", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "small.ts"), "x", "utf8");
    writeFileSync(join(repoPath, "src", "large.ts"), "x".repeat(2048), "utf8");

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, { maxFileBytes: 100 }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/small.ts"],
    );
  });

  it("deduplicates compiled js files when ts counterparts exist", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(
      join(repoPath, "src", "api.ts"),
      "export const api = 1;",
      "utf8",
    );
    writeFileSync(join(repoPath, "src", "api.js"), "exports.api = 1;", "utf8");
    writeFileSync(
      join(repoPath, "src", "runtime.js"),
      "exports.runtime = true;",
      "utf8",
    );

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, { languages: ["ts", "js"] }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/api.ts", "src/runtime.js"],
    );
  });

  it("auto-detects workspaces and ignores workspace node_modules/dist/build", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "packages", "pkg-a", "src"), { recursive: true });
    mkdirSync(join(repoPath, "packages", "pkg-a", "dist"), { recursive: true });
    mkdirSync(join(repoPath, "packages", "pkg-a", "build"), {
      recursive: true,
    });
    mkdirSync(join(repoPath, "packages", "pkg-a", "node_modules", "lib"), {
      recursive: true,
    });

    writeFileSync(
      join(repoPath, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }, null, 2),
      "utf8",
    );
    writeFileSync(
      join(repoPath, "packages", "pkg-a", "src", "keep.ts"),
      "k",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "packages", "pkg-a", "dist", "skip.ts"),
      "d",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "packages", "pkg-a", "build", "skip.ts"),
      "b",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "packages", "pkg-a", "node_modules", "lib", "skip.ts"),
      "n",
      "utf8",
    );

    const files = await scanRepository(repoPath, repoConfig(repoPath));

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["packages/pkg-a/src/keep.ts"],
    );
  });
});
