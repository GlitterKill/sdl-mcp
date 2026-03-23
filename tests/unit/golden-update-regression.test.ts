import assert from "node:assert/strict";
import { existsSync, renameSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");
const scriptPath = resolve(repoRoot, "scripts/golden/update-goldens.ts");

function runUpdater(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("golden updater regressions", () => {
  it("loads adapters from dist rather than src", () => {
    const source = readFileSync(scriptPath, "utf8");
    assert.ok(source.includes("../../dist/indexer/adapter/rust.js"));
    assert.ok(!source.includes("../../src/indexer/adapter/rust.js"));
  });

  it("fails validation when a source file is missing", () => {
    const fixturePath = resolve(repoRoot, "tests/fixtures/rust/symbols.rs");
    const backupPath = `${fixturePath}.bak`;

    if (existsSync(backupPath)) {
      renameSync(backupPath, fixturePath);
    }

    renameSync(fixturePath, backupPath);
    try {
      const result = runUpdater(["validate", "rust"]);
      assert.notEqual(
        result.status,
        0,
        `Expected missing source file to fail.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
    } finally {
      renameSync(backupPath, fixturePath);
    }
  });

  it("runs successfully when dist rust adapter is present", () => {
    const distAdapterPath = resolve(repoRoot, "dist/indexer/adapter/rust.js");

    assert.ok(
      existsSync(distAdapterPath),
      "dist/indexer/adapter/rust.js must exist for this regression test",
    );

    const result = runUpdater(["validate", "rust"]);
    assert.ok(
      result.stdout.includes("Processing 3 golden file specs"),
      `Expected updater to execute successfully.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  });
});
