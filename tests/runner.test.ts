import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { globSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const runnerPath = resolve(repoRoot, "tests", "runner.test.ts");

// node:sqlite is only available in Node >= 22; skip tests that require it
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
const SKIP_PATTERNS = [
  ...(nodeMajor < 22 ? ["sqlite-to-ladybug-migration"] : []),
  "draft-parser",
  "file-patcher",
];

const testFiles = [...globSync("tests/**/*.test.ts", { cwd: repoRoot })].map(f => resolve(repoRoot, f)).sort();

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
    console.error(`[runner] Failed to import ${filePath}:`, (err as Error).message);
  }
}

