/**
 * Parity tests: verify that the Rust native indexer produces identical
 * results to the TypeScript indexer for hashing, fingerprints, and symbol IDs.
 *
 * Run with: npm run test:native-parity
 */

import { hashContent, generateSymbolId } from "../../src/util/hashing.js";
import {
  isRustEngineAvailable,
  hashContentRust,
  generateSymbolIdRust,
} from "../../src/indexer/rustIndexer.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

function assertEqual(actual: string | null, expected: string, label: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL: ${label}\n  expected: ${expected}\n  actual:   ${actual}`,
    );
  }
}

// --- Hash parity test vectors ---
const HASH_VECTORS: Array<{ input: string; label: string }> = [
  { input: "", label: "empty string" },
  { input: "hello world", label: "hello world" },
  { input: "const x = 1;", label: "simple JS statement" },
  { input: "function foo() { return 42; }", label: "function declaration" },
  { input: "export default class Foo {}", label: "class export" },
  { input: "import { bar } from './baz.js';", label: "import statement" },
  { input: "\n\n\n", label: "newlines only" },
  { input: "\t\t", label: "tabs" },
  { input: "const emoji = '🎉🚀🔥';", label: "emoji string" },
  { input: "const jp = 'こんにちは世界';", label: "Japanese characters" },
  { input: "a".repeat(10000), label: "10K repeated chars" },
  {
    input: `
    export interface Config {
      host: string;
      port: number;
      debug?: boolean;
    }
    `,
    label: "multiline interface",
  },
  { input: "// comment\n/* block */", label: "comments" },
  { input: "x = y === null || y === undefined", label: "null checks" },
  {
    input: 'process.env.NODE_ENV === "production"',
    label: "environment check",
  },
  { input: "async function* gen() { yield 1; }", label: "async generator" },
  {
    input: "const [a, ...rest] = [1, 2, 3];",
    label: "destructuring with rest",
  },
  { input: "type X = string | number | null;", label: "union type" },
  { input: "<T extends Record<string, unknown>>", label: "generic constraint" },
  {
    input: "declare module 'foo' { export function bar(): void; }",
    label: "ambient module",
  },
  // Edge cases
  { input: "\0", label: "null byte" },
  { input: "\r\n", label: "CRLF" },
  { input: "\u{FEFF}", label: "BOM character" },
  {
    input: String.fromCharCode(0xd800),
    label: "lone surrogate (invalid UTF-16)",
  },
  { input: "a\x00b\x00c", label: "embedded nulls" },
];

// --- Symbol ID parity test vectors ---
const SYMBOL_ID_VECTORS = [
  {
    repoId: "test-repo",
    relPath: "src/main.ts",
    kind: "function",
    name: "hello",
    fingerprint: "abc123",
    label: "basic function",
  },
  {
    repoId: "sdl-mcp",
    relPath: "src/indexer/indexer.ts",
    kind: "class",
    name: "IndexerService",
    fingerprint: "deadbeef01234567890abcdef",
    label: "class in nested path",
  },
  {
    repoId: "my-app",
    relPath: "src/utils/helpers.ts",
    kind: "variable",
    name: "DEFAULT_CONFIG",
    fingerprint: "e3b0c44298fc1c149afbf4c8996fb924",
    label: "constant variable",
  },
  {
    repoId: "",
    relPath: "",
    kind: "",
    name: "",
    fingerprint: "",
    label: "all empty strings",
  },
  {
    repoId: "repo:with:colons",
    relPath: "src/foo.ts",
    kind: "method",
    name: "doStuff",
    fingerprint: "fff",
    label: "colons in repo ID",
  },
  {
    repoId: "unicode-repo-🚀",
    relPath: "src/日本語.ts",
    kind: "function",
    name: "処理",
    fingerprint: "abc",
    label: "unicode in all fields",
  },
];

async function main(): Promise<void> {
  console.log("=== SDL-MCP Native Parity Tests ===\n");

  // Check availability
  const available = isRustEngineAvailable();
  console.log(`Rust engine available: ${available}`);

  if (!available) {
    console.log(
      "\nSkipping parity tests: native addon not built.\n" +
        "Build with: cd native && npx @napi-rs/cli build --release",
    );
    process.exit(0);
  }

  // --- Hash parity ---
  console.log("\n--- Hash Content Parity ---");
  for (const { input, label } of HASH_VECTORS) {
    const tsResult = hashContent(input);
    const rustResult = hashContentRust(input);
    assertEqual(rustResult, tsResult, `hashContent: ${label}`);
  }

  // --- Symbol ID parity ---
  console.log("\n--- Symbol ID Parity ---");
  for (const vec of SYMBOL_ID_VECTORS) {
    const tsResult = generateSymbolId(
      vec.repoId,
      vec.relPath,
      vec.kind,
      vec.name,
      vec.fingerprint,
    );
    const rustResult = generateSymbolIdRust(
      vec.repoId,
      vec.relPath,
      vec.kind,
      vec.name,
      vec.fingerprint,
    );
    assertEqual(rustResult, tsResult, `generateSymbolId: ${vec.label}`);
  }

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
