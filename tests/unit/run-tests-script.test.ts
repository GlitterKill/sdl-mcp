import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const runnerSource = readFileSync(
  join(repoRoot, "scripts", "run-tests.mjs"),
  "utf8",
);
const ciSource = readFileSync(
  join(repoRoot, ".github", "workflows", "ci.yml"),
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
      "npm run build:native && npm run build:all && npm run test:native-parity && npm run test:layout-parity && npm run test:native-index-smoke && npm run test:native-live-index && npm run test:parity",
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

  it("reports each test file before awaiting its process", () => {
    assert.match(
      runnerSource,
      /log\(`\[run-tests\] \$\{isolatedTests\[index\]\}: START`\);\s*const result = await runTestFile/,
    );
  });

  it("times out stuck test files through the shared process-tree owner", () => {
    assert.match(runnerSource, /const TEST_FILE_TIMEOUT_MS = 10 \* 60 \* 1000/);
    assert.match(
      runnerSource,
      /setTimeout\(\(\) => \{[\s\S]*timedOut = true;[\s\S]*killProcessTree\(child\.pid\)/,
    );
    assert.match(
      runnerSource,
      /if \(result\.timedOut\) \{[\s\S]*reason: `timed out after \$\{TEST_FILE_TIMEOUT_MS\}ms`/,
    );
  });

  it("streams the CI test log and bounds the matrix job", () => {
    const testsJob =
      ciSource.match(/\r?\n  tests:\r?\n[\s\S]*?\r?\n  benchmarks:/)?.[0] ?? "";

    assert.match(testsJob, /timeout-minutes: 45/);
    assert.match(testsJob, /npm test 2>&1 \| tee "\$TEST_OUT"/);
    assert.match(testsJob, /TEST_EXIT=\$\{PIPESTATUS\[0\]\}/);
    assert.doesNotMatch(testsJob, /npm test > "\$TEST_OUT"/);
  });

  it("enables the Windows native loader only for real-vector tests", () => {
    assert.match(
      runnerSource,
      /SDL_MCP_DISABLE_NATIVE_ADDON:\s*"1"/,
    );
    assert.match(
      runnerSource,
      /const normalizedTestFile = testFile\.replaceAll\("\\\\", "\/"\);/,
    );
    assert.match(
      runnerSource,
      /if \(\s*process\.platform === "win32" &&\s*\(\s*normalizedTestFile === "tests\/integration\/semantic-embedding\.test\.ts" \|\|\s*normalizedTestFile === "tests\/integration\/provider-first-scip-execution\.test\.ts" \|\|\s*normalizedTestFile === "tests\/unit\/ladybug-edge-queries\.test\.ts"\s*\)\s*\) \{\s*delete env\.SDL_MCP_DISABLE_NATIVE_ADDON;\s*\}/,
    );
    assert.doesNotMatch(
      runnerSource,
      /testFile\.endsWith\(/,
    );
  });

  it("enables experimental module mocks only for tests that use them", () => {
    assert.match(runnerSource, /function needsExperimentalModuleMocks/);
    assert.match(runnerSource, /needsExperimentalModuleMocks\(testFile\)/);
    assert.match(runnerSource, /--experimental-test-module-mocks/);
  });

  it("excludes native tests from the native-disabled default selection", () => {
    assert.match(runnerSource, /const group = testGroupFor\(filePath\);/);
    assert.match(
      runnerSource,
      /selectedGroups\.size === 0\s*\?\s*group !== "native"\s*:\s*selectedGroups\.has\(group\)/,
    );
  });

  it("excludes the pinned context-quality suite from the ordinary runner", () => {
    assert.match(
      runnerSource,
      /const SKIP_PATTERNS = \[[\s\S]*"context-quality\.test\.ts"/,
    );
  });
});
