import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import fg from "fast-glob";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const runnerPath = resolve(repoRoot, "tests", "runner.test.ts");

const testFiles = await fg("tests/**/*.test.ts", {
  cwd: repoRoot,
  onlyFiles: true,
  absolute: true,
}).then((paths) => paths.sort());

for (const filePath of testFiles) {
  if (resolve(filePath) === runnerPath) {
    continue;
  }
  await import(pathToFileURL(filePath).href);
}

