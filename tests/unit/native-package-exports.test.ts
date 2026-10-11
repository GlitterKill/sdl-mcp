import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../native/index.js", import.meta.url), "utf8");
for (const [platform, arch, musl, expectedPackage] of [
  ["win32", "x64", false, "sdl-mcp-native-win32-x64-msvc"],
  ["darwin", "x64", false, "sdl-mcp-native-darwin-x64"],
  ["darwin", "arm64", false, "sdl-mcp-native-darwin-arm64"],
  ["linux", "x64", false, "sdl-mcp-native-linux-x64-gnu"],
  ["linux", "x64", true, "sdl-mcp-native-linux-x64-musl"],
  ["linux", "arm64", false, "sdl-mcp-native-linux-arm64-gnu"],
] as const) {
  test(`package loader forwards parser APIs through ${expectedPackage}`, () => {
    const binding = {
      parseFiles: () => [],
      parseFilesAsync: async () => [],
      parseContent: async () => ({ symbols: [] }),
      parserIdentityContractVersion: () => 1,
      hashContentNative: () => "hash",
      generateSymbolIdNative: () => "id",
      preloadWindowsLibrary: () => ({ token: 1, loadedPath: "fixture" }),
      releaseWindowsLibrary: () => {},
    };
    const module = { exports: {} as Record<string, unknown> };
    const loads: string[] = [];
    runInNewContext(source, {
      __dirname: "/fixture/native",
      module,
      process: { platform, arch },
      require: (name: string) => {
        if (name === "path") return { join };
        if (name === "fs") return {
          existsSync: () => false,
          readFileSync: () => musl ? "musl" : "glibc",
        };
        loads.push(name);
        assert.equal(name, expectedPackage);
        return binding;
      },
    });
    assert.deepEqual(loads, [expectedPackage]);
    for (const [name, fn] of Object.entries(binding)) {
      assert.equal(module.exports[name], fn, `${name} must expose the actual packaged binding`);
    }
  });
}
