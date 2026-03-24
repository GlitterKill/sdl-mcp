import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scanRepository } from "../../dist/indexer/fileScanner.js";
import type { RepoConfig } from "../../dist/config/types.js";

/**
 * Validates node:fs glob() exclude behavior matches expectations from
 * the fast-glob → node:fs migration (Node 24). These tests exercise
 * common ignore patterns that could behave differently between the two
 * implementations.
 */

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdl-mcp-glob-compat-"));
  tempDirs.push(dir);
  return dir;
}

function repoConfig(
  repoPath: string,
  overrides: Partial<RepoConfig> = {},
): RepoConfig {
  return {
    repoId: "repo-glob-test",
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

describe("fileScanner glob exclude compatibility (fast-glob → node:fs)", () => {
  before(() => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
  });

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("excludes **/node_modules/** at any depth", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "node_modules", "pkg", "src"), { recursive: true });
    mkdirSync(join(repoPath, "src", "node_modules", "nested"), { recursive: true });

    writeFileSync(join(repoPath, "src", "keep.ts"), "export const k = 1;", "utf8");
    writeFileSync(join(repoPath, "node_modules", "pkg", "src", "skip.ts"), "x", "utf8");
    writeFileSync(join(repoPath, "src", "node_modules", "nested", "skip.ts"), "x", "utf8");

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, { ignore: ["**/node_modules/**"] }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/keep.ts"],
    );
  });

  it("excludes nested directory patterns", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "dist"), { recursive: true });
    mkdirSync(join(repoPath, "packages", "core", "dist"), { recursive: true });
    mkdirSync(join(repoPath, ".next"), { recursive: true });

    writeFileSync(join(repoPath, "src", "app.ts"), "export const app = 1;", "utf8");
    writeFileSync(join(repoPath, "dist", "app.ts"), "compiled", "utf8");
    writeFileSync(join(repoPath, "packages", "core", "dist", "index.ts"), "compiled", "utf8");
    writeFileSync(join(repoPath, ".next", "server.ts"), "next", "utf8");

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, {
        ignore: ["**/dist/**", "**/.next/**"],
      }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/app.ts"],
    );
  });

  it("excludes specific file patterns", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });

    writeFileSync(join(repoPath, "src", "main.ts"), "main", "utf8");
    writeFileSync(join(repoPath, "src", "main.test.ts"), "test", "utf8");
    writeFileSync(join(repoPath, "src", "utils.spec.ts"), "spec", "utf8");
    writeFileSync(join(repoPath, "src", "utils.ts"), "utils", "utf8");

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, {
        ignore: ["**/*.test.ts", "**/*.spec.ts"],
      }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/main.ts", "src/utils.ts"],
    );
  });

  it("handles multiple ignore patterns simultaneously", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "build"), { recursive: true });
    mkdirSync(join(repoPath, "coverage"), { recursive: true });
    mkdirSync(join(repoPath, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(repoPath, "target"), { recursive: true });

    writeFileSync(join(repoPath, "src", "index.ts"), "src", "utf8");
    writeFileSync(join(repoPath, "build", "index.ts"), "build", "utf8");
    writeFileSync(join(repoPath, "coverage", "lcov.ts"), "cov", "utf8");
    writeFileSync(join(repoPath, "node_modules", "dep", "index.ts"), "dep", "utf8");
    writeFileSync(join(repoPath, "target", "debug.ts"), "rust", "utf8");

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, {
        ignore: [
          "**/node_modules/**",
          "**/build/**",
          "**/coverage/**",
          "**/target/**",
        ],
      }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/index.ts"],
    );
  });

  it("discovers files across multiple language extensions", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });

    writeFileSync(join(repoPath, "src", "app.ts"), "ts", "utf8");
    writeFileSync(join(repoPath, "src", "legacy.js"), "js", "utf8");
    writeFileSync(join(repoPath, "src", "component.tsx"), "tsx", "utf8");
    writeFileSync(join(repoPath, "src", "data.json"), "json", "utf8");

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, { languages: ["ts", "js", "tsx"] }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/app.ts", "src/component.tsx", "src/legacy.js"],
    );
  });

  it("excludes dot directories when specified in ignore", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, ".git", "hooks"), { recursive: true });
    mkdirSync(join(repoPath, ".cache"), { recursive: true });

    writeFileSync(join(repoPath, "src", "index.ts"), "src", "utf8");
    writeFileSync(join(repoPath, ".git", "hooks", "pre-commit.ts"), "git", "utf8");
    writeFileSync(join(repoPath, ".cache", "temp.ts"), "cache", "utf8");

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, {
        ignore: ["**/.git/**", "**/.cache/**"],
      }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/index.ts"],
    );
  });
});
