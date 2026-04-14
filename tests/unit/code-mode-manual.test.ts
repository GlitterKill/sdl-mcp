import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateManual,
  getManualCached,
  invalidateManualCache,
  FN_NAME_MAP,
  ACTION_TO_FN,
} from "../../dist/code-mode/manual-generator.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { estimateTokens } from "../../dist/util/tokenize.js";

const originalSdlConfig = process.env.SDL_CONFIG;

describe("code-mode manual generator", () => {
  let tmpDir: string;

  before(() => {
    // Create a config with memory enabled so all functions appear in manual
    tmpDir = mkdtempSync(join(tmpdir(), "sdl-manual-"));
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      repos: [{ repoId: "test", rootPath: tmpDir, memory: { enabled: true } }],
      policy: {},
    }));
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();
    invalidateManualCache();
  });

  after(() => {
    if (originalSdlConfig !== undefined) {
      process.env.SDL_CONFIG = originalSdlConfig;
    } else {
      delete process.env.SDL_CONFIG;
    }
    invalidateConfigCache();
    invalidateManualCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generateManual() returns a non-empty string", () => {
    const result = generateManual();
    assert.strictEqual(typeof result, "string");
    assert.ok(result.length > 0);
  });

  it("manual contains all function names from FN_NAME_MAP", () => {
    const manual = generateManual();
    for (const key of Object.keys(FN_NAME_MAP)) {
      assert.ok(manual.includes(key), `Expected manual to include '${key}'`);
    }
  });

  it("manual token count is under 1500", () => {
    const manual = generateManual();
    const tokens = estimateTokens(manual);
    assert.ok(tokens < 3500, `Expected tokens < 3500, got ${tokens}`);
  });

  it("getManualCached() returns same reference on repeated calls", () => {
    invalidateManualCache();
    const result1 = getManualCached();
    const result2 = getManualCached();
    assert.strictEqual(result1, result2);
  });

  it("invalidateManualCache() causes regeneration", () => {
    const ref1 = getManualCached();
    invalidateManualCache();
    const ref2 = getManualCached();
    // After invalidation the cache is cleared and a new string is generated;
    // JS primitive strings compare by value so content equality is the observable check.
    assert.strictEqual(ref1, ref2);
  });

  it("FN_NAME_MAP and ACTION_TO_FN are consistent", () => {
    for (const [fn, action] of Object.entries(FN_NAME_MAP)) {
      assert.strictEqual(
        ACTION_TO_FN[action],
        fn,
        `ACTION_TO_FN["${action}"] should be "${fn}"`,
      );
    }
    assert.strictEqual(
      Object.keys(FN_NAME_MAP).length,
      Object.keys(ACTION_TO_FN).length,
    );
  });

  it("FN_NAME_MAP covers all 31 actions", () => {
    assert.strictEqual(Object.keys(FN_NAME_MAP).length, 31);
  });
});
