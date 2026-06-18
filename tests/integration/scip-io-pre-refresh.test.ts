/**
 * Integration test for the scip-io pre-refresh hook.
 *
 * Exercises the full path: a stub `scip-io` binary, the
 * `scip.generator.enabled` config flag, `loadConfig()` auto-registration of
 * the `index.scip` entry, and `indexRepo()`'s pre-refresh hook in
 * `src/indexer/indexer.ts`. No real network, no real scip-io binary.
 *
 * Cases covered:
 *
 *   1. Disabled (default): the stub is NOT invoked.
 *   2. Enabled with explicit stub path: the stub IS invoked with cwd=repoRoot,
 *      "index" as the first arg, and a repo-language `--lang` filter.
 *   3. Enabled but stub exits non-zero: indexing still completes successfully
 *      (non-fatal failure mode).
 *   4. Oversized merged output: pre-refresh retries with `--no-merge`,
 *      dedupes split indexes by content hash, and reports skipped diagnostics.
 *   5. Auto-register: with generator enabled, `loadConfig()` injects an
 *      `{ path: "index.scip" }` entry into `scip.indexes` automatically.
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
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import {
  invalidateConfigCache,
  loadConfig,
} from "../../dist/config/loadConfig.js";
import { runScipIoBeforeIndex } from "../../dist/scip/scip-io-runner.js";

const IS_WINDOWS = process.platform === "win32";
const REPO_ID = "test-scip-io-pre-refresh";

/**
 * Create a stub scip-io binary that records its invocation to `logFile`
 * (cwd + args), then writes a deterministic minimal `index.scip` to the
 * configured "repo root" (passed as the cwd by the runner). Exits with
 * the supplied exit code.
 *
 * On Windows uses a `.cmd` wrapper named `scip-io.cmd` so `where scip-io`
 * locates it (the runner strips `.exe` before calling `where`).
 *
 * On Unix uses a bash script chmod 755.
 */
function makeStubBinary(
  dir: string,
  opts: { exitCode?: number; logFile?: string; writeScip?: boolean } = {},
): string {
  const exitCode = opts.exitCode ?? 0;
  const writeScip = opts.writeScip ?? true;

  if (IS_WINDOWS) {
    const path = join(dir, "scip-io.cmd");
    const lines: string[] = ["@echo off"];
    if (opts.logFile) {
      lines.push(`>>"${opts.logFile}" echo cwd=%CD% args=%*`);
    }
    if (writeScip) {
      // Write a minimal placeholder index.scip into cwd. The content is not a
      // valid SCIP encoding, but provider-first will only attempt to parse it
      // when SCIP inputs are enabled, and parse failures remain non-fatal for
      // generator diagnostics.
      lines.push(`>"%CD%\\index.scip" echo SCIP_STUB`);
    }
    lines.push(`exit /b ${exitCode}`);
    writeFileSync(path, lines.join("\r\n") + "\r\n", "utf-8");
    return path;
  }

  const path = join(dir, "scip-io");
  const lines: string[] = ["#!/usr/bin/env bash"];
  if (opts.logFile) {
    lines.push(`echo "cwd=$PWD args=$@" >> "${opts.logFile}"`);
  }
  if (writeScip) {
    lines.push(`echo "SCIP_STUB" > "$PWD/index.scip"`);
  }
  lines.push(`exit ${exitCode}`);
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  chmodSync(path, 0o755);
  return path;
}

function makeSplitFallbackStubBinary(
  dir: string,
  opts: {
    logFile: string;
    mergedContent: string;
    splitFiles: Record<string, string>;
  },
): string {
  const scriptPath = join(dir, "scip-io-split-stub.mjs");
  const script = `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const opts = ${JSON.stringify(opts)};
const args = process.argv.slice(2);
appendFileSync(opts.logFile, \`cwd=\${process.cwd()} args=\${args.join(" ")}\\n\`);

function requestedLanguages(args) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--lang" || arg === "-l") {
      values.push(args[i + 1] ?? "");
      i++;
    } else if (arg.startsWith("--lang=")) {
      values.push(arg.slice("--lang=".length));
    } else if (arg.startsWith("-l") && arg.length > 2) {
      values.push(arg.slice(2));
    }
  }
  const langs = values.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  return langs.length > 0 ? new Set(langs) : null;
}

if (args.includes("--no-merge")) {
  const langs = requestedLanguages(args);
  for (const [relPath, content] of Object.entries(opts.splitFiles)) {
    const language = relPath.replace(/\\.scip$/, "");
    if (langs && !langs.has(language)) continue;
    const target = join(process.cwd(), relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
} else {
  writeFileSync(join(process.cwd(), "index.scip"), opts.mergedContent);
}
`;
  writeFileSync(scriptPath, script.trimStart(), "utf-8");

  if (IS_WINDOWS) {
    const path = join(dir, "scip-io-split.cmd");
    writeFileSync(
      path,
      `@echo off\r\nnode "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`,
      "utf-8",
    );
    return path;
  }

  const path = join(dir, "scip-io-split");
  writeFileSync(
    path,
    `#!/usr/bin/env sh\nnode '${scriptPath}' "$@"\n`,
    "utf-8",
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * Build a minimal config file pointing at a temp dir, optionally enabling
 * the scip-io generator. Returns the absolute path to the config file.
 */
function writeConfig(
  configPath: string,
  opts: { generatorEnabled: boolean; binary?: string },
): void {
  const config = {
    repos: [],
    policy: {},
    indexing: { engine: "typescript", enableFileWatching: false },
    scip: {
      enabled: opts.generatorEnabled,
      indexes: [],
      generator: {
        enabled: opts.generatorEnabled,
        binary: opts.binary ?? "scip-io",
        args: [],
        autoInstall: false, // never reach the network in tests
        timeoutMs: 30_000,
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

describe("scip-io pre-refresh hook", () => {
  let workDir = "";
  let graphDbDir = "";
  let repoDir = "";
  let stubBinDir = "";
  let configPath = "";
  let invocationLog = "";

  const prevPath = process.env.PATH;
  const prevSDL_CONFIG = process.env.SDL_CONFIG;
  const prevSDL_CONFIG_PATH = process.env.SDL_CONFIG_PATH;
  const prevDisableNative = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;

  before(async () => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";

    workDir = mkdtempSync(join(tmpdir(), "sdl-mcp-scip-io-pre-"));
    graphDbDir = join(workDir, "graph");
    repoDir = join(workDir, "repo");
    stubBinDir = join(workDir, "bin");
    mkdirSync(graphDbDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(stubBinDir, { recursive: true });

    // Tiny TS source the indexer can parse so indexRepo has work to do.
    const srcDir = join(repoDir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "main.ts"),
      "export function hello(): string { return 'hi'; }\n",
      "utf-8",
    );
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "scip-io-fixture", version: "1.0.0" }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(repoDir, "tsconfig.json"),
      JSON.stringify(
        { compilerOptions: { target: "ES2022", module: "ESNext" } },
        null,
        2,
      ),
      "utf-8",
    );

    invocationLog = join(workDir, "invocations.log");
    configPath = join(workDir, "test-config.json");

    // Prepend the stub bin dir to PATH so `where`/`which` finds our stub
    // before any system scip-io.
    process.env.PATH = stubBinDir + delimiter + (prevPath ?? "");

    // Initialize a fresh ladybug DB for this test.
    await closeLadybugDb();
    await initLadybugDb(graphDbDir);
    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: false,
        packageJsonPath: "package.json",
        tsconfigPath: "tsconfig.json",
        workspaceGlobs: null,
      }),
      createdAt: new Date().toISOString(),
    });
  });

  after(async () => {
    await closeLadybugDb();
    process.env.PATH = prevPath;
    if (prevSDL_CONFIG !== undefined) {
      process.env.SDL_CONFIG = prevSDL_CONFIG;
    } else {
      delete process.env.SDL_CONFIG;
    }
    if (prevSDL_CONFIG_PATH !== undefined) {
      process.env.SDL_CONFIG_PATH = prevSDL_CONFIG_PATH;
    } else {
      delete process.env.SDL_CONFIG_PATH;
    }
    if (prevDisableNative !== undefined) {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = prevDisableNative;
    } else {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    }
    invalidateConfigCache();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("does NOT invoke scip-io when generator.enabled is false", async () => {
    // Generator disabled — make sure even if the stub is on PATH, the hook
    // is gated correctly.
    writeConfig(configPath, { generatorEnabled: false });
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;
    invalidateConfigCache();

    // Reset the invocation log so we can detect any unexpected writes.
    if (existsSync(invocationLog)) rmSync(invocationLog);
    makeStubBinary(stubBinDir, {
      exitCode: 0,
      logFile: invocationLog,
      writeScip: false,
    });
    // Also clear any leftover index.scip from prior runs.
    const scipPath = join(repoDir, "index.scip");
    if (existsSync(scipPath)) rmSync(scipPath);

    const result = await indexRepo(REPO_ID, "incremental");
    assert.ok(result.versionId.length > 0);
    assert.equal(
      existsSync(invocationLog),
      false,
      "scip-io stub must NOT have been invoked when generator is disabled",
    );
    assert.equal(
      existsSync(scipPath),
      false,
      "stub-written index.scip should not exist when generator is disabled",
    );
  });

  it("invokes scip-io with cwd=repoRoot and repo-language filter", async () => {
    if (existsSync(invocationLog)) rmSync(invocationLog);
    const stub = makeStubBinary(stubBinDir, {
      exitCode: 0,
      logFile: invocationLog,
      writeScip: true,
    });
    writeConfig(configPath, { generatorEnabled: true, binary: stub });
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;
    invalidateConfigCache();

    const result = await indexRepo(REPO_ID, "incremental");
    assert.ok(result.versionId.length > 0);

    assert.equal(
      existsSync(invocationLog),
      true,
      "scip-io stub should have been invoked",
    );
    const log = readFileSync(invocationLog, "utf-8");
    assert.match(log, /args=.*index/, `log was: ${log}`);
    assert.match(
      log,
      /args=.*index --lang typescript(?:\s|$)/,
      `log was: ${log}`,
    );
    assert.doesNotMatch(log, /java|csharp|go|cpp/, `log was: ${log}`);

    // The stub wrote index.scip into cwd. Verify it landed in the repo
    // root, which is what the cwd should have been.
    const scipPath = join(repoDir, "index.scip");
    assert.equal(
      existsSync(scipPath),
      true,
      "stub should have written index.scip into the repo root (proves cwd was correct)",
    );
  });

  it("continues indexing successfully when scip-io exits non-zero", async () => {
    if (existsSync(invocationLog)) rmSync(invocationLog);
    // Stub fails with exit 7 and does NOT write index.scip.
    const stub = makeStubBinary(stubBinDir, {
      exitCode: 7,
      logFile: invocationLog,
      writeScip: false,
    });
    writeConfig(configPath, { generatorEnabled: true, binary: stub });
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;
    invalidateConfigCache();

    // Should not throw — the failure must be non-fatal.
    const result = await indexRepo(REPO_ID, "incremental");
    assert.ok(
      result.versionId.length > 0,
      "indexRepo must complete even when scip-io fails",
    );
    assert.equal(
      existsSync(invocationLog),
      true,
      "stub should still have been invoked",
    );
  });

  it("falls back to split SCIP indexes when the merged generator output is oversized", async () => {
    if (existsSync(invocationLog)) rmSync(invocationLog);
    for (const relPath of [
      "index.scip",
      "typescript.scip",
      "javascript.scip",
      "python.scip",
    ]) {
      const path = join(repoDir, relPath);
      if (existsSync(path)) rmSync(path);
    }
    writeFileSync(join(repoDir, "python.scip"), "STALE_PY", "utf-8");

    const stub = makeSplitFallbackStubBinary(stubBinDir, {
      logFile: invocationLog,
      mergedContent: "0123456789",
      splitFiles: {
        "typescript.scip": "SAME",
        "javascript.scip": "SAME",
        "python.scip": "PY",
      },
    });

    const result = await runScipIoBeforeIndex({
      repoRootPath: repoDir,
      maxIndexBytes: 8,
      repoLanguages: ["ts", "js"],
      generatorCfg: {
        enabled: true,
        binary: stub,
        args: [],
        autoInstall: false,
        timeoutMs: 30_000,
        cleanupAfterIngest: false,
      },
    });

    assert.equal(result.ok, true);
    assert.ok(result.splitRun, "oversized merged output should run --no-merge");
    const acceptedPaths = result.generatedIndexes
      .filter((index) => !index.skipped)
      .map((index) => index.path)
      .sort();
    assert.equal(acceptedPaths.length, 1);
    assert.ok(!acceptedPaths.includes("python.scip"));
    assert.ok(
      acceptedPaths.includes("javascript.scip") ||
        acceptedPaths.includes("typescript.scip"),
      "one scip-typescript split artifact should be accepted",
    );
    assert.ok(
      result.generatedIndexes.some(
        (index) =>
          index.path === "python.scip" &&
          index.skipped === true &&
          index.skipReason === "stale-generated-output",
      ),
      "stale split files from languages outside the filtered run should not be ingested",
    );
    assert.ok(
      result.generatedIndexes.some(
        (index) => index.path === "index.scip" && index.skipped === true,
      ),
      "oversized merged index should remain visible as a skipped diagnostic",
    );
    assert.ok(
      result.generatedIndexes.some(
        (index) =>
          (index.path === "javascript.scip" ||
            index.path === "typescript.scip") &&
          index.skipped === true &&
          index.skipReason?.startsWith("duplicate-content:"),
      ),
      "duplicate split indexes should be skipped by content hash",
    );

    const log = readFileSync(invocationLog, "utf-8");
    assert.match(log, /args=index --lang typescript,javascript\r?\n/);
    assert.match(log, /args=index --lang typescript,javascript --no-merge/);
  });

  it("auto-registers index.scip in scip.indexes when generator is enabled", () => {
    writeConfig(configPath, { generatorEnabled: true });
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;
    invalidateConfigCache();

    const cfg = loadConfig(configPath);
    assert.ok(cfg.scip);
    assert.equal(cfg.scip.enabled, true);
    assert.equal(cfg.scip.generator.enabled, true);

    const entry = cfg.scip.indexes.find((e) => e.path === "index.scip");
    assert.ok(
      entry,
      "loadConfig should auto-inject { path: 'index.scip' } when generator is enabled",
    );
    assert.equal(entry.label, "scip-io");
  });

  it("does NOT auto-register index.scip when generator is disabled", () => {
    writeConfig(configPath, { generatorEnabled: false });
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;
    invalidateConfigCache();

    const cfg = loadConfig(configPath);
    assert.ok(cfg.scip);
    assert.equal(cfg.scip.enabled, false);

    // scip.enabled is false, so even if a hypothetical generator were
    // enabled the auto-register guard `scip.enabled && generator.enabled`
    // would block injection.
    const entry = cfg.scip.indexes.find((e) => e.path === "index.scip");
    assert.equal(
      entry,
      undefined,
      "loadConfig must not auto-inject when scip.enabled is false",
    );
  });
});
