import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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

process.exit(result.status ?? 1);
