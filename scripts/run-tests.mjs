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
  ...testFiles.map((file) => resolve(repoRoot, file)),
];

const testTempDir = mkdtempSync(join(tmpdir(), "sdl-mcp-tests-"));
const testDbPath = join(testTempDir, "sdl-ledger.db");
const testEnv = {
  ...process.env,
  SDL_DB_PATH: testDbPath,
};

const migrationResult = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    "import { runDefaultMigrations } from './dist/db/migrations.js'; runDefaultMigrations();",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: testEnv,
  },
);

if ((migrationResult.status ?? 1) !== 0) {
  process.exit(migrationResult.status ?? 1);
}

const result = spawnSync(process.execPath, nodeArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  env: testEnv,
});

process.exit(result.status ?? 1);
