import { test } from "node:test";
import assert from "node:assert";
import {
  safeCompileRegex,
  globToSafeRegex,
  isReDoSRisk,
} from "../../src/util/safeRegex.js";

test("isReDoSRisk detects nested quantifiers (a+)+", () => {
  assert.strictEqual(isReDoSRisk("(a+)+"), true);
});

test("isReDoSRisk detects nested quantifiers (a*)*", () => {
  assert.strictEqual(isReDoSRisk("(a*)*"), true);
});

test("isReDoSRisk detects nested quantifiers (a+)*", () => {
  assert.strictEqual(isReDoSRisk("(a+)*"), true);
});

test("isReDoSRisk detects overlapping alternation (a|a)*", () => {
  assert.strictEqual(isReDoSRisk("(a|a)*"), true);
});

test("isReDoSRisk returns false for safe patterns", () => {
  assert.strictEqual(isReDoSRisk("^foo.*bar$"), false);
});

test("safeCompileRegex rejects ReDoS patterns and returns null", () => {
  const result = safeCompileRegex("(a+)+b");
  assert.strictEqual(result, null);
});

test("safeCompileRegex accepts safe patterns and returns RegExp", () => {
  const result = safeCompileRegex("^foo.*bar$");
  assert(result instanceof RegExp);
  assert.strictEqual(result.test("fooXYZbar"), true);
  assert.strictEqual(result.test("foo"), false);
});

test("safeCompileRegex returns null for invalid regex syntax", () => {
  const result = safeCompileRegex("[invalid");
  assert.strictEqual(result, null);
});

test("safeCompileRegex respects flags parameter", () => {
  const result = safeCompileRegex("hello", "i");
  assert(result instanceof RegExp);
  assert.strictEqual(result.test("HELLO"), true);
});

test("globToSafeRegex converts single-segment glob src/*.ts", () => {
  const regex = globToSafeRegex("src/*.ts");
  assert.strictEqual(regex.test("src/foo.ts"), true);
  assert.strictEqual(regex.test("src/sub/foo.ts"), false);
});

test("globToSafeRegex converts multi-segment glob src/**/*.ts", () => {
  const regex = globToSafeRegex("src/**/*.ts");
  assert.strictEqual(regex.test("src/foo.ts"), true);
  assert.strictEqual(regex.test("src/sub/foo.ts"), true);
  assert.strictEqual(regex.test("src/a/b/c/foo.ts"), true);
});

test("globToSafeRegex escapes metacharacters in glob pattern", () => {
  const regex = globToSafeRegex("src/foo.bar/*.ts");
  assert.strictEqual(regex.test("src/foo.bar/test.ts"), true);
  assert.strictEqual(regex.test("src/fooXbar/test.ts"), false);
});

test("globToSafeRegex handles glob with multiple wildcards", () => {
  const regex = globToSafeRegex("src/**/test/*.ts");
  assert.strictEqual(regex.test("src/test/foo.ts"), true);
  assert.strictEqual(regex.test("src/a/b/test/foo.ts"), true);
  assert.strictEqual(regex.test("src/a/b/test/c/foo.ts"), false);
});

test("globToSafeRegex anchors pattern with ^ and $", () => {
  const regex = globToSafeRegex("*.ts");
  assert.strictEqual(regex.test("foo.ts"), true);
  assert.strictEqual(regex.test("dir/foo.ts"), false);
  assert.strictEqual(regex.test("foo.ts.bak"), false);
});
