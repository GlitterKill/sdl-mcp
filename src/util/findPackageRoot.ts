import { existsSync } from "fs";
import { dirname, resolve } from "path";

/**
 * Find the nearest directory at/above startDir that contains package.json.
 * This lets compiled code (dist/...) locate repo resources (config/, migrations/, etc.)
 * without relying on fragile relative paths.
 */
export function findPackageRoot(startDir: string, maxDepth: number = 10): string {
  let dir = resolve(startDir);
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(resolve(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir);
}

