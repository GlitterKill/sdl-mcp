#!/usr/bin/env node
/**
 * postinstall-watchman.mjs
 *
 * Validates SDL-managed Watchman binary packages when they are present. This
 * script never installs system packages or mutates global PATH; runtime code
 * passes the resolved private binary path directly to fb-watchman.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SDL_WATCHMAN_BINARY_ENV = "SDL_WATCHMAN_BINARY";
const SDL_WATCHMAN_PACKAGE = "sdl-mcp-watchman";
const requireFromHere = createRequire(import.meta.url);

function main() {
  const resolved = resolveWatchmanBinary();
  if (!resolved.binaryPath) {
    const detail =
      resolved.reason ?? `Watchman binary not found from ${SDL_WATCHMAN_PACKAGE}`;
    console.warn(
      `sdl-mcp: ${detail}; ` +
        "watchProvider:auto will fall back to Chokidar unless SDL_WATCHMAN_BINARY or an SDL-managed Watchman package provides a binary.",
    );
    return;
  }

  const version = spawnSync(resolved.binaryPath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (version.status === 0) {
    console.log(
      `sdl-mcp: Watchman ${version.stdout.trim()} available from ${resolved.source}`,
    );
    return;
  }

  console.warn(
    `sdl-mcp: Watchman binary at ${resolved.binaryPath} could not be executed: ${
      version.stderr.trim() || version.error?.message || `exit ${version.status}`
    }`,
  );
}

function resolveWatchmanBinary() {
  const envPath = process.env[SDL_WATCHMAN_BINARY_ENV]?.trim();
  if (envPath) {
    const binaryPath = isAbsolute(envPath) ? envPath : resolve(process.cwd(), envPath);
    if (existsSync(binaryPath)) {
      return { binaryPath, source: SDL_WATCHMAN_BINARY_ENV };
    }
    return {
      binaryPath: null,
      source: SDL_WATCHMAN_BINARY_ENV,
      reason: `${SDL_WATCHMAN_BINARY_ENV} points to a missing file: ${binaryPath}`,
    };
  }

  for (const packageName of getSdlWatchmanPackageNames()) {
    const packageJsonPath = resolvePackageJson(packageName);
    if (!packageJsonPath) continue;
    const packageRoot = dirname(packageJsonPath);
    for (const candidate of getPackageBinaryCandidates(packageJsonPath)) {
      const binaryPath = join(packageRoot, candidate);
      if (existsSync(binaryPath)) {
        return { binaryPath, source: packageName };
      }
    }
  }

  return { binaryPath: null, source: null };
}

function getSdlWatchmanPackageNames() {
  const platform = toWatchmanPackagePlatform(process.platform);
  const arch = toWatchmanPackageArch(process.arch);
  if (!platform || !arch) return [SDL_WATCHMAN_PACKAGE];
  return [SDL_WATCHMAN_PACKAGE, `${SDL_WATCHMAN_PACKAGE}-${platform}-${arch}`];
}

function getPackageBinaryCandidates(packageJsonPath) {
  const fileName = process.platform === "win32" ? "watchman.exe" : "watchman";
  const candidates = [`bin/${fileName}`, fileName];
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const configured = parsed?.sdlMcp?.watchmanBinary ?? parsed?.["sdl-mcp"]?.watchmanBinary;
    if (typeof configured === "string" && configured.trim()) {
      return [configured.trim(), ...candidates];
    }
  } catch {
    // Keep postinstall non-fatal; runtime fallback will report provider failure.
  }
  return candidates;
}

function resolvePackageJson(packageName) {
  try {
    return requireFromHere.resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }
}

function toWatchmanPackagePlatform(platform) {
  switch (platform) {
    case "darwin":
    case "linux":
    case "win32":
      return platform;
    default:
      return null;
  }
}

function toWatchmanPackageArch(arch) {
  switch (arch) {
    case "arm64":
    case "x64":
      return arch;
    default:
      return null;
  }
}

try {
  main();
} catch (error) {
  console.warn(
    `sdl-mcp: Watchman postinstall warning: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
