import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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

const result = spawnSync(process.execPath, nodeArgs, {
  cwd: repoRoot,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
