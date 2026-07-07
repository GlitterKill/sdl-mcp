import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const runnerSource = readFileSync(
  join(repoRoot, "scripts", "run-tests.mjs"),
  "utf8",
);
const pkg = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

describe("run-tests script parallel suites", () => {
  it("exposes group-filtered npm scripts", () => {
    assert.strictEqual(
      pkg.scripts?.["test:unit"],
      "node scripts/run-tests.mjs --group=unit",
    );
    assert.strictEqual(
      pkg.scripts?.["test:integration"],
      "node scripts/run-tests.mjs --group=integration",
    );
    assert.strictEqual(
      pkg.scripts?.["test:property"],
      "node scripts/run-tests.mjs --group=property",
    );
  });

  it("keeps native parity out of the native-disabled group runner", () => {
    assert.strictEqual(
      pkg.scripts?.["test:native"],
      "npm run build:all && npm run test:native-parity && npm run test:layout-parity && npm run test:native-index-smoke && npm run test:parity",
    );
  });

  it("supports SDL_TEST_JOBS with a conservative default cap", () => {
    assert.match(runnerSource, /availableParallelism/);
    assert.match(runnerSource, /SDL_TEST_JOBS/);
    assert.match(runnerSource, /Math\.min\(4, Math\.max\(1, availableParallelism\(\) - 1\)\)/);
  });

  it("runs isolated test files through a worker pool with per-file graph DBs", () => {
    assert.match(runnerSource, /async function runIsolatedTests/);
    assert.match(runnerSource, /Promise\.all\(workers\)/);
    assert.match(runnerSource, /const testGraphDbPath = join\(testTempDir, `test-\$\{index\}-graph`\)/);
    assert.match(runnerSource, /SDL_GRAPH_DB_PATH: testGraphDbPath/);
  });
});
