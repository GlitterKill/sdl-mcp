import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  _resetNativeAddonLoaderForTests,
  getNativeAddonLoadFailure,
  getNativeAddonSourcePath,
  isNativeAddonGloballyEnabled,
  loadNativeAddon,
} from "../../dist/native/addon-loader.js";
import { isRustEngineAvailable } from "../../dist/indexer/rustIndexer.js";
import { isNativeLayoutEngineAvailable } from "../../dist/graph/layout/native-engine.js";
import { isRustScipDecoderAvailable } from "../../dist/scip/decoder-rust.js";

const originalDisable = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
const originalOverride = process.env.SDL_MCP_NATIVE_ADDON_PATH;

beforeEach(() => {
  delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
});

afterEach(() => {
  if (originalDisable === undefined) {
    delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
  } else {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = originalDisable;
  }
  if (originalOverride === undefined) {
    delete process.env.SDL_MCP_NATIVE_ADDON_PATH;
  } else {
    process.env.SDL_MCP_NATIVE_ADDON_PATH = originalOverride;
  }
  _resetNativeAddonLoaderForTests();
});

describe("native addon loader", () => {
  it("preserves the existing global disable values", () => {
    for (const value of ["1", "true", "TRUE", "True"]) {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = value;
      assert.strictEqual(isNativeAddonGloballyEnabled(), false, value);
    }

    for (const value of ["", "0", "false", "yes"]) {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = value;
      assert.strictEqual(isNativeAddonGloballyEnabled(), true, value);
    }
  });

  it("tries the override, local builds, then the package", () => {
    const attempts: string[] = [];
    process.env.SDL_MCP_NATIVE_ADDON_PATH = "override.node";
    _resetNativeAddonLoaderForTests({
      loadCandidate(candidate) {
        attempts.push(candidate);
        throw new Error("missing");
      },
    });

    assert.strictEqual(loadNativeAddon(), null);
    assert.strictEqual(attempts[0], "override.node");
    assert.match(attempts[1].replaceAll("\\", "/"), /\/native\/sdl-mcp-native\.node$/);
    assert.match(attempts[2].replaceAll("\\", "/"), /\/native\/index\.node$/);
    assert.strictEqual(attempts[3], "sdl-mcp-native");
  });

  it("caches the first loaded addon", () => {
    const addon = { parseFiles() {} };
    let attempts = 0;
    _resetNativeAddonLoaderForTests({
      loadCandidate() {
        attempts += 1;
        return addon;
      },
    });

    assert.strictEqual(loadNativeAddon(), addon);
    assert.strictEqual(loadNativeAddon(), addon);
    assert.match(
      getNativeAddonSourcePath()?.replaceAll("\\", "/") ?? "",
      /\/native\/sdl-mcp-native\.node$/,
    );
    assert.strictEqual(attempts, 1);
  });

  it("continues past loaded candidates that lack the requested capability", () => {
    const incompatibleAddon = { computeLayout() {} };
    const compatibleAddon = { parseFiles() {} };
    const attempts: string[] = [];
    _resetNativeAddonLoaderForTests({
      loadCandidate(candidate) {
        attempts.push(candidate);
        return attempts.length === 1 ? incompatibleAddon : compatibleAddon;
      },
    });

    const loaded = loadNativeAddon(
      (candidate) =>
        !!candidate &&
        typeof candidate === "object" &&
        typeof (candidate as { parseFiles?: unknown }).parseFiles === "function",
    );

    assert.strictEqual(loaded, compatibleAddon);
    assert.strictEqual(attempts.length, 2);
    assert.match(
      getNativeAddonSourcePath()?.replaceAll("\\", "/") ?? "",
      /\/native\/index\.node$/,
    );
  });

  it("caches unavailability and logs it once", () => {
    let attempts = 0;
    let failures = 0;
    _resetNativeAddonLoaderForTests({
      loadCandidate() {
        attempts += 1;
        throw new Error("missing");
      },
      logFailure() {
        failures += 1;
      },
    });

    assert.strictEqual(loadNativeAddon(), null);
    const attemptsAfterFirstLoad = attempts;
    assert.strictEqual(loadNativeAddon(), null);
    assert.strictEqual(attempts, attemptsAfterFirstLoad);
    assert.strictEqual(failures, 1);
    assert.strictEqual(getNativeAddonLoadFailure(), "not found");
  });

  it("leaves capability acceptance to each consumer", () => {
    const addon = {
      parseFiles() {},
      hashContentNative() {},
      generateSymbolIdNative() {},
    };
    _resetNativeAddonLoaderForTests({ loadCandidate: () => addon });

    assert.strictEqual(isRustEngineAvailable(), true);
    assert.strictEqual(isRustScipDecoderAvailable(), false);
    assert.strictEqual(isNativeLayoutEngineAvailable(), false);
  });
});
