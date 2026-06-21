import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("agent workflow sync", () => {
  it("keeps generated agent workflow surfaces current", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/check-agent-workflows.mjs", "--check"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    assert.equal(result.status, 0, `${result.stdout}
${result.stderr}`);
  });
});
