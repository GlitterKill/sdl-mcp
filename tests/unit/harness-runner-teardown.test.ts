import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("harness runner teardown", () => {
  it("stops harness before exiting success path", () => {
    const source = readFileSync(
      join(process.cwd(), "tests", "harness", "runner.ts"),
      "utf8",
    );

    assert.match(
      source,
      /const allProfilesPassed[\s\S]*await harness\.stop\(\);\s*process\.exit\(allProfilesPassed \? 0 : 1\);/,
      "success path should await harness.stop() before process.exit()",
    );
  });
});
