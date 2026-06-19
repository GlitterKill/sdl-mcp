import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";

import { logger } from "../util/logger.js";

export const SDL_WATCHMAN_BINARY_ENV = "SDL_WATCHMAN_BINARY";
export const SDL_WATCHMAN_PACKAGE = "sdl-mcp-watchman";

export type WatchmanBinarySource = "env" | "package";

export type WatchmanBinaryResolution = {
  binaryPath: string | null;
  source: WatchmanBinarySource | null;
  packageName?: string;
  reason?: string;
};

type WatchmanBinaryPackageJson = {
  sdlMcp?: {
    watchmanBinary?: unknown;
  };
  "sdl-mcp"?: {
    watchmanBinary?: unknown;
  };
};

type WatchmanBinaryResolverOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  cwd?: string;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
  resolvePackageJson?: (packageName: string) => string | null;
};

const requireFromHere = createRequire(import.meta.url);

export function getSdlWatchmanPackageNames(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string[] {
  const platformKey = toWatchmanPackagePlatform(platform);
  const archKey = toWatchmanPackageArch(arch);
  if (!platformKey || !archKey) {
    return [SDL_WATCHMAN_PACKAGE];
  }
  return [SDL_WATCHMAN_PACKAGE, `${SDL_WATCHMAN_PACKAGE}-${platformKey}-${archKey}`];
}

export function resolveWatchmanBinary(
  options: WatchmanBinaryResolverOptions = {},
): WatchmanBinaryResolution {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const cwd = options.cwd ?? process.cwd();
  const envPath = env[SDL_WATCHMAN_BINARY_ENV]?.trim();
  if (envPath) {
    const binaryPath = isAbsolute(envPath) ? envPath : resolve(cwd, envPath);
    if (exists(binaryPath)) {
      return { binaryPath, source: "env" };
    }
    return {
      binaryPath: null,
      source: "env",
      reason: `${SDL_WATCHMAN_BINARY_ENV} points to a missing file: ${binaryPath}`,
    };
  }

  const packageNames = getSdlWatchmanPackageNames(options.platform, options.arch);
  for (const packageName of packageNames) {
    const packageBinary = resolvePackageBinary(packageName, options);
    if (packageBinary.binaryPath) {
      return packageBinary;
    }
  }

  return {
    binaryPath: null,
    source: null,
    reason: `No SDL-managed Watchman package found for ${
      options.platform ?? process.platform
    }-${options.arch ?? process.arch}`,
  };
}

function resolvePackageBinary(
  packageName: string,
  options: WatchmanBinaryResolverOptions,
): WatchmanBinaryResolution {
  const packageJsonPath = resolvePackageJson(packageName, options);
  if (!packageJsonPath) {
    return { binaryPath: null, source: "package", packageName };
  }

  const exists = options.exists ?? existsSync;
  const packageRoot = dirname(packageJsonPath);
  for (const relPath of getPackageBinaryCandidates(packageJsonPath, options)) {
    const binaryPath = join(packageRoot, relPath);
    if (exists(binaryPath)) {
      return { binaryPath, source: "package", packageName };
    }
  }

  return {
    binaryPath: null,
    source: "package",
    packageName,
    reason: `${packageName} is installed but does not contain a Watchman binary`,
  };
}

function getPackageBinaryCandidates(
  packageJsonPath: string,
  options: WatchmanBinaryResolverOptions,
): string[] {
  const readText = options.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const platform = options.platform ?? process.platform;
  const fileName = platform === "win32" ? "watchman.exe" : "watchman";
  const candidates = [`bin/${fileName}`, fileName];

  try {
    const parsed = JSON.parse(readText(packageJsonPath)) as WatchmanBinaryPackageJson;
    const configured = parsed.sdlMcp?.watchmanBinary ?? parsed["sdl-mcp"]?.watchmanBinary;
    if (typeof configured === "string" && configured.trim().length > 0) {
      return [configured.trim(), ...candidates];
    }
  } catch (error) {
    logger.debug("[sdl-mcp] could not parse Watchman package metadata", {
      packageJsonPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return candidates;
}

function resolvePackageJson(
  packageName: string,
  options: WatchmanBinaryResolverOptions,
): string | null {
  if (options.resolvePackageJson) {
    return options.resolvePackageJson(packageName);
  }
  try {
    return requireFromHere.resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }
}

function toWatchmanPackagePlatform(platform: NodeJS.Platform): string | null {
  switch (platform) {
    case "darwin":
    case "linux":
    case "win32":
      return platform;
    default:
      return null;
  }
}

function toWatchmanPackageArch(arch: NodeJS.Architecture): string | null {
  switch (arch) {
    case "arm64":
    case "x64":
      return arch;
    default:
      return null;
  }
}
