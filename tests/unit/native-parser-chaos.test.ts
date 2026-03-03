import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("Native parser chaos", () => {
  const runner = resolve(process.cwd(), "tests/fixtures/native-addon/run-parse-files.mjs");
  const okAddon = resolve(process.cwd(), "tests/fixtures/native-addon/minimal-ok.cjs");
  const throwsAddon = resolve(process.cwd(), "tests/fixtures/native-addon/throws.cjs");
  const badCountAddon = resolve(process.cwd(), "tests/fixtures/native-addon/bad-count.cjs");

  const run = (addonPath: string): unknown => {
    const proc = spawnSync(process.execPath, ["--import", "tsx", runner], {
      env: {
        ...process.env,
        SDL_MCP_NATIVE_ADDON_PATH: addonPath,
      },
      encoding: "utf8",
    });

    assert.strictEqual(
      proc.status,
      0,
      proc.stderr || proc.stdout || "child process failed",
    );

    const stdout = proc.stdout.trim();
    return stdout === "" ? null : JSON.parse(stdout);
  };

  it("returns results when native addon succeeds", () => {
    const result = run(okAddon);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.relPath, "src/foo.ts");
  });

  it("returns null when native addon throws", () => {
    const result = run(throwsAddon);
    assert.strictEqual(result, null);
  });

  it("returns null when native addon returns mismatched result count", () => {
    const result = run(badCountAddon);
    assert.strictEqual(result, null);
  });
});

