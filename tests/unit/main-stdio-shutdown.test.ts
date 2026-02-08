import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("main stdio shutdown wiring", () => {
  it("unrefs cleanup interval so it cannot keep process alive", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");

    assert.match(
      source,
      /cleanupInterval\.unref\(\);/,
      "cleanup interval should be unref'd",
    );
  });

  it("handles stdin end/close to trigger graceful shutdown", () => {
    const source = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");

    assert.match(
      source,
      /process\.stdin\.once\("end",\s*\(\)\s*=>\s*void shutdown\("stdin-end"\)\);/,
      "stdin end should trigger shutdown",
    );
    assert.match(
      source,
      /process\.stdin\.once\("close",\s*\(\)\s*=>\s*void shutdown\("stdin-close"\)\);/,
      "stdin close should trigger shutdown",
    );
  });
});
