import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { globSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Global cleanup for LadybugDB - prevents segfaults on exit.
const gracefulCleanup = async () => {
  try {
    // Dynamic import avoids loading DB code when setup fails before tests run.
    const { closeLadybugDb } = await import("../dist/db/ladybug.js");
    await closeLadybugDb();
  } catch {
    // Best effort - DB may not have been initialized.
  }
};

process.on("beforeExit", () => {
  gracefulCleanup().catch(() => {});
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const testLogPath = join(process.cwd(), "test-results.log");
const logLines = [];
const MAX_TEST_OUTPUT_BYTES = 10 * 1024 * 1024;
const INIT_DB_ARGS = [
  "--input-type=module",
  "-e",
  "import { initLadybugDb } from './dist/db/ladybug.js'; await initLadybugDb(process.env.SDL_GRAPH_DB_PATH);",
];

// 0xC0000005 = ACCESS_VIOLATION, returned as signed int32 = -1073741819.
const WINDOWS_SEGFAULT_EXIT_CODES = new Set([-1073741819, 3221225477]);
const SEGFAULT_EXIT_CODE_PATTERN = [...WINDOWS_SEGFAULT_EXIT_CODES].join("|");
const VALID_GROUPS = new Set([
  "benchmark",
  "golden",
  "integration",
  "mutation",
  "native",
  "property",
  "root",
  "unit",
]);

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let overallFailed = false;
const failedTestFiles = [];
const passedWithSegfault = [];

function log(msg) {
  console.log(msg);
  logLines.push(msg);
}

function writeLog() {
  writeFileSync(testLogPath, logLines.join("\n"));
  console.log("\n[run-tests] Full results written to:", testLogPath);
}

/**
 * Parse TAP output to determine if tests passed.
 *
 * When a test file segfaults on exit, Node's runner can emit passing subtests
 * plus a file-level "not ok" marker with a native exit code. Treat only that
 * file-level marker as ignorable; real subtest failures still fail the suite.
 */
function parseTapResult(output, testFile = "") {
  if (/^[ \t]+not ok \d+ - /m.test(output)) {
    log(`[TAP DEBUG] ${testFile}: Subtest failure found`);
    return { passed: false, reason: "subtest_failure" };
  }

  const hasAssertionError =
    /AssertionError|ERR_ASSERTION|expected.*actual|Error:.*\n.*at /m.test(
      output,
    );
  if (hasAssertionError) {
    log(`[TAP DEBUG] ${testFile}: Real assertion error found`);
    return { passed: false, reason: "assertion_error" };
  }

  const hasSegfaultExit = new RegExp(
    `not ok[\\s\\S]*?exitCode:\\s*(${SEGFAULT_EXIT_CODE_PATTERN})`,
    "m",
  ).test(output);
  if (hasSegfaultExit) {
    log(`[TAP DEBUG] ${testFile}: Segfault on exit detected, tests passed`);
    return { passed: true, reason: "segfault_only" };
  }

  const summaryMatch = output.match(/# fail (\d+)/m);
  if (summaryMatch) {
    const failCount = parseInt(summaryMatch[1], 10);
    if (failCount === 0) {
      return { passed: true, reason: "summary_pass" };
    }
    log(`[TAP DEBUG] ${testFile}: TAP summary reported ${failCount} failure(s)`);
    return { passed: false, reason: "summary_failure" };
  }

  log(`[TAP DEBUG] ${testFile}: Unknown failure pattern`);
  return { passed: false, reason: "unknown" };
}

function addGroups(value, groups) {
  for (const rawGroup of value.split(",")) {
    const group = rawGroup.trim();
    if (group === "" || group === "all") {
      continue;
    }
    if (!VALID_GROUPS.has(group)) {
      throw new Error(
        `Unknown test group "${group}". Valid groups: ${[
          ...VALID_GROUPS,
        ].join(", ")}`,
      );
    }
    groups.add(group);
  }
}

function parseSelectedGroups(argv) {
  const groups = new Set();
  const ignoredArgs = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--group" || arg === "--groups") {
      const value = argv[++i];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      addGroups(value, groups);
      continue;
    }
    if (arg.startsWith("--group=")) {
      addGroups(arg.slice("--group=".length), groups);
      continue;
    }
    if (arg.startsWith("--groups=")) {
      addGroups(arg.slice("--groups=".length), groups);
      continue;
    }
    ignoredArgs.push(arg);
  }

  if (ignoredArgs.length > 0) {
    log(`[run-tests] Ignoring unsupported runner arg(s): ${ignoredArgs.join(" ")}`);
  }
  return groups;
}

function testGroupFor(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts.length > 2 ? parts[1] : "root";
}

function defaultJobCount() {
  return Math.min(4, Math.max(1, availableParallelism() - 1));
}

function testJobCount() {
  const requested = process.env.SDL_TEST_JOBS;
  if (!requested) {
    return defaultJobCount();
  }

  const parsed = Number.parseInt(requested, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    log(
      `[run-tests] Ignoring invalid SDL_TEST_JOBS="${requested}"; using ${defaultJobCount()}`,
    );
    return defaultJobCount();
  }
  return parsed;
}

function needsPreinitializedDb(testFile) {
  const source = readFileSync(resolve(repoRoot, testFile), "utf8");
  return /\bgetLadybugConn\b/.test(source) && !/\binitLadybugDb\b/.test(source);
}

function needsExperimentalModuleMocks(testFile) {
  const source = readFileSync(resolve(repoRoot, testFile), "utf8");
  return /\.mock\.module\s*\(/.test(source);
}

function runProcess(command, args, { cwd, env, maxOutputBytes = MAX_TEST_OUTPUT_BYTES }) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let killedByOutputLimit = false;
    let settled = false;

    const settle = (result) => {
      if (!settled) {
        settled = true;
        resolveResult(result);
      }
    };

    const collect = (chunk, target) => {
      outputBytes += chunk.length;
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
      } else {
        stderr += chunk.toString("utf8");
      }
      if (outputBytes > maxOutputBytes && !killedByOutputLimit) {
        killedByOutputLimit = true;
        child.kill();
      }
    };

    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    child.on("error", (error) => {
      settle({ status: 1, stdout, stderr, error, killedByOutputLimit });
    });
    child.on("close", (code) => {
      settle({ status: code ?? 1, stdout, stderr, killedByOutputLimit });
    });
  });
}

function writeCapturedOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
    logLines.push(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
    logLines.push(result.stderr);
  }
}

async function runTestFile(testFile, index, baseTestEnv, testTempDir) {
  const testGraphDbPath = join(testTempDir, `test-${index}-graph`);
  const env = {
    ...baseTestEnv,
    SDL_GRAPH_DB_PATH: testGraphDbPath,
    SDL_DB_PATH: testGraphDbPath,
  };

  // Some older tests call getLadybugConn() directly. Preinit only those files
  // so pure tests do not pay a DB startup cost.
  if (needsPreinitializedDb(testFile)) {
    const initResult = await runProcess(process.execPath, INIT_DB_ARGS, {
      cwd: repoRoot,
      env,
    });
    if ((initResult.status ?? 1) !== 0 || initResult.error) {
      return {
        ...initResult,
        testFile,
        passed: false,
        reason: initResult.error?.message ?? "db_init_failed",
      };
    }
  }

  const result = await runProcess(
    process.execPath,
    [
      // Node keeps module mocking behind an experimental flag in v24.
      ...(needsExperimentalModuleMocks(testFile)
        ? ["--experimental-test-module-mocks"]
        : []),
      "--test-concurrency=1",
      "--test-reporter=tap",
      "--test",
      resolve(repoRoot, testFile),
    ],
    {
      cwd: repoRoot,
      env,
    },
  );

  if (result.error) {
    return {
      ...result,
      testFile,
      passed: false,
      reason: `spawn error: ${result.error.message}`,
    };
  }
  if (result.killedByOutputLimit) {
    return {
      ...result,
      testFile,
      passed: false,
      reason: "output exceeded 10 MB",
    };
  }

  const exitCode = result.status ?? 1;
  if (exitCode === 0) {
    return { ...result, testFile, passed: true, reason: "clean_exit" };
  }

  const parsed = parseTapResult(result.stdout ?? "", testFile);
  return {
    ...result,
    testFile,
    passed: parsed.passed,
    reason: parsed.reason,
    passedWithSegfault: parsed.passed && parsed.reason === "segfault_only",
  };
}

function recordTestResult(result) {
  writeCapturedOutput(result);

  totalTests++;
  if (result.passed) {
    passedTests++;
    if (result.passedWithSegfault) {
      passedWithSegfault.push(result.testFile);
      log(`[run-tests] ${result.testFile}: PASSED (segfault on exit ignored)`);
    } else {
      log(`[run-tests] ${result.testFile}: PASSED`);
    }
    return;
  }

  failedTests++;
  failedTestFiles.push(result.testFile);
  overallFailed = true;
  log(`[run-tests] ${result.testFile}: FAILED (${result.reason || "test failure"})`);
}

async function runIsolatedTests(isolatedTests, baseTestEnv, testTempDir) {
  let nextIndex = 0;
  const workerCount = Math.min(testJobCount(), isolatedTests.length);
  log(
    `[run-tests] Running ${isolatedTests.length} test file(s) with ${workerCount} worker(s)`,
  );

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < isolatedTests.length) {
      const index = nextIndex++;
      const result = await runTestFile(
        isolatedTests[index],
        index,
        baseTestEnv,
        testTempDir,
      );
      recordTestResult(result);
    }
  });

  await Promise.all(workers);
}

let selectedGroups;
try {
  selectedGroups = parseSelectedGroups(process.argv.slice(2));
} catch (error) {
  console.error(`[run-tests] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const allTestFiles = globSync("tests/**/*.test.ts", { cwd: repoRoot }).sort();
if (allTestFiles.length === 0) {
  console.error("No test files found under tests/**/*.test.ts");
  process.exit(1);
}

const SKIP_PATTERNS = [
  "sqlite-to-ladybug-migration", // Requires SQLite test data.
  "vscode-buffer-push", // Requires VS Code extension environment.
  "check-benchmark-claims", // Benchmark validation only.
  "build-exe", // Build process test.
  "stress-timing-diagnostics", // Stress test only.
  "runner.test.ts", // Meta-test for test runner itself.
];

const testFiles = allTestFiles.filter((filePath) => {
  if (SKIP_PATTERNS.some((pattern) => filePath.includes(pattern))) {
    return false;
  }
  return selectedGroups.size === 0 || selectedGroups.has(testGroupFor(filePath));
});

if (testFiles.length === 0) {
  const label =
    selectedGroups.size === 0 ? "all groups" : [...selectedGroups].join(", ");
  console.error(`[run-tests] No test files selected for ${label}`);
  process.exit(1);
}

const testTempDir = mkdtempSync(join(tmpdir(), "sdl-mcp-tests-"));
const setupGraphDbPath = join(testTempDir, "setup-graph");
const baseTestEnv = {
  ...process.env,
  SDL_MCP_DISABLE_NATIVE_ADDON: "1",
};
const setupEnv = {
  ...baseTestEnv,
  SDL_GRAPH_DB_PATH: setupGraphDbPath,
  SDL_DB_PATH: setupGraphDbPath,
};

const selectedLabel =
  selectedGroups.size === 0 ? "all" : [...selectedGroups].sort().join(",");
log(`[run-tests] Selected test groups: ${selectedLabel}`);

const buildCmd = process.platform === "win32" ? "cmd.exe" : "npm";
const buildArgs =
  process.platform === "win32"
    ? ["/c", "npm", "run", "build:runtime"]
    : ["run", "build:runtime"];
const buildResult = spawnSync(buildCmd, buildArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  env: setupEnv,
});

if ((buildResult.status ?? 1) !== 0) {
  process.exit(buildResult.status ?? 1);
}

const schemaSyncResult = spawnSync(
  process.execPath,
  [resolve(repoRoot, "scripts", "check-schema-sync.mjs")],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: setupEnv,
  },
);

if ((schemaSyncResult.status ?? 1) !== 0) {
  process.exit(schemaSyncResult.status ?? 1);
}

const treeSitterProbe = spawnSync(
  process.execPath,
  ["--input-type=module", "-e", "await import('tree-sitter');"],
  {
    cwd: repoRoot,
    stdio: "ignore",
    env: setupEnv,
  },
);
if ((treeSitterProbe.status ?? 1) !== 0) {
  const packageJson = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  );
  const treeSitterPackages = Object.keys(packageJson.dependencies ?? {}).filter(
    (name) => name === "tree-sitter" || name.startsWith("tree-sitter-"),
  );
  if (treeSitterPackages.length > 0) {
    console.log(
      "[test setup] tree-sitter native bindings missing; rebuilding tree-sitter packages...",
    );
    const rebuildCmd = process.platform === "win32" ? "cmd.exe" : "npm";
    const rebuildArgs =
      process.platform === "win32"
        ? ["/c", "npm", "rebuild", ...treeSitterPackages]
        : ["rebuild", ...treeSitterPackages];
    const rebuildResult = spawnSync(rebuildCmd, rebuildArgs, {
      cwd: repoRoot,
      stdio: "inherit",
      env: setupEnv,
    });
    if ((rebuildResult.status ?? 1) !== 0) {
      process.exit(rebuildResult.status ?? 1);
    }
  }
}

const kuzuEntryPath = resolve(repoRoot, "node_modules", "kuzu", "index.mjs");
if (!existsSync(kuzuEntryPath)) {
  console.log(
    "[test setup] kuzu/index.mjs missing (likely from --ignore-scripts); rebuilding kuzu...",
  );
  const rebuildCmd = process.platform === "win32" ? "cmd.exe" : "npm";
  const rebuildArgs =
    process.platform === "win32"
      ? ["/c", "npm", "rebuild", "kuzu"]
      : ["rebuild", "kuzu"];
  const rebuildResult = spawnSync(rebuildCmd, rebuildArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: setupEnv,
  });
  if ((rebuildResult.status ?? 1) !== 0) {
    process.exit(rebuildResult.status ?? 1);
  }
}

await runIsolatedTests(testFiles, baseTestEnv, testTempDir);

try {
  rmSync(testTempDir, { recursive: true, force: true });
} catch {
  // Best-effort cleanup (files may be locked on Windows).
}

log("\n" + "=".repeat(60));
log("[run-tests] SUMMARY");
log("=".repeat(60));
log(`Total test files: ${totalTests}`);
log(`  Passed: ${passedTests}`);
log(`  Passed (segfault on exit): ${passedWithSegfault.length}`);
log(`  Failed: ${failedTests}`);

if (failedTestFiles.length > 0) {
  log("\nFailed tests:");
  for (const filePath of failedTestFiles) {
    log(`  - ${filePath}`);
  }
}

if (passedWithSegfault.length > 0) {
  log("\nTests that passed but segfaulted on exit:");
  for (const filePath of passedWithSegfault) {
    log(`  - ${filePath}`);
  }
}

log("=".repeat(60));
log(`Overall: ${overallFailed ? "FAILED" : "PASSED"}`);
log("=".repeat(60));

writeLog();
process.exit(overallFailed ? 1 : 0);
