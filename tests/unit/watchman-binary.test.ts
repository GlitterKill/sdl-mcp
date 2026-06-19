import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getSdlWatchmanPackageNames,
  resolveWatchmanBinary,
} from "../../dist/indexer/watchman-binary.js";

describe("Watchman binary resolution", () => {
  it("uses SDL_WATCHMAN_BINARY before package lookup", () => {
    const envBinary =
      process.platform === "win32"
        ? "C:\\repo\\tools\\watchman.exe"
        : "/repo/tools/watchman";
    const result = resolveWatchmanBinary({
      env: { SDL_WATCHMAN_BINARY: envBinary },
      exists: (path) => path === envBinary,
      resolvePackageJson: () => {
        throw new Error("package lookup should not run");
      },
    });

    assert.equal(result.source, "env");
    assert.equal(result.binaryPath, envBinary);
  });

  it("resolves SDL-managed platform packages with package metadata", () => {
    const packageJson = "/repo/node_modules/sdl-mcp-watchman-linux-x64/package.json";
    const result = resolveWatchmanBinary({
      env: {},
      platform: "linux",
      arch: "x64",
      resolvePackageJson: (packageName) =>
        packageName === "sdl-mcp-watchman-linux-x64" ? packageJson : null,
      readText: () => JSON.stringify({ sdlMcp: { watchmanBinary: "vendor/watchman" } }),
      exists: (path) =>
        path.replaceAll("\\", "/") ===
        "/repo/node_modules/sdl-mcp-watchman-linux-x64/vendor/watchman",
    });

    assert.equal(result.source, "package");
    assert.equal(result.packageName, "sdl-mcp-watchman-linux-x64");
    assert.equal(
      result.binaryPath?.replaceAll("\\", "/"),
      "/repo/node_modules/sdl-mcp-watchman-linux-x64/vendor/watchman",
    );
  });

  it("reports missing SDL-managed packages without falling back to PATH", () => {
    const result = resolveWatchmanBinary({
      env: {},
      platform: "linux",
      arch: "x64",
      resolvePackageJson: () => null,
    });

    assert.equal(result.binaryPath, null);
    assert.equal(result.source, null);
    assert.match(result.reason ?? "", /No SDL-managed Watchman package found/);
  });

  it("checks the meta package before the platform package", () => {
    assert.deepEqual(getSdlWatchmanPackageNames("darwin", "arm64"), [
      "sdl-mcp-watchman",
      "sdl-mcp-watchman-darwin-arm64",
    ]);
  });
});
