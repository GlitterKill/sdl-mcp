import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("schema sync script", () => {
  it("passes for the committed base schema and migrations", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/check-schema-sync.mjs")],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    assert.strictEqual(
      result.status,
      0,
      `${result.stdout}\n${result.stderr}`,
    );
  });
});
