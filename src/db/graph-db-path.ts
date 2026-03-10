import { existsSync, statSync } from "fs";
import { basename, dirname, extname, resolve } from "path";

import type { AppConfig } from "../config/types.js";

export const DEFAULT_GRAPH_DB_FILENAME = "sdl-mcp-graph.lbug";
const LEGACY_GRAPH_DB_DIRNAME = "sdl-mcp-graph";

type GraphDbPathHint = "auto" | "file" | "directory";

function hasDirectorySuffix(value: string): boolean {
  return value.endsWith("/") || value.endsWith("\\");
}

function inferGraphDbPathHint(
  rawPath: string,
  resolvedPath: string,
): Exclude<GraphDbPathHint, "auto"> {
  if (existsSync(resolvedPath)) {
    try {
      if (statSync(resolvedPath).isDirectory()) {
        return "directory";
      }
    } catch {
      // Fall through to heuristics when the path cannot be stat'ed.
    }
  }

  if (hasDirectorySuffix(rawPath)) {
    return "directory";
  }

  if (extname(resolvedPath)) {
    return "file";
  }

  if (basename(resolvedPath).toLowerCase() === LEGACY_GRAPH_DB_DIRNAME) {
    return "directory";
  }

  return "directory";
}

export function normalizeGraphDbPath(
  rawPath: string | undefined | null,
  hint: GraphDbPathHint = "auto",
): string {
  if (!rawPath) {
    return resolve(DEFAULT_GRAPH_DB_FILENAME);
  }
  const trimmedPath = rawPath.trim();
  const resolvedPath = resolve(trimmedPath);
  const effectiveHint =
    hint === "auto" ? inferGraphDbPathHint(trimmedPath, resolvedPath) : hint;

  if (effectiveHint === "directory") {
    return resolve(resolvedPath, DEFAULT_GRAPH_DB_FILENAME);
  }

  return resolvedPath;
}

export function defaultGraphDbPath(resolvedConfigPath: string): string {
  return resolve(dirname(resolvedConfigPath), DEFAULT_GRAPH_DB_FILENAME);
}

export function resolveGraphDbPath(
  config: AppConfig,
  resolvedConfigPath: string,
): string {
  const envDirectory = process.env.SDL_GRAPH_DB_DIR;
  if (envDirectory && envDirectory.trim()) {
    return normalizeGraphDbPath(envDirectory, "directory");
  }

  const envPath = process.env.SDL_GRAPH_DB_PATH ?? process.env.SDL_DB_PATH;
  if (envPath && envPath.trim()) {
    return normalizeGraphDbPath(envPath, "auto");
  }

  const configuredPath = config.graphDatabase?.path;
  if (configuredPath && configuredPath.trim()) {
    return normalizeGraphDbPath(configuredPath, "auto");
  }

  return defaultGraphDbPath(resolvedConfigPath);
}
