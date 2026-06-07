/**
 * Unit tests for src/scip/scip-io-runner.ts.
 *
 * These tests exercise the runner without touching the network or installing
 * a real binary. They:
 *
 *   - Verify `detectScipIo` finds a stub on PATH and returns null when missing.
 *   - Verify `runScipIoIndex` spawns the configured binary with the right
 *     args, cwd, and exit-code handling, including timeout/abort behavior,
 *     by using a tiny Node script as the "scip-io" binary.
 *   - Verify the in-flight install lock single-flights concurrent calls.
 *
 * No real network calls, no real scip-io binary, no real refresh — that's
 * covered by tests/integration/scip-io-pre-refresh.test.ts.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  __SCIP_GENERATOR_CACHE_INTERNALS_FOR_TESTS,
  __resetInstallLockForTests,
  buildScipIoIndexArgs,
  detectScipIo,
  installScipIo,
  runScipIoBeforeIndex,
  runScipIoIndex,
  scipIoLanguagesForRepo,
  selectGeneratedScipIndexes,
  ScipIoInstallError,
} from "../../dist/scip/scip-io-runner.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * Create a stub "scip-io" executable inside `dir` that, when invoked, prints
 * a fixed line to stdout and exits with the supplied exit code.
 *
 * On Windows we generate a `.cmd` wrapper because `where` only finds files
 * with extensions in PATHEXT, and `.exe` requires a real PE binary. The
 * `.cmd` is named `scip-io.cmd` so the lookup logic (which strips `.exe`
 * before searching) still locates it via `where scip-io`.
 *
 * On Unix we generate a `bash` script and chmod 755.
 *
 * Returns the absolute path to the stub.
 */
function makeStubBinary(
  dir: string,
  opts: {
    exitCode?: number;
    sleepMs?: number;
    logFile?: string;
    writeIndexContent?: string;
    writeSplitIndexes?: Record<string, string>;
  } = {},
): string {
  const exitCode = opts.exitCode ?? 0;
  if (IS_WINDOWS) {
    const path = join(dir, "scip-io.cmd");
    const lines: string[] = ["@echo off", "echo scip-io stub invoked %*"];
    if (opts.writeIndexContent) {
      lines.push(`>"%CD%\\index.scip" echo ${opts.writeIndexContent}`);
    }
    for (const [name, content] of Object.entries(
      opts.writeSplitIndexes ?? {},
    )) {
      lines.push(`>"%CD%\\${name}" echo ${content}`);
    }
    if (opts.logFile) {
      // %CD% records the cwd; %* records all args. Useful for asserting
      // the runner passed the expected cwd and "index" arg.
      lines.push(`>>"${opts.logFile}" echo cwd=%CD% args=%*`);
    }
    if (opts.sleepMs) {
      // PowerShell's Start-Sleep is the most portable way to sleep.
      lines.push(
        `powershell -nop -c "Start-Sleep -Milliseconds ${opts.sleepMs}"`,
      );
    }
    lines.push(`exit /b ${exitCode}`);
    writeFileSync(path, lines.join("\r\n") + "\r\n", "utf-8");
    return path;
  }

  const path = join(dir, "scip-io");
  const lines: string[] = [
    "#!/usr/bin/env bash",
    'echo "scip-io stub invoked $@"',
  ];
  if (opts.writeIndexContent) {
    lines.push(`printf '%s' '${opts.writeIndexContent}' > "$PWD/index.scip"`);
  }
  for (const [name, content] of Object.entries(opts.writeSplitIndexes ?? {})) {
    const escapedContent = content.replaceAll("'", "'\\''");
    const escapedName = name.replaceAll("'", "'\\''");
    lines.push(`printf '%s' '${escapedContent}' > "$PWD/${escapedName}"`);
  }
  if (opts.logFile) {
    lines.push(`echo "cwd=$PWD args=$@" >> "${opts.logFile}"`);
  }
  if (opts.sleepMs) {
    lines.push(`sleep ${opts.sleepMs / 1000}`);
  }
  lines.push(`exit ${exitCode}`);
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  chmodSync(path, 0o755);
  return path;
}

describe("scip-io-runner: detectScipIo", () => {
  let tmp = "";
  const prevPath = process.env.PATH;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "scip-io-detect-"));
  });

  after(() => {
    process.env.PATH = prevPath;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("finds a stub binary on PATH", async () => {
    const stubDir = join(tmp, "bin-found");
    mkdirSync(stubDir, { recursive: true });
    makeStubBinary(stubDir);

    process.env.PATH = stubDir + delimiter + (prevPath ?? "");
    const result = await detectScipIo();
    assert.ok(result, "expected to find stub binary");
    assert.equal(result.source, "path");
    assert.match(result.binaryPath, /scip-io/);
  });

  it("resolves an explicit absolute binary path without PATH lookup", async () => {
    const stubDir = join(tmp, "bin-absolute");
    const emptyDir = join(tmp, "empty-for-absolute");
    mkdirSync(stubDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });
    const stub = makeStubBinary(stubDir);

    process.env.PATH = emptyDir;
    const result = await detectScipIo(stub);

    assert.ok(result, "expected to resolve explicit stub path");
    assert.equal(result.source, "path");
    assert.equal(result.binaryPath, stub);
  });

  it("returns null when binary is missing from PATH and managed dir", async () => {
    // Clean PATH so the only entry is a known-empty dir.
    const emptyDir = join(tmp, "empty-bin");
    mkdirSync(emptyDir, { recursive: true });
    process.env.PATH = emptyDir;

    // Use a binary name that cannot exist anywhere.
    const result = await detectScipIo("scip-io-test-no-such-binary-xyz");
    assert.equal(result, null);
  });
});

describe("scip-io-runner: runScipIoIndex", () => {
  let tmp = "";

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "scip-io-run-"));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("spawns the binary with cwd=repoRoot and 'index' as the first arg", async () => {
    const binDir = join(tmp, "bin1");
    const repoDir = join(tmp, "repo1");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const logFile = join(tmp, "invocation1.log");
    const stub = makeStubBinary(binDir, { exitCode: 0, logFile });

    const result = await runScipIoIndex({
      binaryPath: stub,
      repoRootPath: repoDir,
      timeoutMs: 30_000,
    });

    assert.equal(result.ok, true, `expected ok=true, stderr=${result.stderr}`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout ?? "", /scip-io stub invoked/);

    // Verify cwd and args via the log file the stub wrote.
    const log = (await import("node:fs")).readFileSync(logFile, "utf-8");
    assert.match(log, /args=.*index/, `log was: ${log}`);
    // The stub records cwd=%CD%/$PWD; on Windows this is the literal repoDir
    // path, on Unix it may be the realpath. Compare basenames to avoid
    // /private/tmp vs /tmp differences on macOS.
    const repoBase = (await import("node:path")).basename(repoDir);
    assert.match(log, new RegExp(repoBase));
  });

  it("returns ok=false on non-zero exit", async () => {
    const binDir = join(tmp, "bin2");
    const repoDir = join(tmp, "repo2");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const stub = makeStubBinary(binDir, { exitCode: 7 });

    const result = await runScipIoIndex({
      binaryPath: stub,
      repoRootPath: repoDir,
      timeoutMs: 30_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
  });

  it("times out and reports timedOut=true", async () => {
    const binDir = join(tmp, "bin3");
    const repoDir = join(tmp, "repo3");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const stub = makeStubBinary(binDir, { exitCode: 0, sleepMs: 5000 });

    const start = Date.now();
    const result = await runScipIoIndex({
      binaryPath: stub,
      repoRootPath: repoDir,
      timeoutMs: 500,
    });
    const elapsed = Date.now() - start;

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    // Allow generous slack for CI; should be well under 5s if timeout fired.
    assert.ok(
      elapsed < 4000,
      `expected timeout to fire well before 5s sleep finished, took ${elapsed}ms`,
    );
  });

  it("returns ok=false when the binary path does not exist", async () => {
    const repoDir = join(tmp, "repo-missing-binary");
    mkdirSync(repoDir, { recursive: true });
    const result = await runScipIoIndex({
      binaryPath: join(tmp, "definitely-not-a-binary"),
      repoRootPath: repoDir,
      timeoutMs: 5000,
    });
    assert.equal(result.ok, false);
    // exitCode is null on spawn error
    assert.equal(result.exitCode, null);
  });

  it("captures bounded stdout for diagnostics", async () => {
    const binDir = join(tmp, "bin-stdout");
    const repoDir = join(tmp, "repo-stdout");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const stub = makeStubBinary(binDir, { exitCode: 0 });

    const result = await runScipIoIndex({
      binaryPath: stub,
      repoRootPath: repoDir,
      timeoutMs: 30_000,
    });

    assert.equal(result.ok, true);
    assert.match(result.stdout ?? "", /scip-io stub invoked/);
    assert.equal(result.stdoutTruncated, false);
  });
});

describe("scip-io-runner: repo language filter args", () => {
  let tmp = "";
  const previousCacheDir = process.env.SDL_SCIP_IO_CACHE_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "scip-io-lang-filter-"));
    process.env.SDL_SCIP_IO_CACHE_DIR = join(tmp, "cache");
  });

  after(() => {
    if (previousCacheDir === undefined) {
      delete process.env.SDL_SCIP_IO_CACHE_DIR;
    } else {
      process.env.SDL_SCIP_IO_CACHE_DIR = previousCacheDir;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("maps SDL-MCP repo languages to one scip-io language filter", () => {
    assert.deepEqual(scipIoLanguagesForRepo(["ts", "tsx", "js", "jsx", "rs"]), [
      "typescript",
      "javascript",
      "rust",
    ]);
    assert.deepEqual(
      buildScipIoIndexArgs({
        generatorArgs: ["--all-roots"],
        repoLanguages: ["ts", "tsx", "js", "jsx", "rs"],
      }),
      ["--lang", "typescript,javascript,rust", "--all-roots"],
    );
  });

  it("preserves explicit scip-io language args", () => {
    assert.deepEqual(
      buildScipIoIndexArgs({
        generatorArgs: ["--lang", "java", "--all-roots"],
        repoLanguages: ["ts", "rs"],
      }),
      ["--lang", "java", "--all-roots"],
    );
    assert.deepEqual(
      buildScipIoIndexArgs({
        generatorArgs: ["-lpython"],
        repoLanguages: ["ts", "rs"],
      }),
      ["-lpython"],
    );
  });

  it("does not synthesize a filter when repo languages have no scip-io backend", () => {
    assert.deepEqual(scipIoLanguagesForRepo(["php", "sh"]), []);
    assert.deepEqual(
      buildScipIoIndexArgs({
        generatorArgs: ["--all-roots"],
        repoLanguages: ["php", "sh"],
      }),
      ["--all-roots"],
    );
  });

  it("classifies only source and generator config dirty paths as cache inputs", () => {
    const repoConfig = {
      repoId: "cache-fast-path-test",
      rootPath: tmp,
      languages: ["ts", "py", "cpp"],
      ignore: ["generated/**"],
      maxFileBytes: 1024 * 1024,
    };
    const { dirtyPathsAffectScipGeneratorInputs } =
      __SCIP_GENERATOR_CACHE_INTERNALS_FOR_TESTS;

    assert.equal(
      dirtyPathsAffectScipGeneratorInputs(
        ["README.md", "index.scip", "Python/_cache/last_welcome.txt"],
        repoConfig,
      ),
      false,
    );
    assert.equal(
      dirtyPathsAffectScipGeneratorInputs(["src/main.ts"], repoConfig),
      true,
    );
    assert.equal(
      dirtyPathsAffectScipGeneratorInputs(["nested/package.json"], repoConfig),
      true,
    );
    assert.equal(
      dirtyPathsAffectScipGeneratorInputs(
        ["build/compile_commands.json"],
        repoConfig,
      ),
      true,
    );
    assert.equal(
      dirtyPathsAffectScipGeneratorInputs(["generated/stale.ts"], repoConfig),
      false,
    );
  });

  it("parses simple git status paths and rejects ambiguous quoted paths", () => {
    const { parseGitStatusPaths } = __SCIP_GENERATOR_CACHE_INTERNALS_FOR_TESTS;

    assert.deepEqual(
      parseGitStatusPaths(" M src/main.ts\n?? notes.md\nR  old.ts -> new.ts\n"),
      ["new.ts", "notes.md", "old.ts", "src/main.ts"],
    );
    assert.equal(parseGitStatusPaths('?? "path with spaces.ts"\n'), null);
  });

  it("skips scip-io before binary detection for unsupported-only repo languages", async () => {
    const binDir = join(tmp, "bin-unsupported");
    const repoDir = join(tmp, "repo-unsupported");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const logFile = join(tmp, "unsupported.log");
    const stub = makeStubBinary(binDir, { exitCode: 0, logFile });

    const result = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["php", "sh"],
      generatorCfg: {
        enabled: true,
        binary: stub,
        args: [],
        autoInstall: false,
        timeoutMs: 30_000,
        cleanupAfterIngest: false,
      },
    });

    assert.equal(result.attempted, false);
    assert.equal(existsSync(logFile), false);
  });

  it("runs scip-io for unsupported repo languages when args explicitly request a language", async () => {
    const binDir = join(tmp, "bin-explicit");
    const repoDir = join(tmp, "repo-explicit");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const logFile = join(tmp, "explicit.log");
    const stub = makeStubBinary(binDir, { exitCode: 0, logFile });

    const result = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["php"],
      generatorCfg: {
        enabled: true,
        binary: stub,
        args: ["--lang", "python", "--output", "custom.scip"],
        autoInstall: false,
        timeoutMs: 30_000,
        cleanupAfterIngest: false,
      },
    });

    assert.equal(result.attempted, true);
    assert.equal(result.ok, true);
    const log = readFileSync(logFile, "utf-8");
    assert.match(log, /args=.*index --lang python --output custom\.scip/);
  });

  it("uses fresh split indexes when a merged run succeeds without index.scip", async () => {
    const binDir = join(tmp, "bin-split-without-merged");
    const repoDir = join(tmp, "repo-split-without-merged");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "cpp.scip"), "stale-cpp", "utf-8");
    const logFile = join(tmp, "split-without-merged.log");
    const stub = makeStubBinary(binDir, {
      exitCode: 0,
      logFile,
      writeSplitIndexes: {
        "python.scip": "fresh-python",
      },
    });

    const result = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["py"],
      generatorCfg: {
        enabled: true,
        binary: stub,
        args: [],
        autoInstall: false,
        timeoutMs: 30_000,
        cleanupAfterIngest: false,
      },
    });

    const accepted = result.generatedIndexes.filter((index) => !index.skipped);
    const skipped = result.generatedIndexes.filter((index) => index.skipped);

    assert.equal(result.ok, true);
    assert.equal(existsSync(join(repoDir, "index.scip")), false);
    assert.deepEqual(
      accepted.map((index) => index.path),
      ["python.scip"],
    );
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.path, "cpp.scip");
    assert.equal(skipped[0]?.skipReason, "stale-generated-output");
    assert.match(
      result.failures.map((failure) => failure.message).join(" "),
      /completed without index\.scip/,
    );
    assert.match(readFileSync(logFile, "utf-8"), /args=.*index --lang python/);
  });

  it("keeps fresh split indexes when a merged run fails after partial output", async () => {
    const binDir = join(tmp, "bin-failed-split-without-merged");
    const repoDir = join(tmp, "repo-failed-split-without-merged");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "cpp.scip"), "stale-cpp", "utf-8");
    const stub = makeStubBinary(binDir, {
      exitCode: 1,
      writeSplitIndexes: {
        "python.scip": "fresh-python",
      },
    });

    const result = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["py", "cpp"],
      generatorCfg: {
        enabled: true,
        binary: stub,
        args: [],
        autoInstall: false,
        timeoutMs: 30_000,
        cleanupAfterIngest: false,
      },
    });

    const accepted = result.generatedIndexes.filter((index) => !index.skipped);
    const stale = result.generatedIndexes.find(
      (index) => index.path === "cpp.scip",
    );

    assert.equal(result.ok, true);
    assert.deepEqual(
      accepted.map((index) => index.path),
      ["python.scip"],
    );
    assert.equal(stale?.skipped, true);
    assert.equal(stale?.skipReason, "stale-generated-output");
    assert.match(
      result.failures.map((failure) => failure.message).join(" "),
      /failed without index\.scip/,
    );
    assert.equal(result.failures[0]?.stage, "generator-run");
  });

  it("reuses a cached generated index when repo inputs are unchanged", async () => {
    const binDir = join(tmp, "bin-cache");
    const repoDir = join(tmp, "repo-cache");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(
      join(repoDir, "src.ts"),
      "export const value = 1;\n",
      "utf-8",
    );
    const logFile = join(tmp, "cache.log");
    const stub = makeStubBinary(binDir, {
      exitCode: 0,
      logFile,
      writeIndexContent: "scip-cache-index",
    });
    const generatorCfg = {
      enabled: true,
      binary: stub,
      args: [],
      autoInstall: false,
      timeoutMs: 30_000,
      cleanupAfterIngest: true,
      cacheGeneratedIndexes: true,
    };
    const repoConfig = {
      repoId: "cache-test",
      rootPath: repoDir,
      languages: ["ts"],
      ignore: [],
      maxFileBytes: 1024 * 1024,
    };

    const first = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["ts"],
      generatorCfg,
      repoConfig,
      repoId: "cache-test",
    });
    rmSync(join(repoDir, "index.scip"), { force: true });
    const second = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["ts"],
      generatorCfg,
      repoConfig,
      repoId: "cache-test",
    });

    assert.equal(first.ok, true);
    assert.equal(first.cache?.status, "stored");
    assert.equal(second.ok, true);
    assert.equal(second.attempted, false);
    assert.equal(second.cache?.status, "hit");
    assert.equal(
      readFileSync(join(repoDir, "index.scip"), "utf-8").trim(),
      "scip-cache-index",
    );
    const invocations = readFileSync(logFile, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(invocations.length, 1);
  });

  it("reruns scip-io when a cached repo input changes", async () => {
    const binDir = join(tmp, "bin-cache-invalidate");
    const repoDir = join(tmp, "repo-cache-invalidate");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    const sourcePath = join(repoDir, "src.ts");
    writeFileSync(sourcePath, "export const value = 1;\n", "utf-8");
    const logFile = join(tmp, "cache-invalidate.log");
    const stub = makeStubBinary(binDir, {
      exitCode: 0,
      logFile,
      writeIndexContent: "scip-cache-index",
    });
    const generatorCfg = {
      enabled: true,
      binary: stub,
      args: [],
      autoInstall: false,
      timeoutMs: 30_000,
      cleanupAfterIngest: true,
      cacheGeneratedIndexes: true,
    };
    const repoConfig = {
      repoId: "cache-invalidate-test",
      rootPath: repoDir,
      languages: ["ts"],
      ignore: [],
      maxFileBytes: 1024 * 1024,
    };

    const first = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["ts"],
      generatorCfg,
      repoConfig,
      repoId: "cache-invalidate-test",
    });
    rmSync(join(repoDir, "index.scip"), { force: true });
    writeFileSync(sourcePath, "export const value = 2;\n", "utf-8");
    const second = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["ts"],
      generatorCfg,
      repoConfig,
      repoId: "cache-invalidate-test",
    });

    assert.equal(first.ok, true);
    assert.equal(first.cache?.status, "stored");
    assert.equal(second.ok, true);
    assert.equal(second.attempted, true);
    assert.equal(second.cache?.status, "stored");
    const invocations = readFileSync(logFile, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(invocations.length, 2);
  });

  it("caches usable generated indexes from non-fatal language failures", async () => {
    const binDir = join(tmp, "bin-cache-partial");
    const repoDir = join(tmp, "repo-cache-partial");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "compile_commands.json"), "[]\n", "utf-8");
    const logFile = join(tmp, "cache-partial.log");
    const stub = makeStubBinary(binDir, {
      exitCode: 1,
      logFile,
      writeIndexContent: "scip-partial-index",
    });
    const generatorCfg = {
      enabled: true,
      binary: stub,
      args: [],
      autoInstall: false,
      timeoutMs: 30_000,
      cleanupAfterIngest: true,
      cacheGeneratedIndexes: true,
    };
    const repoConfig = {
      repoId: "cache-partial-test",
      rootPath: repoDir,
      languages: ["py", "cpp"],
      ignore: [],
      maxFileBytes: 1024 * 1024,
    };

    const first = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["py", "cpp"],
      generatorCfg,
      repoConfig,
      repoId: "cache-partial-test",
    });
    rmSync(join(repoDir, "index.scip"), { force: true });
    const second = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["py", "cpp"],
      generatorCfg,
      repoConfig,
      repoId: "cache-partial-test",
    });

    assert.equal(first.ok, true);
    assert.equal(first.failures[0]?.stage, "generator-run");
    assert.equal(first.cache?.status, "stored");
    assert.equal(second.ok, true);
    assert.equal(second.attempted, false);
    assert.equal(second.cache?.status, "hit");
    assert.equal(
      readFileSync(join(repoDir, "index.scip"), "utf-8").trim(),
      "scip-partial-index",
    );
    const invocations = readFileSync(logFile, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(invocations.length, 1);
  });

  it("does not cache partial split indexes when a requested language is missing", async () => {
    const binDir = join(tmp, "bin-cache-missing-language");
    const repoDir = join(tmp, "repo-cache-missing-language");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "source.py"), "print('ok')\n", "utf-8");
    writeFileSync(join(repoDir, "source.cpp"), "int main() { return 0; }\n", "utf-8");
    writeFileSync(join(repoDir, "compile_commands.json"), "[]\n", "utf-8");
    const logFile = join(tmp, "cache-missing-language.log");
    const stub = makeStubBinary(binDir, {
      exitCode: 1,
      logFile,
      writeSplitIndexes: {
        "python.scip": "partial-python",
      },
    });
    const generatorCfg = {
      enabled: true,
      binary: stub,
      args: [],
      autoInstall: false,
      timeoutMs: 30_000,
      cleanupAfterIngest: true,
      cacheGeneratedIndexes: true,
    };
    const repoConfig = {
      repoId: "cache-missing-language-test",
      rootPath: repoDir,
      languages: ["py", "cpp"],
      ignore: [],
      maxFileBytes: 1024 * 1024,
    };

    const first = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["py", "cpp"],
      generatorCfg,
      repoConfig,
      repoId: "cache-missing-language-test",
    });
    rmSync(join(repoDir, "python.scip"), { force: true });
    const second = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      repoLanguages: ["py", "cpp"],
      generatorCfg,
      repoConfig,
      repoId: "cache-missing-language-test",
    });

    assert.equal(first.ok, true);
    assert.equal(first.cache?.status, "miss");
    assert.match(first.cache?.reason ?? "", /missing requested split language/);
    assert.equal(second.ok, true);
    assert.equal(second.attempted, true);
    assert.notEqual(second.cache?.status, "hit");
    const invocations = readFileSync(logFile, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(invocations.length, 2);
  });
});

describe("scip-io-runner: generated index selection", () => {
  let tmp = "";

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "scip-io-select-"));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("selects the merged index when it is under the decoder cap", async () => {
    const repoDir = join(tmp, "repo-merged");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "index.scip"), "small", "utf-8");

    const result = await selectGeneratedScipIndexes({
      repoRootPath: repoDir,
      mode: "merged",
      maxIndexBytes: 10,
    });

    assert.equal(result.failures.length, 0);
    assert.equal(result.generatedIndexes.length, 1);
    assert.deepEqual(result.generatedIndexes[0], {
      path: "index.scip",
      label: "scip-io",
      sizeBytes: 5,
      mode: "merged",
      contentHash: result.generatedIndexes[0]?.contentHash,
    });
  });

  it("dedupes split indexes by SHA-256 content hash", async () => {
    const repoDir = join(tmp, "repo-split-dedupe");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "typescript.scip"), "same", "utf-8");
    writeFileSync(join(repoDir, "javascript.scip"), "same", "utf-8");

    const result = await selectGeneratedScipIndexes({
      repoRootPath: repoDir,
      mode: "split",
      maxIndexBytes: 10,
    });

    const accepted = result.generatedIndexes.filter((index) => !index.skipped);
    const skipped = result.generatedIndexes.filter((index) => index.skipped);
    assert.equal(accepted.length, 1);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]?.skipReason ?? "", /duplicate-content/);
  });

  it("reports oversized split indexes as visible skipped diagnostics", async () => {
    const repoDir = join(tmp, "repo-split-oversize");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "big.scip"), "too-large", "utf-8");

    const result = await selectGeneratedScipIndexes({
      repoRootPath: repoDir,
      mode: "split",
      maxIndexBytes: 4,
    });

    assert.equal(result.generatedIndexes.length, 1);
    assert.equal(result.generatedIndexes[0]?.skipped, true);
    assert.equal(result.generatedIndexes[0]?.skipReason, "over-size");
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]?.message ?? "", /exceeding/);
  });
});

describe("scip-io-runner: installScipIo security hardening", () => {
  // Regression coverage for the code-review fixes:
  //   - Mandatory SHA256SUMS.txt: refuse to install if checksum file absent
  //   - Download URL allowlist: reject non-github.com hosts
  //
  // Each test monkey-patches global.fetch to simulate a specific API
  // response, then asserts that installScipIo rejects with ScipIoInstallError
  // and that the rejection message mentions the expected failure reason.

  let originalFetch: typeof fetch | undefined;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    __resetInstallLockForTests();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it("refuses to install when SHA256SUMS.txt is absent from the release", async () => {
    __resetInstallLockForTests();
    // Return a valid-shape release payload with the archive asset but NO
    // SHA256SUMS.txt. This is exactly the downgrade-attack vector the
    // hard-error fix closes.
    const platform = process.platform;
    const arch = process.arch;
    // Build a plausible asset name matching the runner's platform mapping.
    let assetName = "";
    if (platform === "win32" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-pc-windows-msvc.zip";
    else if (platform === "darwin" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-apple-darwin.tar.gz";
    else if (platform === "darwin" && arch === "arm64")
      assetName = "scip-io-v0.1.1-aarch64-apple-darwin.tar.gz";
    else if (platform === "linux" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-unknown-linux-gnu.tar.gz";
    else {
      // Unsupported platform — we expect ScipIoUnsupportedPlatformError
      // instead of the checksum error, which is also acceptable coverage.
      assetName = "scip-io-v0.1.1-unknown.tar.gz";
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("api.github.com")) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.1.1",
            assets: [
              {
                name: assetName,
                size: 1024,
                browser_download_url: `https://github.com/GlitterKill/scip-io/releases/download/v0.1.1/${assetName}`,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    };

    let err: unknown;
    try {
      await installScipIo();
    } catch (e) {
      err = e;
    }
    assert.ok(
      err instanceof ScipIoInstallError,
      `expected ScipIoInstallError, got ${err}`,
    );
    // The error message must mention SHA256SUMS.txt so users know why it
    // failed and how to fix it.
    const msg = (err as Error).message;
    assert.match(
      msg,
      /SHA256SUMS\.txt/,
      `error message should mention SHA256SUMS.txt: ${msg}`,
    );
  });

  it("rejects download URLs pointing at non-github.com hosts", async () => {
    __resetInstallLockForTests();
    const platform = process.platform;
    const arch = process.arch;
    let assetName = "";
    if (platform === "win32" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-pc-windows-msvc.zip";
    else if (platform === "darwin" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-apple-darwin.tar.gz";
    else if (platform === "darwin" && arch === "arm64")
      assetName = "scip-io-v0.1.1-aarch64-apple-darwin.tar.gz";
    else if (platform === "linux" && arch === "x64")
      assetName = "scip-io-v0.1.1-x86_64-unknown-linux-gnu.tar.gz";
    else assetName = "scip-io-v0.1.1-unknown.tar.gz";

    // Simulate a tampered API response: the archive's download URL points
    // at an attacker-controlled host. SHA256SUMS.txt is present (to get
    // past the first gate) but also points at a hostile host.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("api.github.com")) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.1.1",
            assets: [
              {
                name: assetName,
                size: 1024,
                browser_download_url: `https://evil.example.com/${assetName}`,
              },
              {
                name: "SHA256SUMS.txt",
                size: 256,
                browser_download_url:
                  "https://github.com/GlitterKill/scip-io/releases/download/v0.1.1/SHA256SUMS.txt",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    };

    let err: unknown;
    try {
      await installScipIo();
    } catch (e) {
      err = e;
    }
    assert.ok(
      err instanceof ScipIoInstallError,
      `expected ScipIoInstallError, got ${err}`,
    );
    const msg = (err as Error).message;
    // The error must mention the host or the allowlist so the failure is
    // diagnosable from logs alone.
    assert.match(
      msg,
      /host|allowed|github\.com/i,
      `error message should reference the allowlist: ${msg}`,
    );
  });
});

describe("scip-io-runner: installScipIo single-flight lock", () => {
  // Monkey-patch global.fetch so the test never touches the network. The
  // mock returns a 503 so the install fails fast with ScipIoInstallError.
  // Both parallel calls must share the same rejection reason — which only
  // happens if the in-flight lock is honored.
  let originalFetch: typeof fetch | undefined;
  let fetchCallCount = 0;

  before(() => {
    __resetInstallLockForTests();
    originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (_url: unknown, _init?: unknown) => {
      fetchCallCount++;
      // Resolve on a microtask so that the second installScipIo() call has
      // a chance to enter the in-flight lock check before the first one
      // resolves and clears it.
      await new Promise((r) => setImmediate(r));
      return new Response("simulated outage", {
        status: 503,
        statusText: "Service Unavailable",
      });
    };
  });

  after(() => {
    __resetInstallLockForTests();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  it("two parallel install calls share a single in-flight promise", async () => {
    fetchCallCount = 0;
    const pair = await Promise.allSettled([installScipIo(), installScipIo()]);

    assert.equal(pair[0].status, "rejected");
    assert.equal(pair[1].status, "rejected");

    // The single-flight lock means both calls share the same underlying
    // promise, so both rejections must reference the exact same error
    // object. This is the most direct proof the lock works.
    if (pair[0].status === "rejected" && pair[1].status === "rejected") {
      assert.equal(
        pair[0].reason,
        pair[1].reason,
        "both parallel installs must reject with the SAME error object (proves single-flight lock)",
      );
      assert.ok(pair[0].reason instanceof ScipIoInstallError);
    }

    // The mock fetch should have been called exactly once if the lock
    // worked: only the first installScipIo() actually hit fetch; the second
    // joined the in-flight promise without re-issuing the request.
    assert.equal(
      fetchCallCount,
      1,
      `expected exactly 1 fetch call (single-flight), got ${fetchCallCount}`,
    );
  });
});
