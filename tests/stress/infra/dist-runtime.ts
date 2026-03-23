import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolveStressDistRoot(moduleUrl: string): string {
  const currentDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(currentDir, "../../../dist"),
    resolve(currentDir, "../../../../dist"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "cli", "transport", "http.js"))) {
      return candidate;
    }
  }

  throw new Error(`Could not locate built dist/ directory from ${currentDir}`);
}

export function resolveStressRepoRoot(moduleUrl: string): string {
  const currentDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [resolve(currentDir, "../.."), resolve(currentDir, "../../..")];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }

  throw new Error(`Could not locate repository root from ${currentDir}`);
}

export async function importStressDistModule<T>(
  moduleUrl: string,
  relativePath: string,
): Promise<T> {
  const distRoot = resolveStressDistRoot(moduleUrl);
  return (await import(pathToFileURL(join(distRoot, relativePath)).href)) as T;
}
