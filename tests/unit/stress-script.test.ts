import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("stress test package script", () => {
  it("compiles the stress harness before running it", () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };

    assert.strictEqual(
      pkg.scripts?.["test:stress"],
      "npm run build && npx tsc --rootDir tests/stress --outDir dist/tests/stress --module nodenext tests/stress/run-stress.ts && node --max-old-space-size=4096 dist/tests/stress/run-stress.js --skip-build",
    );
  });
});
