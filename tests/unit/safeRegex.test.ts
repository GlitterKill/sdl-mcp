import { test } from "node:test";
import assert from "node:assert";
import {
  safeCompileRegex,
  globToSafeRegex,
  isReDoSRisk,
} from "../../dist/util/safeRegex.js";
import { ConfigError } from "../../dist/domain/errors.js";
import { normalizePath } from "../../dist/util/paths.js";

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

test("globToSafeRegex trailing /** matches directory itself", () => {
  const regex = globToSafeRegex("**/node_modules/**");
  // Must match directory name without trailing content
  assert.strictEqual(regex.test("node_modules"), true);
  // Must match files inside directory
  assert.strictEqual(regex.test("node_modules/foo"), true);
  // Must match nested directories
  assert.strictEqual(regex.test("src/node_modules"), true);
  assert.strictEqual(regex.test("src/node_modules/bar"), true);
});

test("globToSafeRegex trailing /** with dist pattern", () => {
  const regex = globToSafeRegex("**/dist/**");
  assert.strictEqual(regex.test("dist"), true);
  assert.strictEqual(regex.test("dist/index.js"), true);
  assert.strictEqual(regex.test("packages/dist/foo.js"), true);
});

test("globToSafeRegex wildcard directory globs do not match same-prefix files", () => {
  const regex = globToSafeRegex("**/dist-*/**");
  assert.strictEqual(regex.test("tests/unit/dist-stdio-smoke.test.ts"), false);
  assert.strictEqual(regex.test("tests/stress/infra/dist-runtime.ts"), false);
  assert.strictEqual(regex.test("dist-tests/"), true);
  assert.strictEqual(regex.test("dist-tests/generated.test.ts"), true);
  assert.strictEqual(regex.test("packages/dist-tests/generated.test.ts"), true);
});

type AcceptedGlobCase = {
  name: string;
  pattern: string;
  matches: string[];
  misses: string[];
};

const ACCEPTED_CLASS_CASES: readonly AcceptedGlobCase[] = [
  { name: "literal members", pattern: "[Bb]in/", matches: ["Bin/", "bin/"], misses: ["cin/", "BBin/"] },
  { name: "nested class directory", pattern: "**/[Bb]in/**", matches: ["Bin/", "src/bin/file.ts"], misses: ["src/cin/file.ts", "src/Bin.ts"] },
  { name: "lowercase range", pattern: "[a-c]ache/**", matches: ["cache/", "bache/file.ts"], misses: ["dache/file.ts", "Cache/file.ts"] },
  { name: "uppercase range", pattern: "[A-C]ache/**", matches: ["Cache/", "Bache/file.ts"], misses: ["cache/file.ts", "Dache/file.ts"] },
  { name: "digit range", pattern: "[0-3].ts", matches: ["0.ts", "3.ts"], misses: ["4.ts", "a.ts"] },
  { name: "combined ranges", pattern: "[A-Za-z0-9_]", matches: ["A", "z", "5", "_"], misses: ["-", "é", "/"] },
  { name: "multiple ranges", pattern: "[a-cx-z]", matches: ["a", "b", "y", "z"], misses: ["d", "w", "-"] },
  { name: "non-ASCII BMP literal", pattern: "[éa]", matches: ["é", "a"], misses: ["e", "É"] },
  { name: "astral literal", pattern: "[😀a]", matches: ["😀", "a"], misses: ["😃", "A"] },
  { name: "escaped closing bracket", pattern: "[a\\]]", matches: ["a", "]"], misses: ["[", "-"] },
  { name: "escaped hyphen", pattern: "[a\\-c]", matches: ["a", "-", "c"], misses: ["b", "]"] },
  { name: "escaped backslash", pattern: "[a\\\\]", matches: ["a", "\\"], misses: ["]", "/"] },
  { name: "leading literal hyphen", pattern: "[-ab]", matches: ["-", "a", "b"], misses: ["c", "]"] },
  { name: "trailing literal hyphen", pattern: "[ab-]", matches: ["a", "b", "-"], misses: ["c", "]"] },
  { name: "first and last hyphens", pattern: "[--]", matches: ["-"], misses: ["a", "]"] },
  { name: "equal range endpoints", pattern: "[a-a]", matches: ["a"], misses: ["b", "A"] },
  { name: "non-leading caret", pattern: "[a^]", matches: ["a", "^"], misses: ["b", "!"] },
  { name: "regex metacharacter literals", pattern: "[.*+?{}|$]", matches: [".", "*", "+", "?", "{", "}", "|", "$"], misses: ["a", "/"] },
];

for (const testCase of ACCEPTED_CLASS_CASES) {
  test("globToSafeRegex accepts " + testCase.name, () => {
    const regex = globToSafeRegex(testCase.pattern);
    assert.equal(regex.flags.includes("u"), true);
    for (const value of testCase.matches) {
      assert.equal(regex.test(value), true, testCase.pattern + " should match " + value);
    }
    for (const value of testCase.misses) {
      assert.equal(regex.test(value), false, testCase.pattern + " should not match " + value);
    }
  });
}

const REJECTED_CLASS_CASES = [
  { pattern: "[]", reason: /no members/i },
  { pattern: "[!a]", reason: /negation/i },
  { pattern: "[^a]", reason: /negation/i },
  { pattern: "[z-a]", reason: /reversed/i },
  { pattern: "[Z-A]", reason: /reversed/i },
  { pattern: "[9-0]", reason: /reversed/i },
  { pattern: "[A-z]", reason: /same ASCII category/i },
  { pattern: "[0-a]", reason: /same ASCII category/i },
  { pattern: "[é-a]", reason: /ASCII letters or digits/i },
  { pattern: "[a-é]", reason: /ASCII letters or digits/i },
  { pattern: "[[a]", reason: /nested opening bracket/i },
  { pattern: "[a[b]", reason: /nested opening bracket/i },
  { pattern: "[a\\q]", reason: /unsupported escape/i },
  { pattern: "[a\\/]", reason: /unsupported escape/i },
  { pattern: "[a\\!]", reason: /unsupported escape/i },
  { pattern: "[a--c]", reason: /ASCII letters or digits/i },
  { pattern: "[a-b-c]", reason: /range endpoints cannot be reused/i },
  { pattern: "[0-2-4]", reason: /range endpoints cannot be reused/i },
  { pattern: "[[:alpha:]]", reason: /POSIX|nested opening bracket/i },
  { pattern: "[[.ch.]]", reason: /POSIX|nested opening bracket/i },
  { pattern: "[[=a=]]", reason: /POSIX|nested opening bracket/i },
] as const;

for (const testCase of REJECTED_CLASS_CASES) {
  test("globToSafeRegex rejects " + testCase.pattern, () => {
    assert.throws(
      () => globToSafeRegex(testCase.pattern),
      (error: unknown) =>
        error instanceof ConfigError && testCase.reason.test(error.message),
    );
  });
}

const UNMATCHED_CLASS_CASES = [
  { pattern: "[abc", matches: "[abc" },
  { pattern: "[a\\]", matches: "[a/]" },
  { pattern: "[abc\\", matches: "[abc/" },
  { pattern: "[[", matches: "[[" },
  { pattern: "foo]bar", matches: "foo]bar" },
  { pattern: "]", matches: "]" },
] as const;

for (const testCase of UNMATCHED_CLASS_CASES) {
  test("globToSafeRegex keeps unmatched syntax literal: " + testCase.pattern, () => {
    const regex = globToSafeRegex(testCase.pattern);
    assert.equal(regex.test(testCase.matches), true);
  });
}

test("globToSafeRegex gives escapes precedence while finding the class close", () => {
  const regex = globToSafeRegex("[a\\]]");
  assert.equal(regex.test("a"), true);
  assert.equal(regex.test("]"), true);
  assert.equal(regex.test("[a/]"), false);
});

test("globToSafeRegex keeps question marks and braces literal outside classes", () => {
  assert.equal(globToSafeRegex("file?.ts").test("file?.ts"), true);
  assert.equal(globToSafeRegex("file?.ts").test("file1.ts"), false);
  assert.equal(globToSafeRegex("{a,b}.ts").test("{a,b}.ts"), true);
  assert.equal(globToSafeRegex("{a,b}.ts").test("a.ts"), false);
});

test("globToSafeRegex parses an exactly 500-character pattern", () => {
  const glob = "a".repeat(496) + "[!a]";
  assert.equal(glob.length, 500);
  assert.throws(() => globToSafeRegex(glob), ConfigError);
});

test("globToSafeRegex falls back at exactly 501 characters before class validation", () => {
  const glob = "a".repeat(497) + "[!a]";
  assert.equal(glob.length, 501);
  const regex = globToSafeRegex(glob);
  assert.equal(regex.test(glob), true);
  assert.equal(regex.test("a".repeat(497) + "a"), false);
});

test("globToSafeRegex parses exactly five double stars", () => {
  const glob = "**/".repeat(5) + "[!a]";
  assert.equal((glob.match(/\*\*/g) ?? []).length, 5);
  assert.throws(() => globToSafeRegex(glob), ConfigError);
});

test("globToSafeRegex falls back at six double stars before class validation", () => {
  const glob = "**/".repeat(6) + "[!a]";
  assert.equal((glob.match(/\*\*/g) ?? []).length, 6);
  const regex = globToSafeRegex(glob);
  assert.equal(regex.test(glob), true);
  assert.equal(regex.test("a/b/c"), false);
});

test("globToSafeRegex guards raw length before dot-segment normalization", () => {
  const inLimit = "./".repeat(248) + "[!a]";
  assert.equal(inLimit.length, 500);
  assert.throws(() => globToSafeRegex(inLimit), ConfigError);

  const overLimit = "x" + inLimit;
  assert.equal(overLimit.length, 501);
  const regex = globToSafeRegex(overLimit);
  assert.equal(regex.test(normalizePath(overLimit)), true);
});

test("globToSafeRegex guards raw double stars before parent normalization", () => {
  const inLimit = "**/../".repeat(5) + "[!a]";
  assert.equal((inLimit.match(/\*\*/g) ?? []).length, 5);
  assert.throws(() => globToSafeRegex(inLimit), ConfigError);

  const overLimit = "**/../".repeat(6) + "[!a]";
  assert.equal((overLimit.match(/\*\*/g) ?? []).length, 6);
  const regex = globToSafeRegex(overLimit);
  assert.equal(regex.test(normalizePath(overLimit)), true);
});

test("globToSafeRegex emits a safe regex for combined bracket ranges", () => {
  const regex = globToSafeRegex("**/[A-Za-z0-9_]/[a-c]ache/**");
  assert.equal(isReDoSRisk(regex.source), false);
});
