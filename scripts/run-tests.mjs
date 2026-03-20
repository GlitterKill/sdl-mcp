import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import fg from "fast-glob";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const testFiles = await fg("tests/**/*.test.ts", {
  cwd: repoRoot,
  onlyFiles: true,
}).then((paths) => paths.sort());

if (testFiles.length === 0) {
  console.error("No test files found under tests/**/*.test.ts");
  process.exit(1);
}

const nodeArgs = [
  "--import",
  "tsx",
  "--test-concurrency=1",
  "--test",
  resolve(repoRoot, "tests", "runner.test.ts"),
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

const result = spawnSync(process.execPath, nodeArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  env: testEnv,
});

// Clean up temp directory created for this test run
try {
  rmSync(testTempDir, { recursive: true, force: true });
} catch {
  // Best-effort cleanup (files may be locked on Windows)
}

process.exit(result.status ?? 1);
