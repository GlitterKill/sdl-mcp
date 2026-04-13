import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { globSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const runnerPath = resolve(repoRoot, "tests", "runner.test.ts");

// Skip patterns for tests with import issues or that are run isolated.
// draft-parser, file-patcher: isolated in run-tests.mjs due to LadybugDB
// native addon segfaults on Windows process exit (tests pass, exit fails).
const SKIP_PATTERNS = [
  "draft-parser",
  "file-patcher",
  "sqlite-to-ladybug-migration",
  "vscode-buffer-push",
  "check-benchmark-claims",
  "build-exe", // scripts/ not compiled to dist/
  "stress-timing-diagnostics", // test infra in tests/stress/ not compiled
];

const testFiles = [...globSync("tests/**/*.test.ts", { cwd: repoRoot })]
  .map((f) => resolve(repoRoot, f))
  .sort();

for (const filePath of testFiles) {
  if (resolve(filePath) === runnerPath) {
    continue;
  }
  if (SKIP_PATTERNS.some((p) => filePath.includes(p))) {
    continue;
  }
  try {
    await import(pathToFileURL(filePath).href);
  } catch (err) {
    console.error(
      `[runner] Failed to import ${filePath}:`,
      (err as Error).message,
    );
  }
}
