import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scanRepository } from "../../dist/indexer/fileScanner.js";
import { scanRepoForIndex } from "../../dist/indexer/scanner.js";
import { createAsyncFsOperations } from "../../dist/util/asyncFs.js";
import { RepoConfigSchema, type RepoConfig } from "../../dist/config/types.js";

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

  it("strict inventory accepts an absent implicit package.json", async () => {
    const repoPath = makeTempRepo();
    writeFileSync(join(repoPath, "a.ts"), "export const a = 1;");
    const files = await scanRepository(repoPath, repoConfig(repoPath), {
      requireComplete: true,
    });
    assert.deepStrictEqual(files.map((file) => file.path), ["a.ts"]);
  });

  it("strict inventory rejects missing listed files instead of treating them as removals", async () => {
    const repoPath = makeTempRepo();
    writeFileSync(join(repoPath, "files.txt"), "missing.ts\n");
    const config = repoConfig(repoPath, { sourceFileListPath: "files.txt" });
    assert.deepStrictEqual(await scanRepository(repoPath, config), []);
    await assert.rejects(scanRepository(repoPath, config, { requireComplete: true }),
      { code: "ENOENT" });
  });

  it("strict inventory rejects unreadable listed content after discovery", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "directory.ts"));
    writeFileSync(join(repoPath, "files.txt"), "directory.ts\n");
    const config = repoConfig(repoPath, { sourceFileListPath: "files.txt" });
    assert.deepStrictEqual(await scanRepository(repoPath, config), []);
    await assert.rejects(scanRepository(repoPath, config, { requireComplete: true }),
      { code: "EISDIR" });
  });

  it("strict inventory rejects malformed or unavailable workspace inputs", async () => {
    const repoPath = makeTempRepo();
    writeFileSync(join(repoPath, "package.json"), "{");
    assert.deepStrictEqual(await scanRepository(repoPath, repoConfig(repoPath)), []);
    await assert.rejects(scanRepository(repoPath, repoConfig(repoPath), {
      requireComplete: true,
    }), SyntaxError);
    await assert.rejects(scanRepository(repoPath, repoConfig(repoPath, {
      packageJsonPath: "missing-package.json",
    }), { requireComplete: true }), { code: "ENOENT" });
    mkdirSync(join(repoPath, "package-directory"));
    await assert.rejects(scanRepository(repoPath, repoConfig(repoPath, {
      packageJsonPath: "package-directory",
    }), { requireComplete: true }), { code: "EISDIR" });
  });

  it("read-only inventory rejects incomplete scans before accessing graph storage", async () => {
    const repoPath = makeTempRepo();
    writeFileSync(join(repoPath, "package.json"), "{");
    // No database is initialized in this scanner fixture.
    await assert.rejects(scanRepoForIndex({
      repoId: "strict-inventory-without-db",
      repoRoot: repoPath,
      config: repoConfig(repoPath),
      deleteRemovedFiles: false,
      requireComplete: true,
    }), SyntaxError);
  });

  it("strict inventory drains stat and content reads before reporting a sibling failure", { timeout: 5_000 }, async (t) => {
    const prototype = Object.getPrototypeOf(createAsyncFsOperations());
    for (const method of ["stat", "readFileBuffer"] as const) {
      await t.test(method, async (context) => {
        const repoPath = makeTempRepo();
        writeFileSync(join(repoPath, "held.ts"), "x");
        writeFileSync(join(repoPath, "failed.ts"), "x");
        const original = prototype[method];
        let release!: () => void;
        let entered!: () => void;
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const failure = new Error(`controlled ${method} failure`);
        context.mock.method(prototype, method, async function (filePath: string) {
          if (filePath === join(repoPath, "failed.ts")) throw failure;
          if (filePath === join(repoPath, "held.ts")) {
            entered();
            await barrier;
          }
          return original.call(this, filePath);
        });
        let settled = false;
        const scan = scanRepository(repoPath, repoConfig(repoPath), { requireComplete: true });
        const outcome = scan.then(
          (files) => { settled = true; return files; },
          (error) => { settled = true; throw error; },
        );
        // Register rejection observation before releasing the held sibling.
        const rejected = assert.rejects(outcome, (error) => error === failure);
        try {
          await started;
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(settled, false);
        } finally {
          release();
        }
        await rejected;
      });
    }
  });

  it("strict inventory preserves language, ignore, size, workspace and TS/JS selection", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "packages", "a", "dist"), { recursive: true });
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    for (const name of ["a.ts", "a.js", "skip.ts", "other.py", "packages/a/dist/output.ts"]) {
      writeFileSync(join(repoPath, name), "x");
    }
    writeFileSync(join(repoPath, "large.ts"), "x".repeat(101));
    const config = repoConfig(repoPath, { languages: ["ts", "js"], ignore: ["**/skip.ts"], maxFileBytes: 100 });
    const normal = await scanRepository(repoPath, config);
    const strict = await scanRepository(repoPath, config, { requireComplete: true });
    assert.deepStrictEqual(strict, normal);
    assert.deepStrictEqual(strict.map((file) => file.path), ["a.ts"]);
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

  it("uses an explicit source file list for deterministic benchmark scans", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "a.ts"), "export const a = 1;", "utf8");
    writeFileSync(join(repoPath, "src", "b.ts"), "export const b = 2;", "utf8");
    writeFileSync(join(repoPath, "src", "c.ts"), "export const c = 3;", "utf8");
    const listPath = join(repoPath, "subset.txt");
    writeFileSync(
      listPath,
      ["# benchmark subset", "src/c.ts", "src/a.ts", "../unsafe.ts", ""].join(
        "\n",
      ),
      "utf8",
    );

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, { sourceFileListPath: listPath }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/a.ts", "src/c.ts"],
    );
  });

  it("discovers all built-in adapter extensions for configured C and C++ languages", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    for (const fileName of [
      "main.cpp",
      "extra.cc",
      "legacy.cxx",
      "api.hpp",
      "detail.hh",
      "compat.hxx",
      "bridge.c",
      "bridge.h",
      "skip.py",
    ]) {
      writeFileSync(join(repoPath, "src", fileName), fileName, "utf8");
    }

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, { languages: ["c", "cpp"] }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      [
        "src/api.hpp",
        "src/bridge.c",
        "src/bridge.h",
        "src/compat.hxx",
        "src/detail.hh",
        "src/extra.cc",
        "src/legacy.cxx",
        "src/main.cpp",
      ],
    );
  });

  it("discovers SCIP-emitted C and C++ companion files for configured C++", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    for (const fileName of [
      "api.h",
      "bridge.c",
      "fragments.inc",
      "table.def",
      "main.cpp",
      "skip.py",
    ]) {
      writeFileSync(join(repoPath, "src", fileName), fileName, "utf8");
    }

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, { languages: ["cpp"] }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      [
        "src/api.h",
        "src/bridge.c",
        "src/fragments.inc",
        "src/main.cpp",
        "src/table.def",
      ],
    );
  });

  it("default ignores generated CMake build-output directories", async () => {
    const repoPath = makeTempRepo();
    for (const relativeDir of [
      "src",
      "build-scip-io-llvm-all-targets",
      "build_scip_llvm",
      "cmake-build-debug",
      "out-scip-io",
    ]) {
      mkdirSync(join(repoPath, relativeDir), { recursive: true });
    }
    writeFileSync(join(repoPath, "src", "main.cpp"), "int main() {}", "utf8");
    writeFileSync(
      join(repoPath, "build-scip-io-llvm-all-targets", "generated.cpp"),
      "int generated() {}",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "build_scip_llvm", "generated.cpp"),
      "int generated() {}",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "cmake-build-debug", "generated.cpp"),
      "int generated() {}",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "out-scip-io", "generated.cpp"),
      "int generated() {}",
      "utf8",
    );

    const files = await scanRepository(
      repoPath,
      RepoConfigSchema.parse({
        repoId: "repo-test",
        rootPath: repoPath,
        languages: ["cpp"],
      }),
    );

    assert.deepStrictEqual(
      files.map((file) => file.path),
      ["src/main.cpp"],
    );
  });

  it("discovers Python stub files for configured Python", async () => {
    const repoPath = makeTempRepo();
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src", "api.py"), "def api(): ...", "utf8");
    writeFileSync(
      join(repoPath, "src", "api.pyi"),
      "def api() -> None: ...",
      "utf8",
    );
    writeFileSync(join(repoPath, "src", "skip.ts"), "export {}", "utf8");

    const files = await scanRepository(
      repoPath,
      repoConfig(repoPath, { languages: ["py"] }),
    );

    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/api.py", "src/api.pyi"],
    );
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
