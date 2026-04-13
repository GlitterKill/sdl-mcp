import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { globSync } from "node:fs";

// Exit codes that indicate Windows native addon segfaults.
// 0xC0000005 = ACCESS_VIOLATION, returned as signed int32 = -1073741819
const WINDOWS_SEGFAULT_EXIT_CODES = new Set([-1073741819, 3221225477]);

// Tests known to trigger native addon segfaults on Windows process exit.
// These are run isolated with TAP output parsing to determine pass/fail,
// ignoring the process exit code when it matches a known segfault value.
const SEGFAULT_BYPASS_TESTS = new Set([
  "tests/unit/draft-parser.test.ts",
  "tests/unit/file-patcher.test.ts",
]);

/**
 * Parse TAP output to determine if tests passed.
 * Handles both Node 24+ (ℹ prefix) and pre-24 (# prefix) formats.
 * Returns false if output is missing/truncated (fail-safe).
 */
function parseTapResult(output) {
  const hasFailures = /^not ok /m.test(output);
  const hasSummaryPass = /^[#ℹ] fail 0$/m.test(output);
  return { passed: !hasFailures && hasSummaryPass };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const allTestFiles = [
  ...globSync("tests/**/*.test.ts", { cwd: repoRoot }),
].sort();

if (allTestFiles.length === 0) {
  console.error("No test files found under tests/**/*.test.ts");
  process.exit(1);
}


// Skip patterns for tests with import issues or requiring special setup
// (matches SKIP_PATTERNS in runner.test.ts plus isolated tests run separately)
const SKIP_PATTERNS = [
  "draft-parser",
  "file-patcher",
  "sqlite-to-ladybug-migration",
  "vscode-buffer-push",
  "check-benchmark-claims",
  "build-exe",
  "stress-timing-diagnostics",
  "runner.test.ts",
];

const testFiles = allTestFiles.filter(
  (f) => !SKIP_PATTERNS.some((p) => f.includes(p)),
);
const nodeArgs = [
  "--test-concurrency=1",
  "--test",
  ...testFiles.map((f) => resolve(repoRoot, f)),
];

const testTempDir = mkdtempSync(join(tmpdir(), "sdl-mcp-tests-"));
const testGraphDbPath = join(testTempDir, "sdl-mcp-graph");
const testEnv = {
  ...process.env,
  SDL_GRAPH_DB_PATH: testGraphDbPath,
  SDL_DB_PATH: testGraphDbPath,
  SDL_MCP_DISABLE_NATIVE_ADDON: "1",
};

const buildCmd = process.platform === "win32" ? "cmd.exe" : "npm";
const buildArgs =
  process.platform === "win32"
    ? ["/c", "npm", "run", "build:runtime"]
    : ["run", "build:runtime"];
const buildResult = spawnSync(buildCmd, buildArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  env: testEnv,
});

if ((buildResult.status ?? 1) !== 0) {
  process.exit(buildResult.status ?? 1);
}

const treeSitterProbe = spawnSync(
  process.execPath,
  ["--input-type=module", "-e", "await import('tree-sitter');"],
  {
    cwd: repoRoot,
    stdio: "ignore",
    env: testEnv,
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
      env: testEnv,
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
    env: testEnv,
  });
  if ((rebuildResult.status ?? 1) !== 0) {
    process.exit(rebuildResult.status ?? 1);
  }
}

const initResult = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    "import { initLadybugDb } from './dist/db/ladybug.js'; await initLadybugDb(process.env.SDL_GRAPH_DB_PATH);",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: testEnv,
  },
);

if ((initResult.status ?? 1) !== 0) {
  process.exit(initResult.status ?? 1);
}

let overallFailed = false;
const result = spawnSync(process.execPath, nodeArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  env: testEnv,
});

// Run tests that need process isolation (due to module cache pollution in the main suite)
// Note: draft-parser.test.ts and file-patcher.test.ts may segfault during process shutdown
// due to LadybugDB native addon cleanup issues. The tests pass - only exit code is affected.
// Tests that need process isolation. Tests with LadybugDB segfaults on exit
// must also be listed in SEGFAULT_BYPASS_TESTS to enable TAP-based pass/fail.
const isolatedTests = [
  "tests/unit/draft-parser.test.ts",
  "tests/unit/file-patcher.test.ts",
];

for (const testFile of isolatedTests) {
  const isoResult = spawnSync(
    process.execPath,
    ["--test-concurrency=1", "--test-reporter=tap", "--test", resolve(repoRoot, testFile)],
    {
      cwd: repoRoot,
      stdio: "pipe",
      env: testEnv,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024, // 10 MB - prevent truncation of large test output
    },
  );

  // Check for spawnSync errors (e.g., buffer overflow)
  if (isoResult.error) {
    console.error(`[run-tests] ${testFile}: spawnSync error: ${isoResult.error.message}`);
    overallFailed = true;
    continue;
  }

  // Always print output so it appears in CI logs
  if (isoResult.stdout) process.stdout.write(isoResult.stdout);
  if (isoResult.stderr) process.stderr.write(isoResult.stderr);

  const exitCode = isoResult.status ?? 1;
  const isKnownSegfault = WINDOWS_SEGFAULT_EXIT_CODES.has(exitCode);
  const isSegfaultBypassTest = SEGFAULT_BYPASS_TESTS.has(testFile);

  if (exitCode !== 0) {
    if (isKnownSegfault && isSegfaultBypassTest) {
      // Segfault on exit expected - use TAP output to determine pass/fail
      const { passed } = parseTapResult(isoResult.stdout ?? "");
      if (!passed) {
        console.error(`[run-tests] ${testFile}: tests FAILED (TAP parse)`);
        overallFailed = true;
      } else {
        console.warn(
          `[run-tests] ${testFile}: tests passed, process exited with ` +
            `known segfault code ${exitCode} (LadybugDB native addon cleanup issue)`,
        );
      }
    } else {
      // Non-segfault exit: treat as real failure
      overallFailed = true;
    }
  }
}

// Clean up temp directory created for this test run
try {
  rmSync(testTempDir, { recursive: true, force: true });
} catch {
  // Best-effort cleanup (files may be locked on Windows)
}

if ((result.status ?? 1) !== 0) overallFailed = true;
process.exit(overallFailed ? 1 : 0);
