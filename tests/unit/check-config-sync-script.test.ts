import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

describe("check-config-sync script", () => {
  it("uses the built config output when src/config/types.js is not checked in", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/check-config-sync.ts"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.strictEqual(
      result.status,
      0,
      `Expected check-config-sync to succeed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  });
});
