import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const SCRIPTS_DIR = join(process.cwd(), "dist", "scripts");
const HARNESS_DIR = join(process.cwd(), "dist", "tests", "harness");

function fixImportsInFile(
  filePath: string,
  pattern: string,
  replacement: string,
): void {
  const content = readFileSync(filePath, "utf-8");
  const fixed = content.replace(new RegExp(pattern, "g"), replacement);
  writeFileSync(filePath, fixed, "utf-8");
}

function fixImportsInDirectory(
  dir: string,
  pattern: string,
  replacement: string,
): void {
  const files = readdirSync(dir);
  for (const file of files) {
    if (file.endsWith(".js")) {
      const filePath = join(dir, file);
      fixImportsInFile(filePath, pattern, replacement);
    }
  }
}

const scriptPattern = String.raw`"\.\.\/src\/"`;
const scriptReplacement = '"../"';
const scriptPattern2 = String.raw`'\.\.\/src\/"`;
const scriptReplacement2 = "'../'";

const harnessPattern = String.raw`"\.\.\/src\/"`;
const harnessReplacement = '"../../"';
const harnessPattern2 = String.raw`'\.\.\/src\/"`;
const harnessReplacement2 = "'../../'";

fixImportsInDirectory(SCRIPTS_DIR, scriptPattern, scriptReplacement);
fixImportsInDirectory(SCRIPTS_DIR, scriptPattern2, scriptReplacement2);
fixImportsInDirectory(HARNESS_DIR, harnessPattern, harnessReplacement);
fixImportsInDirectory(HARNESS_DIR, harnessPattern2, harnessReplacement2);
