# Safe-glob Bracket Classes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the bounded bracket-class grammar from the design to repository ignore globs, with identical scanner and Chokidar behavior and no expansion into full POSIX glob syntax.

**Architecture:** Keep glob grammar ownership in src/util/safeRegex.ts. Replace the placeholder-and-global-replacement body of globToSafeRegex with two bounded stages: a deterministic class-protection prepass around the existing normalizePath helper, then a Unicode code-point-aware compiler that recognizes safe bracket classes before wildcard expansion. This preserves the caller's existing dot-segment, repeated-separator, and Windows normalization while keeping class escape markers intact. Scanner and watcher continue to use the shared compiler and stop normalizing patterns themselves.

**Tech Stack:** TypeScript, Node.js 24, node:test, node:assert/strict, SDL-MCP repository tooling, Chokidar ignored predicates.

---

## Chunk 1: Safe-glob Bracket Classes

Use @test-driven-development for every behavior change, @sdl-mcp-agent-workflow for indexed source inspection and edits, and @verification-before-completion before claiming the track complete.

### Scope and invariants

This plan implements only the grammar specified in docs/superpowers/specs/2026-07-09-backlog-resolution-design.md, section 2.

The track must preserve these boundaries:

- globToSafeRegex remains the only ignore-glob compiler.
- Scanner and watcher compile the same raw configured pattern and evaluate normalized repository-relative paths.
- A class candidate exists only when a later unescaped closing bracket exists.
- Escapes take precedence while searching for that closing bracket.
- Only closing bracket, hyphen, and backslash can be escaped inside a recognized class.
- Negation, POSIX named classes, collating symbols, equivalence classes, Unicode ranges, descending ranges, mixed-case ranges, and mixed-category ranges remain unsupported.
- An unmatched opening bracket and a stray closing bracket remain literal under ordinary glob rules.
- The existing greater-than-500-character and greater-than-five-double-star guard runs before bracket parsing and keeps its exact-literal fallback.
- Existing single-star, double-star, double-star-slash, anchoring, and trailing-directory behavior stays unchanged.
- Invalid recognized classes throw ConfigError. No new error type is added.
- No MCP response shape, persistence schema, benchmark threshold, or release surface changes in this track.

### File responsibility map

| File | Action | Single responsibility in this track |
| --- | --- | --- |
| src/util/safeRegex.ts | Modify | Own class recognition, validation, regex-class emission, separator normalization outside classes, and existing wildcard/safety behavior. |
| src/indexer/fileWalker.ts | Modify | Pass raw include and ignore patterns to globToSafeRegex; continue normalizing discovered repository paths before matching. |
| src/indexer/watcher.ts | Modify | Pass raw ignore patterns to globToSafeRegex; continue normalizing absolute and repository-relative Chokidar candidates before matching. |
| tests/unit/safeRegex.test.ts | Modify | Prove every accepted, rejected, escape-precedence, unmatched-candidate, metacharacter, and safety-limit compiler rule. |
| tests/unit/safe-glob-parity.test.ts | Create | Run one shared pattern/path table through scanRepository and the Chokidar ignored predicate, including Windows separators and invalid-pattern parity. |
| docs/configuration-reference.md | Modify | Document the exact bounded grammar, supported escapes, literal unmatched behavior, and explicitly unsupported POSIX forms. |

Read-only dependencies and regression evidence:

| Symbol or document | Current path and range | Why it matters |
| --- | --- | --- |
| ConfigError | src/domain/errors.ts:18-24 | Existing typed configuration error required by the design. |
| normalizePath | src/util/paths.ts:16-28 | Converts every backslash to a forward slash; callers must not apply it before class parsing. |
| discoverFiles | src/indexer/fileScanner.ts:193-225 | Copies config.ignore and delegates discovery to walkRepositoryFiles. |
| scanRepository | src/indexer/fileScanner.ts:346-361 | Public scanner surface used by the parity test. |
| Existing scanner glob coverage | tests/unit/file-scanner-glob-compat.test.ts | Protects current node_modules, dist, nested-directory, and file-pattern behavior. |
| Existing walker coverage | tests/unit/file-walker.test.ts | Protects directory pruning, path normalization, and wildcard-directory behavior. |
| Existing watcher ignore coverage | tests/unit/watcher-health.test.ts:279-330 | Uses _createChokidarIgnoredPredicateForTesting for absolute paths and wildcard-directory regression checks. |

Do not modify src/indexer/fileScanner.ts, tests/unit/file-scanner-glob-compat.test.ts, tests/unit/file-walker.test.ts, or tests/unit/watcher-health.test.ts. They are regression gates, not implementation targets.

### Current implementation evidence

The indexed source currently has these seams:

- globToSafeRegex in src/util/safeRegex.ts:97-174 rejects overly complex input by exact-literal fallback, protects ** and * with string placeholders, escapes every regex metacharacter globally, restores wildcard placeholders, and applies special trailing /** behavior.
- compilePatterns in src/indexer/fileWalker.ts:29-31 calls globToSafeRegex(normalizePath(pattern)).
- walkRepositoryFiles in src/indexer/fileWalker.ts:67-152 compiles include/ignore arrays once, normalizes each discovered relative path, checks directories both as path and path/, and prunes ignored directories.
- compileIgnorePatterns in src/indexer/watcher.ts:1021-1025 also calls globToSafeRegex(normalizePath(pattern)).
- shouldIgnorePath in src/indexer/watcher.ts:1031-1044 normalizes the candidate and checks a directory again with a trailing slash.
- toRepoRelativeWatchPath in src/indexer/watcher.ts:1046-1066 converts absolute or repository-relative Chokidar input to a normalized repository-relative path and rejects paths outside the root.
- _createChokidarIgnoredPredicateForTesting in src/indexer/watcher.ts:1090-1098 exposes the production Chokidar compilation and predicate path to tests.
- tests/unit/safeRegex.test.ts currently proves wildcard conversion, regex escaping, anchoring, and trailing-directory behavior, but has no bracket-class or complexity-boundary table.
- docs/configuration-reference.md:116-166 calls repos[].ignore values “glob patterns” and lists defaults, but does not define the supported grammar.

The pre-normalization in both callers is the important compatibility seam. A configured class escape such as [a\]] currently becomes [a/]] before globToSafeRegex sees it. The implementation must therefore move separator handling into the compiler rather than adding class parsing after normalizePath.

### Complete compiler grammar table

Transpose every row in these tables into tests/unit/safeRegex.test.ts. Do not remove a row because another row appears similar.

#### Accepted recognized classes

| TypeScript pattern value | Positive examples | Negative examples | Rule proved |
| --- | --- | --- | --- |
| "[Bb]in/" | "Bin/", "bin/" | "cin/", "BBin/" | Multiple literal members. |
| "**/[Bb]in/**" | "Bin/", "src/bin/file.ts" | "src/cin/file.ts", "src/Bin.ts" | Nested class plus wildcard-directory slash boundary. |
| "[a-c]ache/**" | "cache/", "bache/file.ts" | "dache/file.ts", "Cache/file.ts" | Ascending lowercase subrange. |
| "[A-C]ache/**" | "Cache/", "Bache/file.ts" | "cache/file.ts", "Dache/file.ts" | Ascending uppercase subrange. |
| "[0-3].ts" | "0.ts", "3.ts" | "4.ts", "a.ts" | Ascending digit subrange. |
| "[A-Za-z0-9_]" | "A", "z", "5", "_" | "-", "é", "/" | Multiple ranges and a literal. |
| "[a-cx-z]" | "a", "b", "y", "z" | "d", "w", "-" | Multiple ranges in one class. |
| "[éa]" | "é", "a" | "e", "É" | Non-ASCII BMP literal member. |
| "[😀a]" | "😀", "a" | "😃", "A" | Astral literal member; compiler and RegExp are Unicode-aware. |
| "[a\\]]" | "a", "]" | "[", "-" | Escaped closing bracket is a member; the next unescaped bracket closes. |
| "[a\\-c]" | "a", "-", "c" | "b", "]" | Escaped hyphen is literal and does not form a range. |
| "[a\\\\]" | "a", "\\" | "]", "/" | Escaped backslash is literal. |
| "[-ab]" | "-", "a", "b" | "c", "]" | Unescaped leading hyphen is literal. |
| "[ab-]" | "a", "b", "-" | "c", "]" | Unescaped trailing hyphen is literal. |
| "[--]" | "-" | "a", "]" | Both first and last hyphens are literal. |
| "[a-a]" | "a" | "b", "A" | Equal ASCII endpoints are non-descending and valid. |
| "[a^]" | "a", "^" | "b", "!" | Caret is literal when it is not the leading marker. |
| "[.*+?{}|$]" | ".", "*", "+", "?", "{", "}", "|", "$" | "a", "/" | Regex metacharacters remain literal class members. |

#### Rejected recognized classes

| TypeScript pattern value | Required ConfigError reason |
| --- | --- |
| "[]" | Class has no members. |
| "[!a]" | Leading ! negation is unsupported. |
| "[^a]" | Leading ^ negation is unsupported. |
| "[z-a]" | Lowercase range is reversed. |
| "[Z-A]" | Uppercase range is reversed. |
| "[9-0]" | Digit range is reversed. |
| "[A-z]" | Range crosses ASCII case categories. |
| "[0-a]" | Range crosses digit and letter categories. |
| "[é-a]" | Non-ASCII range start is unsupported. |
| "[a-é]" | Non-ASCII range end is unsupported. |
| "[[a]" | Nested unescaped opening bracket is unsupported. |
| "[a[b]" | Nested unescaped opening bracket is unsupported after a member. |
| "[a\\q]" | q is not an allowed class escape. |
| "[a\\/]" | Slash is not an allowed class escape. |
| "[a\\!]" | ! is not an allowed class escape. |
| "[a--c]" | Interior hyphen attempts a range with a hyphen endpoint. |
| "[[:alpha:]]" | POSIX named classes are unsupported. |
| "[[.ch.]]" | POSIX collating symbols are unsupported. |
| "[[=a=]]" | POSIX equivalence classes are unsupported. |

#### Unmatched candidates and escape precedence

| TypeScript pattern value | Expected behavior |
| --- | --- |
| "[abc" | No unescaped closing bracket exists; match the literal text [abc. |
| "[a\\]" | The closing bracket is escaped while searching, so no class exists; compile the opening bracket literally and treat the backslash under ordinary separator rules, matching [a/]. |
| "[abc\\" | The candidate ends with a dangling escape and no closing bracket; compile the opening bracket literally and normalize the trailing ordinary separator, matching [abc/. |
| "[[" | Neither opening bracket has a later closing bracket; both are literal. |
| "foo]bar" | The stray closing bracket is literal. |
| "]" | A standalone closing bracket is literal. |
| "[a\\]]" | The escaped first closing bracket is a member; the second unescaped closing bracket terminates a valid class. |

### Task 1: Add compiler contract tests and the bounded one-pass compiler

**Files:**

- Modify: tests/unit/safeRegex.test.ts
- Modify: src/util/safeRegex.ts
- Read for error contract: src/domain/errors.ts

- [ ] **Step 1: Add the accepted compiler table**

Add ConfigError to the test imports and encode every accepted row above. Keep the name in each case so failures identify the grammar rule.

~~~typescript
import { ConfigError } from "../../dist/domain/errors.js";
import { normalizePath } from "../../dist/util/paths.js";

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
    for (const value of testCase.matches) {
      assert.equal(regex.test(value), true, testCase.pattern + " should match " + value);
    }
    for (const value of testCase.misses) {
      assert.equal(regex.test(value), false, testCase.pattern + " should not match " + value);
    }
  });
}
~~~

- [ ] **Step 2: Add the rejected compiler table**

Encode every rejected row above and require ConfigError, not a native RegExp SyntaxError.

~~~typescript
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
~~~

- [ ] **Step 3: Add unmatched-candidate and escape-precedence tests**

Use the exact expectations below. These tests prevent a future parser from treating every opening bracket as a class or every closing bracket as a terminator.

~~~typescript
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
~~~

- [ ] **Step 4: Add safety-limit regression tests**

Lock the existing guard ahead of class validation. The two over-limit inputs must use exact-literal fallback rather than throw. The in-limit combined class must remain safe.

~~~typescript
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
~~~

Before relying on this green assertion, runtime-probe the exact planned wildcard fragment against the current detector:

~~~powershell
node --input-type=module -e "const { isReDoSRisk } = await import('./dist/util/safeRegex.js'); const source = '^(?:.*/|)[A-Za-z0-9_]/[a-c]ache(?:/.*|)$'; if (isReDoSRisk(source)) process.exit(1);"
~~~

Expected: exit 0. If it exits 1, stop and adjust the emitted safe fragment without weakening or bypassing `isReDoSRisk`.

- [ ] **Step 5: Run the compiler test to verify red**

Run:

~~~powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/unit/safeRegex.test.ts
~~~

Expected: the build succeeds, then the test command exits 1. Accepted class assertions fail because the current compiler escapes opening and closing brackets literally, and rejected rows report “Missing expected exception (ConfigError).” Existing wildcard tests still pass.

- [ ] **Step 6: Add code-point-safe tokens and class-end recognition**

In src/util/safeRegex.ts, import ConfigError from ../domain/errors.js before logger. Add these private helpers above globToSafeRegex. Keep them private because no second grammar owner is needed.

~~~typescript
import { ConfigError } from "../domain/errors.js";
import { logger } from "./logger.js";
import { normalizePath } from "./paths.js";

type SafeClassToken = {
  value: string;
  escaped: boolean;
};

type CompiledSafeClass = {
  source: string;
  nextIndex: number;
};

type AsciiRangeKind = "digit" | "upper" | "lower";

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
}

function escapeRegexClassMember(value: string): string {
  if (value === "\\" || value === "]" || value === "-" || value === "^") {
    return "\\" + value;
  }
  return value;
}

function findUnescapedClassEnd(glob: string, startIndex: number): number {
  let escaped = false;
  for (let index = startIndex + 1; index < glob.length; index++) {
    const value = glob[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (value === "\\") {
      escaped = true;
      continue;
    }
    if (value === "]") {
      return index;
    }
  }
  return -1;
}

function asciiRangeKind(value: string): AsciiRangeKind | null {
  const code = value.charCodeAt(0);
  if (value.length !== 1) return null;
  if (code >= 48 && code <= 57) return "digit";
  if (code >= 65 && code <= 90) return "upper";
  if (code >= 97 && code <= 122) return "lower";
  return null;
}

function invalidClass(glob: string, startIndex: number, reason: string): never {
  throw new ConfigError(
    "Invalid ignore glob bracket class at index " +
      startIndex +
      ' in "' +
      glob +
      '": ' +
      reason,
  );
}

~~~

- [ ] **Step 7: Add class validation, range compilation, and Unicode-safe emission**

Continue in the same module. Tokenize the class body with `Array.from(body)` so astral literals remain one member; only indices used to slice the original glob remain UTF-16 offsets. Emit validated literals and ranges without delegating ambiguous hyphens to RegExp.

~~~typescript
function compileSafeBracketClass(
  glob: string,
  startIndex: number,
): CompiledSafeClass | null {
  const endIndex = findUnescapedClassEnd(glob, startIndex);
  if (endIndex === -1) return null;

  const body = glob.slice(startIndex + 1, endIndex);
  if (body.length === 0) {
    invalidClass(glob, startIndex, "class has no members");
  }
  if (body[0] === "!" || body[0] === "^") {
    invalidClass(glob, startIndex, "class negation is unsupported");
  }

  const bodyCodePoints = Array.from(body);
  const tokens: SafeClassToken[] = [];
  for (let index = 0; index < bodyCodePoints.length; index++) {
    const value = bodyCodePoints[index]!;
    if (value === "[") {
      invalidClass(glob, startIndex, "nested opening bracket is unsupported");
    }
    if (value !== "\\") {
      tokens.push({ value, escaped: false });
      continue;
    }

    const escaped = bodyCodePoints[index + 1];
    if (escaped !== "]" && escaped !== "-" && escaped !== "\\") {
      invalidClass(
        glob,
        startIndex,
        "unsupported escape; only \\], \\-, and \\\\ are allowed",
      );
    }
    tokens.push({ value: escaped, escaped: true });
    index++;
  }

  const rangeEndpoints = new Set<number>();
  const pieces: string[] = [];
  for (let index = 1; index < tokens.length - 1; index++) {
    const token = tokens[index]!;
    if (token.value !== "-" || token.escaped) continue;

    const left = tokens[index - 1]!;
    const right = tokens[index + 1]!;
    const leftKind = asciiRangeKind(left.value);
    const rightKind = asciiRangeKind(right.value);
    if (leftKind === null || rightKind === null) {
      invalidClass(
        glob,
        startIndex,
        "range endpoints must be ASCII letters or digits",
      );
    }
    if (leftKind !== rightKind) {
      invalidClass(
        glob,
        startIndex,
        "range endpoints must use the same ASCII category and case",
      );
    }
    if (left.value.charCodeAt(0) > right.value.charCodeAt(0)) {
      invalidClass(glob, startIndex, "range is reversed");
    }

    pieces.push(left.value + "-" + right.value);
    rangeEndpoints.add(index - 1);
    rangeEndpoints.add(index + 1);
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.value === "-" && !token.escaped) {
      if (index === 0 || index === tokens.length - 1) {
        pieces.push("\\-");
      }
      continue;
    }
    if (!rangeEndpoints.has(index)) {
      pieces.push(escapeRegexClassMember(token.value));
    }
  }

  return {
    source: "[" + pieces.join("") + "]",
    nextIndex: endIndex + 1,
  };
}
~~~

The range pass deliberately emits validated ranges separately from unused literals. This keeps adjacent or multiple ranges valid without delegating ambiguous hyphen parsing to RegExp.

- [ ] **Step 8: Preserve normalizePath semantics, then replace wildcard placeholders with code-point-aware compilation**

Add a deterministic `normalizeGlobPreservingClasses` helper after `compileSafeBracketClass`. It scans only for candidate boundaries (no validation), replaces each recognized candidate with a collision-free private-use sentinel, calls the existing `normalizePath`, then restores the exact class substrings. This preserves `./`, repeated-separator, `..`, and Windows normalization without consuming class escapes. Call it only after the raw length/double-star safety guard has returned or accepted the input; no bracket recognition or path normalization may reduce an over-limit raw glob before the guard.

Then add `compileGlobBody`. It recognizes a class before looking for stars, so stars inside a class stay literal. It treats slash and backslash as path separators only outside recognized classes and advances ordinary literals by Unicode code-point width.

~~~typescript
function normalizeGlobPreservingClasses(glob: string): string {
  const classes: string[] = [];
  let sentinel = "\u{E000}";
  while (glob.includes(sentinel)) sentinel += "\u{E000}";
  let masked = "";

  for (let index = 0; index < glob.length; ) {
    if (glob[index] === "[") {
      const endIndex = findUnescapedClassEnd(glob, index);
      if (endIndex !== -1) {
        const marker = sentinel + classes.length + sentinel;
        classes.push(glob.slice(index, endIndex + 1));
        masked += marker;
        index = endIndex + 1;
        continue;
      }
    }
    const value = String.fromCodePoint(glob.codePointAt(index)!);
    masked += value;
    index += value.length;
  }

  let normalized = normalizePath(masked);
  for (let index = 0; index < classes.length; index++) {
    normalized = normalized.replaceAll(
      sentinel + index + sentinel,
      classes[index]!,
    );
  }
  return normalized;
}
~~~

~~~typescript
function compileGlobBody(glob: string): string {
  const source: string[] = [];
  let currentSegmentHasWildcard = false;

  for (let index = 0; index < glob.length; ) {
    const value = glob[index]!;

    if (value === "[") {
      const compiledClass = compileSafeBracketClass(glob, index);
      if (compiledClass !== null) {
        source.push(compiledClass.source);
        currentSegmentHasWildcard = true;
        index = compiledClass.nextIndex;
        continue;
      }
      source.push("\\[");
      index++;
      continue;
    }

    if (
      glob.startsWith("**/", index) ||
      glob.startsWith("**\\", index)
    ) {
      source.push("(?:.*/|)");
      currentSegmentHasWildcard = false;
      index += 3;
      continue;
    }

    if (
      (value === "/" || value === "\\") &&
      glob.startsWith("**", index + 1) &&
      index + 3 === glob.length
    ) {
      source.push(
        currentSegmentHasWildcard ? "(?:/.*)" : "(?:/.*|)",
      );
      index += 3;
      continue;
    }

    if (glob.startsWith("**", index)) {
      source.push(".*");
      currentSegmentHasWildcard = true;
      index += 2;
      continue;
    }

    if (value === "*") {
      source.push("[^/]*");
      currentSegmentHasWildcard = true;
      index++;
      continue;
    }

    if (value === "/" || value === "\\") {
      source.push("/");
      currentSegmentHasWildcard = false;
      index++;
      continue;
    }

    const codePoint = String.fromCodePoint(glob.codePointAt(index)!);
    source.push(escapeRegexLiteral(codePoint));
    index += codePoint.length;
  }

  return source.join("");
}
~~~

Replace only the body of globToSafeRegex. Keep the existing guard first and keep its warn message. Use separator-normalized exact-literal fallback so the moved caller normalization does not weaken the guard.

~~~typescript
export function globToSafeRegex(glob: string): RegExp {
  const doubleStarCount = (glob.match(/\*\*/g) || []).length;
  if (doubleStarCount > 5 || glob.length > 500) {
    logger.warn("Overly complex glob pattern rejected: " + glob);
    const normalizedLiteral = normalizePath(glob);
    return new RegExp(
      "^" + escapeRegexLiteral(normalizedLiteral) + "$",
      "u",
    );
  }

  const normalizedGlob = normalizeGlobPreservingClasses(glob);
  return new RegExp("^" + compileGlobBody(normalizedGlob) + "$", "u");
}
~~~

Do not add support for question-mark wildcards, braces, negation, POSIX named classes, or locale-aware ranges.

- [ ] **Step 9: Build and rerun the compiler test to verify green**

Run:

~~~powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/unit/safeRegex.test.ts
~~~

Expected: both commands exit 0. Every new accepted, rejected, unmatched, escape-precedence, and safety-limit case passes, along with all pre-existing wildcard and trailing-directory tests.

- [ ] **Step 10: Run the existing direct wildcard regressions**

Run:

~~~powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/file-walker.test.ts tests/unit/file-scanner-glob-compat.test.ts tests/unit/watcher-health.test.ts
~~~

Expected: exit 0. This proves the new one-pass compiler preserves existing scanner and watcher behavior before changing their pattern-compilation call sites.

- [ ] **Step 11: Commit the compiler slice**

~~~powershell
git diff --cached --name-only
git add src/util/safeRegex.ts tests/unit/safeRegex.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: add bounded safe-glob bracket classes"
~~~

Expected: the first staged-file listing is empty, `git diff --cached --check` prints nothing, the second listing contains only the compiler and compiler-test files, and the commit succeeds. Stop on unrelated staged paths.

## Chunk 2: Scanner and Watcher Parity

### Task 2: Prove scanner and watcher parity and preserve escapes at both call sites

**Files:**

- Create: tests/unit/safe-glob-parity.test.ts
- Modify: src/indexer/fileWalker.ts
- Modify: src/indexer/watcher.ts
- Regression test: tests/unit/file-scanner-glob-compat.test.ts
- Regression test: tests/unit/file-walker.test.ts
- Regression test: tests/unit/watcher-health.test.ts

- [ ] **Step 1: Create parity imports and types**

Create tests/unit/safe-glob-parity.test.ts with the imports and `ParityCase` type shown below. Keep fixture creation under `tmpdir()` and leave table data and lifecycle helpers to the next two atomic steps.

~~~typescript
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import type { RepoConfig } from "../../dist/config/types.js";
import { ConfigError } from "../../dist/domain/errors.js";
import { scanRepository } from "../../dist/indexer/fileScanner.js";
import { _createChokidarIgnoredPredicateForTesting } from "../../dist/indexer/watcher.js";

type ParityCase = {
  name: string;
  pattern: string;
  candidatePath: string;
  isDirectory: boolean;
  ignored: boolean;
};

~~~

- [ ] **Step 2: Add the shared accepted and invalid parity tables**

Both scanner and watcher assertions must iterate these exact same arrays. Include directory, file, raw-Windows-pattern, and path-normalization boundaries.

~~~typescript
const PARITY_CASES: readonly ParityCase[] = [
  { name: "root literal class", pattern: "[Bb]in/", candidatePath: "Bin", isDirectory: true, ignored: true },
  { name: "root literal class miss", pattern: "[Bb]in/", candidatePath: "cin", isDirectory: true, ignored: false },
  { name: "nested literal class", pattern: "**/[Bb]in/**", candidatePath: "packages/bin", isDirectory: true, ignored: true },
  { name: "lowercase range", pattern: "[a-c]ache/**", candidatePath: "cache", isDirectory: true, ignored: true },
  { name: "combined ranges", pattern: "[A-Za-z0-9_]/**", candidatePath: "_", isDirectory: true, ignored: true },
  { name: "escaped closing bracket", pattern: "**/[a\\]]/**", candidatePath: "packages/]", isDirectory: true, ignored: true },
  { name: "escaped hyphen", pattern: "**/[a\\-c]/**", candidatePath: "packages/-", isDirectory: true, ignored: true },
  { name: "leading literal hyphen", pattern: "**/[-ab]/**", candidatePath: "packages/-", isDirectory: true, ignored: true },
  { name: "trailing literal hyphen", pattern: "**/[ab-]/**", candidatePath: "packages/-", isDirectory: true, ignored: true },
  { name: "non-ASCII literal", pattern: "**/[éa]/**", candidatePath: "packages/é", isDirectory: true, ignored: true },
  { name: "unmatched opening bracket", pattern: "[abc/**", candidatePath: "[abc", isDirectory: true, ignored: true },
  { name: "stray closing bracket", pattern: "]/**", candidatePath: "]", isDirectory: true, ignored: true },
  { name: "digit class file", pattern: "[0-3].ts", candidatePath: "2.ts", isDirectory: false, ignored: true },
  { name: "digit class file miss", pattern: "[0-3].ts", candidatePath: "4.ts", isDirectory: false, ignored: false },
  { name: "raw Windows pattern", pattern: "**\\[Bb]in\\**", candidatePath: "packages/Bin", isDirectory: true, ignored: true },
  { name: "dot and repeated separators", pattern: "./tmp/../[Bb]in//**", candidatePath: "Bin", isDirectory: true, ignored: true },
  { name: "parent segment normalization", pattern: "cache/../[Bb]in/**", candidatePath: "Bin", isDirectory: true, ignored: true },
];

const INVALID_PARITY_PATTERNS = [
  "[]/**",
  "[!a]/**",
  "[^a]/**",
  "[z-a]/**",
  "[A-z]/**",
  "[0-a]/**",
  "[é-a]/**",
  "[[a]/**",
  "[a\\q]/**",
  String.raw`**\[a\q]\**`,
] as const;

~~~

- [ ] **Step 3: Add deterministic repository lifecycle helpers**

Add the temporary-directory registry, repo config, stats adapter, and materialization helper separately from the case data.

~~~typescript
const tempDirectories: string[] = [];

function makeTempRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "sdl-safe-glob-"));
  tempDirectories.push(repoRoot);
  return repoRoot;
}

function repoConfig(repoRoot: string, pattern: string): RepoConfig {
  return {
    repoId: "safe-glob-parity",
    rootPath: repoRoot,
    ignore: [pattern],
    languages: ["ts"],
    maxFileBytes: 1_000_000,
    includeNodeModulesTypes: false,
    packageJsonPath: null,
    tsconfigPath: null,
    workspaceGlobs: null,
  };
}

function statsLike(isDirectory: boolean): { isDirectory(): boolean } {
  return { isDirectory: () => isDirectory };
}

function materializeCandidate(
  repoRoot: string,
  testCase: ParityCase,
): string {
  const relativeFile = testCase.isDirectory
    ? testCase.candidatePath + "/target.ts"
    : testCase.candidatePath;
  const absoluteFile = join(repoRoot, ...relativeFile.split("/"));
  mkdirSync(dirname(absoluteFile), { recursive: true });
  writeFileSync(absoluteFile, "export const target = true;\n", "utf8");
  return relativeFile;
}

after(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});
~~~

- [ ] **Step 4: Add scanner and watcher assertions over the same accepted table**

Use a real scanRepository call. For the watcher, evaluate both a platform-native absolute path and a repository-relative path containing Windows backslashes.

~~~typescript
describe("safe glob scanner and watcher parity", () => {
  for (const testCase of PARITY_CASES) {
    it(testCase.name, async () => {
      const repoRoot = makeTempRepo();
      const relativeFile = materializeCandidate(repoRoot, testCase);
      writeFileSync(
        join(repoRoot, "keep.ts"),
        "export const keep = true;\n",
        "utf8",
      );

      const scanned = await scanRepository(
        repoRoot,
        repoConfig(repoRoot, testCase.pattern),
      );
      const scannedPaths = scanned.map((file) => file.path);
      assert.equal(scannedPaths.includes("keep.ts"), true);
      assert.equal(
        scannedPaths.includes(relativeFile),
        !testCase.ignored,
        "scanner mismatch for " + testCase.pattern,
      );

      const ignored = _createChokidarIgnoredPredicateForTesting(
        resolve(repoRoot),
        [testCase.pattern],
      );
      const absoluteCandidate = join(
        repoRoot,
        ...testCase.candidatePath.split("/"),
      );
      const windowsRelativeCandidate =
        testCase.candidatePath.replaceAll("/", "\\");

      assert.equal(
        ignored(absoluteCandidate, statsLike(testCase.isDirectory)),
        testCase.ignored,
        "absolute watcher mismatch for " + testCase.pattern,
      );
      assert.equal(
        ignored(
          windowsRelativeCandidate,
          statsLike(testCase.isDirectory),
        ),
        testCase.ignored,
        "Windows-relative watcher mismatch for " + testCase.pattern,
      );
    });
  }
});
~~~

- [ ] **Step 5: Add invalid-pattern assertions over both surfaces**

The scanner rejects asynchronously; Chokidar predicate construction rejects synchronously. Require ConfigError from both.

~~~typescript
describe("invalid safe glob parity", () => {
  for (const pattern of INVALID_PARITY_PATTERNS) {
    it("rejects " + pattern + " in scanner and watcher compilation", async () => {
      const repoRoot = makeTempRepo();
      writeFileSync(
        join(repoRoot, "keep.ts"),
        "export const keep = true;\n",
        "utf8",
      );

      assert.throws(
        () =>
          _createChokidarIgnoredPredicateForTesting(repoRoot, [pattern]),
        ConfigError,
      );
      await assert.rejects(
        () => scanRepository(repoRoot, repoConfig(repoRoot, pattern)),
        ConfigError,
      );
    });
  }
});
~~~

- [ ] **Step 6: Run the parity test to verify red**

Run:

~~~powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/unit/safe-glob-parity.test.ts
~~~

Expected: the build succeeds, then the test command exits 1. In the accepted table, the escaped-closing-bracket scanner assertion fails before that case reaches watcher assertions; the escaped-hyphen scanner call pre-normalizes to `[a/-c]` and rejects during construction. In the invalid table, watcher predicate construction for the normalized invalid-escape pattern does not throw, so its `assert.throws` fails before the scanner call. Raw Windows-pattern and `./`/repeated-separator/`..` compatibility rows already pass and are not part of the expected red boundary.

- [ ] **Step 7: Stop pre-normalizing file-walker patterns**

Change only compilePatterns in src/indexer/fileWalker.ts. Keep normalizePath imported because walkRepositoryFiles still normalizes discovered paths.

~~~typescript
function compilePatterns(patterns: string[]): RegExp[] {
  // Preserve class escape markers; the shared compiler normalizes separators
  // only outside recognized bracket classes.
  return patterns.map((pattern) => globToSafeRegex(pattern));
}
~~~

- [ ] **Step 8: Stop pre-normalizing watcher patterns**

Change only compileIgnorePatterns in src/indexer/watcher.ts. Keep normalizePath imported because shouldIgnorePath and toRepoRelativeWatchPath still normalize candidate paths.

~~~typescript
function compileIgnorePatterns(
  ignorePatterns: readonly string[],
): RegExp[] {
  // Keep scanner and watcher on the same raw-pattern compilation path.
  return ignorePatterns.map((pattern) => globToSafeRegex(pattern));
}
~~~

- [ ] **Step 9: Build and rerun the parity test to verify green**

Run:

~~~powershell
npm run build
node --experimental-strip-types --test-concurrency=1 --test tests/unit/safe-glob-parity.test.ts
~~~

Expected: exit 0. Every accepted and invalid row produces the same result through scanRepository, absolute Chokidar input, and Windows-separator repository-relative Chokidar input.

- [ ] **Step 10: Run all focused scanner/watcher/compiler tests**

Run:

~~~powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/safeRegex.test.ts tests/unit/safe-glob-parity.test.ts tests/unit/file-walker.test.ts tests/unit/file-scanner-glob-compat.test.ts tests/unit/watcher-health.test.ts
~~~

Expected: exit 0. No current node_modules, dist, wildcard-directory, traversal, or watcher-health regression fails.

- [ ] **Step 11: Commit the parity slice**

~~~powershell
git diff --cached --name-only
git add src/indexer/fileWalker.ts src/indexer/watcher.ts tests/unit/safe-glob-parity.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "test: prove safe-glob scan watch parity"
~~~

Expected: the first staged-file listing is empty, `git diff --cached --check` prints nothing, and the second listing contains only the two raw-pattern call-site changes and the new parity test. Stop on unrelated staged paths.

## Chunk 3: Documentation and Verification

### Task 3: Document the bounded grammar

**Files:**

- Modify: docs/configuration-reference.md

- [ ] **Step 1: Add the grammar immediately after the default ignore list**

Add this text after the JSON array ending at the current line 166.

~~~markdown
Safe ignore globs use `/` as the documented separator. SDL also normalizes
Windows path separators outside bracket classes. The supported metacharacters
are `*`, `**`, `**/`, and bounded bracket classes.

A bracket class supports literal members (including astral Unicode code points), and
ascending ASCII ranges within one category: lowercase letters, uppercase
letters, or digits. Examples include `[Bb]in/`, `[a-c]ache/**`, and
`[A-Za-z0-9_]`. Inside a recognized class, `\]`, `\-`, and `\\` represent a
literal closing bracket, hyphen, and backslash. An unescaped hyphen is literal
only in the first or last position.

SDL rejects empty classes, leading `!` or `^` negation, reversed ranges,
cross-case or cross-category ranges, non-ASCII range endpoints, nested opening
brackets, and other escapes with a configuration error. SDL does not implement
POSIX named classes, collating symbols, equivalence classes, or brace
expansion. When no unescaped closing bracket exists, the opening bracket stays
literal; a closing bracket outside a recognized class is also literal.
~~~

- [ ] **Step 2: Review the documentation against the compiler tables**

Check the text sentence by sentence. Expected: every accepted or rejected category in the design appears exactly once, the three allowed escapes are explicit, unmatched candidates are explicit, and the document does not imply full POSIX compatibility.

- [ ] **Step 3: Run documentation checks**

Run:

~~~powershell
npm run docs:tools:check
~~~

Expected: exit 0 and no tracked file is rewritten. This script already runs the workflow-document check.

- [ ] **Step 4: Commit the documentation slice**

~~~powershell
git diff --cached --name-only
git add docs/configuration-reference.md
git diff --cached --check
git diff --cached --name-only
git commit -m "docs: define bounded safe-glob grammar"
~~~

Expected: the first staged-file listing is empty, `git diff --cached --check` prints nothing, the second listing contains only the configuration reference, and the commit succeeds.

### Task 4: Complete focused and shared verification

**Files:**

- Verify: src/util/safeRegex.ts
- Verify: src/indexer/fileWalker.ts
- Verify: src/indexer/watcher.ts
- Verify: tests/unit/safeRegex.test.ts
- Verify: tests/unit/safe-glob-parity.test.ts
- Verify: docs/configuration-reference.md

- [ ] **Step 1: Build the production output**

Run:

~~~powershell
npm run build
~~~

Expected: exit 0 with no TypeScript emit errors.

- [ ] **Step 2: Run type checking**

Run:

~~~powershell
npm run typecheck
~~~

Expected: exit 0 with no diagnostics.

- [ ] **Step 3: Run the focused compiler/scanner/watcher gate**

Run:

~~~powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/safeRegex.test.ts tests/unit/safe-glob-parity.test.ts tests/unit/file-walker.test.ts tests/unit/file-scanner-glob-compat.test.ts tests/unit/watcher-health.test.ts
~~~

Expected: exit 0 and every named test file passes.

- [ ] **Step 4: Run lint**

Run:

~~~powershell
npm run lint
~~~

Expected: exit 0 with zero ESLint errors.

- [ ] **Step 5: Consume the documentation acceptance evidence**

Reuse the persisted green documentation-check handle from Task 3 Step 3 and confirm no tracked documentation changed afterward. Do not rerun the same gate in this track; if docs changed, return to Task 3 and produce a fresh handle.

- [ ] **Step 6: Run prompt-cache golden validation**

Run:

~~~powershell
npm run test:golden
~~~

Expected: exit 0. No golden or determinism fixture changes are required because this track changes no MCP tool name, schema, ordering, or response payload.

- [ ] **Step 7: Run the full repository test gate**

Run:

~~~powershell
npm test
~~~

Expected: exit 0. Treat any failure as blocking even when the focused files pass.

- [ ] **Step 8: Check scoped worktree cleanliness**

Run:

~~~powershell
git status --short -- src/util/safeRegex.ts src/indexer/fileWalker.ts src/indexer/watcher.ts tests/unit/safeRegex.test.ts tests/unit/safe-glob-parity.test.ts docs/configuration-reference.md
~~~

Expected: no output after the three scoped commits. Remove only task-created temporary databases, fixture directories, or edit backups; do not clean unrelated user files.

- [ ] **Step 9: Record the track result for batch integration**

Write the track handoff into the authoritative ignored `BACKLOG.md` in the root workspace under the safe-glob item, then read it back through `sdl.file.read`. Record each exact command, exit status, persisted runtime artifact handle, and—on failure—the next action. The implementation worktree sends this four-field handoff to the root-workspace owner because the ignored backlog file does not travel with commits. Mirror the same four fields in the final response; do not claim batch completion from the focused gate alone.

The batch integration owner, not this isolated track, runs the bounded external benchmark smoke and final BACKLOG.md reconciliation required by the shared design. This track produces no benchmark input, does not change thresholds, and must not invent or modify a benchmark target merely to satisfy that batch-level gate.
