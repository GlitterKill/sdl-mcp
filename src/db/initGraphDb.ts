import type { AppConfig } from "../config/types.js";
import { normalizePath } from "../util/paths.js";
import { resolveGraphDbPath } from "./graph-db-path.js";
import { initLadybugDb } from "./ladybug.js";

export { resolveGraphDbPath } from "./graph-db-path.js";

export async function initGraphDb(
  config: AppConfig,
  resolvedConfigPath: string,
): Promise<string> {
  const graphDbPath = resolveGraphDbPath(config, resolvedConfigPath);
  await initLadybugDb(graphDbPath, {
    bufferPoolBytes: config.graphDatabase?.bufferPoolBytes ?? undefined,
  });
  return normalizePath(graphDbPath);
}
