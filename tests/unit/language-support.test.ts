import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  getAdapterForExtension,
  resetRegistry,
} from "../../dist/indexer/adapter/registry.js";
import {
  LANGUAGE_SUPPORT,
  createBuiltInImportResolutionAdapters,
  createBuiltInPass2Resolvers,
} from "../../dist/indexer/language-support.js";

const EXPECTED_EXTENSIONS = {
  ".bash": ["shell", "ShellAdapter"],
  ".c": ["c", "CAdapter"],
  ".cc": ["cpp", "CppAdapter"],
  ".cjs": ["typescript", "TypeScriptAdapter"],
  ".cpp": ["cpp", "CppAdapter"],
  ".cs": ["csharp", "CSharpAdapter"],
  ".cxx": ["cpp", "CppAdapter"],
  ".go": ["go", "GoAdapter"],
  ".h": ["c", "CAdapter"],
  ".hh": ["cpp", "CppAdapter"],
  ".hpp": ["cpp", "CppAdapter"],
  ".hxx": ["cpp", "CppAdapter"],
  ".java": ["java", "JavaAdapter"],
  ".js": ["typescript", "TypeScriptAdapter"],
  ".jsx": ["typescript", "TypeScriptAdapter"],
  ".kt": ["kotlin", "KotlinAdapter"],
  ".kts": ["kotlin", "KotlinAdapter"],
  ".mjs": ["typescript", "TypeScriptAdapter"],
  ".php": ["php", "PhpAdapter"],
  ".phtml": ["php", "PhpAdapter"],
  ".py": ["python", "PythonAdapter"],
  ".pyw": ["python", "PythonAdapter"],
  ".rs": ["rust", "RustAdapter"],
  ".sh": ["shell", "ShellAdapter"],
  ".ts": ["typescript", "TypeScriptAdapter"],
  ".tsx": ["typescript", "TypeScriptAdapter"],
  ".zsh": ["shell", "ShellAdapter"],
} as const;

afterEach(() => resetRegistry());

describe("built-in Language Support", () => {
  it("owns each of the 27 extension registrations exactly once", () => {
    const actual: Record<string, readonly [string, string]> = {};
    for (const support of LANGUAGE_SUPPORT) {
      const constructorName = support.adapterFactory().constructor.name;
      for (const extension of support.extensions) {
        assert.equal(actual[extension], undefined, extension);
        actual[extension] = [support.language, constructorName];
      }
    }

    assert.deepEqual(actual, EXPECTED_EXTENSIONS);
  });

  it("pins grammar, import-candidate, pass-2, and matcher support", () => {
    assert.deepEqual(
      LANGUAGE_SUPPORT.map((support) => [
        support.language,
        support.grammarKey,
        Boolean(support.importCandidatesFactory),
        support.pass2ResolverFactory().id,
        Boolean(support.structuralMatcher),
      ]),
      [
        ["typescript", "typescript", false, "pass2-ts", false],
        ["go", "go", true, "pass2-go", false],
        ["java", "java", true, "pass2-java", false],
        ["php", "php", true, "pass2-php", false],
        ["python", "python", true, "pass2-python", false],
        ["kotlin", "kotlin", true, "pass2-kotlin", false],
        ["rust", "rust", true, "pass2-rust", false],
        ["csharp", "csharp", true, "pass2-csharp", false],
        ["cpp", "cpp", true, "pass2-cpp", false],
        ["c", "c", true, "pass2-c", false],
        ["shell", "bash", true, "pass2-shell", false],
      ],
    );

    const importAdapters = createBuiltInImportResolutionAdapters();
    assert.equal(importAdapters.length, 8);
    for (const language of [
      "c",
      "cpp",
      "go",
      "csharp",
      "java",
      "kotlin",
      "rust",
      "python",
      "php",
      "shell",
    ]) {
      assert.ok(importAdapters.some((adapter) => adapter.supports(language)));
    }
    assert.equal(
      importAdapters.some((adapter) => adapter.supports("typescript")),
      false,
    );
    assert.equal(createBuiltInPass2Resolvers().length, 11);
  });

  it("keeps adapter creation lazy and cached by extension", () => {
    const first = getAdapterForExtension(".ts");
    const second = getAdapterForExtension(".ts");
    assert.ok(first);
    assert.strictEqual(first, second);
  });

  it("contains data and lazy factories without config I/O or grammar calls", () => {
    const source = readFileSync(
      join(process.cwd(), "src/indexer/language-support.ts"),
      "utf8",
    );
    assert.doesNotMatch(source, /config|loadConfig|readFile|createParser|getParser\(/);
    assert.match(source, /adapterFactory:\s*\(\)\s*=>\s*new/);
    assert.match(
      source,
      /pass2ResolverFactory:\s*\(\)\s*=>\s*\n?\s*createLazyPass2Resolver/,
    );
    assert.doesNotMatch(
      source,
      /^import \{ \w+Pass2Resolver \} from/m,
      "pass-2 implementations must remain dynamic to avoid registry cycles",
    );
  });
});
