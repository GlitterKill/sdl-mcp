/* eslint-disable */

/**
 * Platform-detection loader for sdl-mcp-native.
 *
 * Standard napi-rs pattern: detects process.platform/process.arch and loads
 * the correct prebuilt binary from per-platform npm packages.
 */

const { existsSync, readFileSync } = require("fs");
const { join } = require("path");

/**
 * Determine the platform package name based on current OS/arch/libc.
 * @returns {string | null}
 */
function getPackageName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32" && arch === "x64") {
    return "sdl-mcp-native-win32-x64-msvc";
  }
  if (platform === "darwin" && arch === "x64") {
    return "sdl-mcp-native-darwin-x64";
  }
  if (platform === "darwin" && arch === "arm64") {
    return "sdl-mcp-native-darwin-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    // Detect musl vs glibc
    if (isMusl()) {
      return "sdl-mcp-native-linux-x64-musl";
    }
    return "sdl-mcp-native-linux-x64-gnu";
  }
  if (platform === "linux" && arch === "arm64") {
    return "sdl-mcp-native-linux-arm64-gnu";
  }

  return null;
}

/**
 * Detect musl libc on Linux.
 * @returns {boolean}
 */
function isMusl() {
  // Check if we're running on Alpine or musl-based distro
  try {
    const output = readFileSync("/usr/bin/ldd", "utf8");
    if (output.includes("musl")) return true;
  } catch {
    // ldd not readable
  }

  try {
    if (existsSync("/etc/alpine-release")) return true;
  } catch {
    // not alpine
  }

  // Check the dynamic linker
  try {
    const maps = readFileSync("/proc/self/maps", "utf8");
    if (maps.includes("musl")) return true;
  } catch {
    // /proc not available
  }

  return false;
}

/**
 * Map platform package names to their .node file suffix.
 */
const PLATFORM_NODE_FILES = {
  "sdl-mcp-native-win32-x64-msvc": "sdl-mcp-native.win32-x64-msvc.node",
  "sdl-mcp-native-darwin-x64": "sdl-mcp-native.darwin-x64.node",
  "sdl-mcp-native-darwin-arm64": "sdl-mcp-native.darwin-arm64.node",
  "sdl-mcp-native-linux-x64-gnu": "sdl-mcp-native.linux-x64-gnu.node",
  "sdl-mcp-native-linux-x64-musl": "sdl-mcp-native.linux-x64-musl.node",
  "sdl-mcp-native-linux-arm64-gnu": "sdl-mcp-native.linux-arm64-gnu.node",
};

let nativeBinding = null;
let loadError = null;

const packageName = getPackageName();

if (packageName) {
  const nodeFileName = PLATFORM_NODE_FILES[packageName];

  // 1. Try local platform-suffixed .node file (dev builds via napi artifacts)
  const localPlatformPath = join(__dirname, nodeFileName);
  if (existsSync(localPlatformPath)) {
    try {
      nativeBinding = require(localPlatformPath);
    } catch (e) {
      loadError = e;
    }
  }

  // 2. Try per-platform npm package
  if (!nativeBinding) {
    try {
      nativeBinding = require(packageName);
    } catch (e) {
      loadError = e;
    }
  }

  // 3. Try legacy local files (backward compat with dev builds)
  if (!nativeBinding) {
    const legacyPaths = [
      join(__dirname, "sdl-mcp-native.node"),
      join(__dirname, "index.node"),
    ];
    for (const p of legacyPaths) {
      if (existsSync(p)) {
        try {
          nativeBinding = require(p);
          break;
        } catch (e) {
          loadError = e;
        }
      }
    }
  }
} else {
  loadError = new Error(
    `Unsupported platform: ${process.platform}-${process.arch}. ` +
    `sdl-mcp-native supports: win32-x64, darwin-x64, darwin-arm64, linux-x64, linux-arm64`
  );
}

if (!nativeBinding) {
  if (loadError) {
    throw loadError;
  }
  throw new Error("Failed to load sdl-mcp-native native binding");
}

module.exports.parseFiles = nativeBinding.parseFiles;
module.exports.hashContentNative = nativeBinding.hashContentNative;
module.exports.generateSymbolIdNative = nativeBinding.generateSymbolIdNative;
