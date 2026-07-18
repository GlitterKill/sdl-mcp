import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOutputDigest } from "../../dist/runtime/output-digest.js";

test("tsc errors digest to file:line message", () => {
  const stdout = [
    "src/mcp/tools/code.ts(41,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/util/paths.ts(9,1): error TS2304: Cannot find name 'foo'.",
    "Found 2 errors in 2 files.",
  ].join("\n");
  const d = buildOutputDigest({ command: "tsc", stdout, stderr: "", exitCode: 2 });
  assert.equal(d.kind, "tsc");
  assert.equal(d.failures.length, 2);
  assert.deepEqual(d.failures[0], {
    file: "src/mcp/tools/code.ts", line: 41,
    message: "TS2322: Type 'string' is not assignable to type 'number'.",
  });
  assert.equal(d.summary, "2 errors in 2 files");
});

test("tsc digest strips repo root prefix and backslashes", () => {
  const stdout =
    "F:\\repo\\src\\a.ts(3,1): error TS2304: Cannot find name 'bar'.";
  const d = buildOutputDigest({
    command: "tsc",
    stdout,
    stderr: "",
    exitCode: 2,
    rootPath: "F:\\repo",
  });
  assert.equal(d.failures[0].file, "src/a.ts");
});

test("node:test failures digest to test names + first error line", () => {
  const stdout = [
    "✖ builds compact card (1.2ms)",
    "  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal",
    "✔ keeps non-empty deps (0.4ms)",
    "ℹ tests 2", "ℹ pass 1", "ℹ fail 1",
  ].join("\n");
  const d = buildOutputDigest({ command: "node --test", stdout, stderr: "", exitCode: 1 });
  assert.equal(d.kind, "node-test");
  assert.equal(d.failures.length, 1);
  assert.match(d.failures[0].name ?? "", /builds compact card/);
  assert.match(d.failures[0].message, /AssertionError/);
  assert.equal(d.summary, "1/2 tests failed");
});

test("success runs produce tiny digest with no failures", () => {
  const d = buildOutputDigest({ command: "node --test", stdout: "ℹ tests 5\nℹ pass 5\nℹ fail 0", stderr: "", exitCode: 0 });
  assert.equal(d.failures.length, 0);
  assert.equal(d.ok, true);
});

test("eslint stylish output digests error rows with rule ids", () => {
  const stdout = [
    "src/mcp/tools/code.ts",
    "  41:7   error  Unexpected any  @typescript-eslint/no-explicit-any",
    "  99:1   warning  Missing return type  @typescript-eslint/explicit-function-return-type",
    "",
    "✖ 2 problems (1 error, 1 warning)",
  ].join("\n");
  const d = buildOutputDigest({ command: "eslint src", stdout, stderr: "", exitCode: 1 });
  assert.equal(d.kind, "eslint");
  assert.equal(d.failures.length, 1);
  assert.equal(d.failures[0].file, "src/mcp/tools/code.ts");
  assert.equal(d.failures[0].line, 41);
  assert.match(d.failures[0].message, /no-explicit-any/);
  assert.equal(d.summary, "2 problems (1 error, 1 warning)");
});

test("npm errors keep first distinct payload lines", () => {
  const stderr = [
    "npm ERR! code ELIFECYCLE",
    "npm ERR! errno 1",
    "npm ERR! sdl-mcp@0.12.1 build: `tsc -p tsconfig.build.json`",
    "npm ERR! code ELIFECYCLE",
  ].join("\n");
  const d = buildOutputDigest({ command: "npm run build", stdout: "", stderr, exitCode: 1 });
  assert.equal(d.kind, "npm");
  assert.equal(d.failures.length, 3);
  assert.equal(d.summary, "code ELIFECYCLE");
});

test("unknown tools fall back to generic head/tail digest", () => {
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const d = buildOutputDigest({ command: "some-tool", stdout: big, stderr: "boom at line 3", exitCode: 1 });
  assert.equal(d.kind, "generic");
  assert.ok(d.failures[0].message.includes("boom"));
  assert.ok((d.excerpt ?? "").split("\n").length <= 30);
});

test("failures cap at 20 with truncatedFailures", () => {
  const stdout = [
    ...Array.from(
      { length: 25 },
      (_, i) => `src/f${i}.ts(${i + 1},1): error TS2304: Cannot find name 'x'.`,
    ),
    "Found 25 errors in 25 files.",
  ].join("\n");
  const d = buildOutputDigest({ command: "tsc", stdout, stderr: "", exitCode: 2 });
  assert.equal(d.failures.length, 20);
  assert.equal(d.truncatedFailures, 5);
  assert.equal(d.summary, "25 errors in 25 files");
});


test("node:test deduplicates the Node 24 failing-tests replay", () => {
  const stdout = [
    "TAP version 13",
    "✖ preserves durable file identity (12.34ms)",
    "  AssertionError [ERR_ASSERTION]: durable file identity changed",
    "✖ failing tests:",
    "not ok 1 - preserves durable file identity (12.34ms)",
    "ℹ tests 1",
    "ℹ pass 0",
    "ℹ fail 1",
  ].join("\n");

  const digest = buildOutputDigest({
    command: "node --test",
    stdout,
    stderr: "",
    exitCode: 1,
  });

  assert.equal(digest.failures.length, 1);
  assert.deepEqual(digest.failures[0], {
    name: "preserves durable file identity",
    message: "AssertionError [ERR_ASSERTION]: durable file identity changed",
  });
  assert.equal(digest.summary, "1/1 tests failed");
});

test("node:test keeps distinct failures in first-seen order", () => {
  const stdout = [
    "✖ first failure (1.1ms)",
    "  AssertionError: first assertion",
    "✖ second failure (2.2ms)",
    "  AssertionError: second assertion",
    "✖ failing tests",
    "not ok 1 - first failure (1.1ms)",
    "not ok 2 - second failure (2.2ms)",
    "ℹ tests 2",
    "ℹ fail 2",
  ].join("\n");

  const digest = buildOutputDigest({
    command: "node --test",
    stdout,
    stderr: "",
    exitCode: 1,
  });

  assert.deepEqual(
    digest.failures.map(({ name, message }) => ({ name, message })),
    [
      { name: "first failure", message: "AssertionError: first assertion" },
      { name: "second failure", message: "AssertionError: second assertion" },
    ],
  );
  assert.equal(digest.summary, "2/2 tests failed");
});