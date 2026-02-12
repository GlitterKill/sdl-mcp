import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { findPackageRoot } from "../util/findPackageRoot.js";

const CONFIG_FILE_NAME = "sdlmcp.config.json";

export type ConfigPathMode = "read" | "write";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function normalizeOptionalPath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  const trimmed = path.trim();
  return trimmed.length > 0 ? resolve(trimmed) : undefined;
}

function resolveGlobalConfigPath(): string {
  const configHome = normalizeOptionalPath(process.env.SDL_CONFIG_HOME);
  if (configHome) {
    return resolve(configHome, CONFIG_FILE_NAME);
  }

  const appData = normalizeOptionalPath(process.env.APPDATA);
  if (process.platform === "win32" && appData) {
    return resolve(appData, "sdl-mcp", CONFIG_FILE_NAME);
  }

  const xdgConfigHome = normalizeOptionalPath(process.env.XDG_CONFIG_HOME);
  if (xdgConfigHome) {
    return resolve(xdgConfigHome, "sdl-mcp", CONFIG_FILE_NAME);
  }

  const homePath = normalizeOptionalPath(
    process.env.HOME ?? process.env.USERPROFILE ?? homedir(),
  );

  if (!homePath) {
    const packageRoot = findPackageRoot(__dirname);
    return resolve(packageRoot, "config", CONFIG_FILE_NAME);
  }

  return resolve(homePath, ".config", "sdl-mcp", CONFIG_FILE_NAME);
}

function resolveLegacyConfigCandidates(): string[] {
  const packageRoot = findPackageRoot(__dirname);
  return [
    resolve(process.cwd(), "config", CONFIG_FILE_NAME),
    resolve(packageRoot, "config", CONFIG_FILE_NAME),
  ];
}

export function resolveCliConfigPath(
  configPath?: string,
  mode: ConfigPathMode = "read",
): string {
  const explicitConfigPath = normalizeOptionalPath(configPath);
  if (explicitConfigPath) {
    return explicitConfigPath;
  }

  const envConfigPath =
    normalizeOptionalPath(process.env.SDL_CONFIG) ??
    normalizeOptionalPath(process.env.SDL_CONFIG_PATH);
  if (envConfigPath) {
    return envConfigPath;
  }

  const globalConfigPath = resolveGlobalConfigPath();
  if (mode === "write") {
    return globalConfigPath;
  }

  if (existsSync(globalConfigPath)) {
    return globalConfigPath;
  }

  for (const candidatePath of resolveLegacyConfigCandidates()) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return globalConfigPath;
}

export function activateCliConfigPath(
  configPath?: string,
  mode: ConfigPathMode = "read",
): string {
  const resolvedPath = resolveCliConfigPath(configPath, mode);
  process.env.SDL_CONFIG = resolvedPath;
  return resolvedPath;
}
