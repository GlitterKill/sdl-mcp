import { dirname, resolve } from "path";

import type { AppConfig } from "../config/types.js";
import { normalizePath } from "../util/paths.js";
import { initKuzuDb } from "./kuzu.js";

export function resolveGraphDbPath(
  config: AppConfig,
  resolvedConfigPath: string,
): string {
  const envPath =
    process.env.SDL_GRAPH_DB_PATH ??
    process.env.SDL_GRAPH_DB_DIR ??
    process.env.SDL_DB_PATH;

  if (envPath && envPath.trim()) {
    return resolve(envPath.trim());
  }

  if (config.graphDatabase?.path) {
    return resolve(config.graphDatabase.path);
  }

  return resolve(dirname(resolvedConfigPath), "sdl-mcp-graph");
}

export async function initGraphDb(
  config: AppConfig,
  resolvedConfigPath: string,
): Promise<string> {
  const graphDbPath = resolveGraphDbPath(config, resolvedConfigPath);
  await initKuzuDb(graphDbPath);
  return normalizePath(graphDbPath);
}

