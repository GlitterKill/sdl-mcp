import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { TypeScriptAdapter } from "../../dist/indexer/adapter/index.js";
import {
  loadBuiltInAdapters,
  registerAdapter,
  resetRegistry,
} from "../../dist/indexer/adapter/registry.js";
import {
  clearCache,
  getParser,
  registerGrammarPackageRoot,
  type SupportedLanguage,
} from "../../dist/indexer/treesitter/grammarLoader.js";
import { createQueryForExtensionOrThrow } from "../../dist/indexer/treesitter/tsTreesitter.js";
import {
  collectIdentifierSourceEdits,
  collectStructuralSourceEdits,
  createStructuralQueryCache,
  getStructuralExtensions,
  getStructuralLanguageForPath,
  getStructuralLanguageIds,
  type StructuralSourceEdit,
} from "../../dist/mcp/tools/search-edit/structural.js";

function applyEdits(content: string, edits: StructuralSourceEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    chunks.push(content.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  chunks.push(content.slice(cursor));
  return chunks.join("");
}

interface LanguageFixture {
  languageId: string;
  relPath: string;
  literal: string;
  replacement: string;
  content: string;
  structuralQuery: string;
}

interface LazyLanguageFixture extends LanguageFixture {
  grammarLanguage: SupportedLanguage;
  parserPackage: string;
}

const LANGUAGE_FIXTURES: readonly LanguageFixture[] = [
  {
    languageId: "typescript",
    relPath: "src/example.ts",
    literal: "oldName",
    replacement: "newName",
    content: [
      "const oldName = 1;",
      'const text = "oldName";',
      "// oldName should stay in comments",
      "oldName();",
      "object.oldName;",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "python",
    relPath: "src/example.py",
    literal: "old_name",
    replacement: "new_name",
    content: [
      "old_name = 1",
      'text = "old_name"',
      "# old_name should stay in comments",
      "old_name()",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "go",
    relPath: "src/example.go",
    literal: "oldName",
    replacement: "newName",
    content: [
      "package main",
      'func main() { oldName(); text := "oldName" }',
      "// oldName should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "java",
    relPath: "src/Example.java",
    literal: "oldName",
    replacement: "newName",
    content: [
      'class Main { void m() { oldName(); String text = "oldName"; } }',
      "// oldName should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "csharp",
    relPath: "src/Example.cs",
    literal: "oldName",
    replacement: "newName",
    content: [
      'class C { void M() { oldName(); var text = "oldName"; } }',
      "// oldName should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "c",
    relPath: "src/example.c",
    literal: "old_name",
    replacement: "new_name",
    content: [
      'int main() { old_name(); char *text = "old_name"; }',
      "// old_name should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "cpp",
    relPath: "src/example.cpp",
    literal: "old_name",
    replacement: "new_name",
    content: [
      'int main() { old_name(); const char *text = "old_name"; }',
      "// old_name should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "php",
    relPath: "src/example.php",
    literal: "oldName",
    replacement: "newName",
    content: [
      '<?php oldName(); $text = "oldName"; // oldName should stay in comments',
      "",
    ].join("\n"),
    structuralQuery: "(name) @target",
  },
  {
    languageId: "rust",
    relPath: "src/example.rs",
    literal: "old_name",
    replacement: "new_name",
    content: [
      'fn main() { old_name(); let text = "old_name"; }',
      "// old_name should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "kotlin",
    relPath: "src/example.kt",
    literal: "oldName",
    replacement: "newName",
    content: [
      'fun main() { oldName(); val text = "oldName" }',
      "// oldName should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(simple_identifier) @target",
  },
  {
    languageId: "shell",
    relPath: "scripts/example.sh",
    literal: "old_cmd",
    replacement: "new_cmd",
    content: [
      "old_cmd arg",
      'text="old_cmd"',
      "# old_cmd should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(command_name) @target",
  },
];

const LAZY_LANGUAGE_FIXTURES: readonly LazyLanguageFixture[] = [
  {
    languageId: "powershell",
    grammarLanguage: "powershell",
    parserPackage: "tree-sitter-powershell",
    relPath: "scripts/example.ps1",
    literal: "oldName",
    replacement: "newName",
    content: [
      "function oldName { oldName }",
      '$text = "oldName"',
      "# oldName should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(function_name) @target",
  },
  {
    languageId: "ruby",
    grammarLanguage: "ruby",
    parserPackage: "tree-sitter-ruby",
    relPath: "src/example.rb",
    literal: "old_name",
    replacement: "new_name",
    content: [
      "def old_name",
      "end",
      "old_name",
      'text = "old_name"',
      "# old_name should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "lua",
    grammarLanguage: "lua",
    parserPackage: "@tree-sitter-grammars/tree-sitter-lua",
    relPath: "src/example.lua",
    literal: "old_name",
    replacement: "new_name",
    content: [
      "local old_name = 1",
      "old_name()",
      'text = "old_name"',
      "-- old_name should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "dart",
    grammarLanguage: "dart",
    parserPackage: "@sengac/tree-sitter-dart",
    relPath: "lib/example.dart",
    literal: "oldName",
    replacement: "newName",
    content: [
      "void oldName() {}",
      'void main() { oldName(); var text = "oldName"; }',
      "// oldName should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "swift",
    grammarLanguage: "swift",
    parserPackage: "tree-sitter-swift",
    relPath: "Sources/example.swift",
    literal: "oldName",
    replacement: "newName",
    content: [
      "func oldName() {}",
      'let text = "oldName"',
      "oldName()",
      "// oldName should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(simple_identifier) @target",
  },
  {
    languageId: "groovy",
    grammarLanguage: "groovy",
    parserPackage: "tree-sitter-groovy",
    relPath: "src/example.groovy",
    literal: "oldName",
    replacement: "newName",
    content: [
      "def oldName() {}",
      "oldName()",
      'def text = "oldName"',
      "// oldName should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "perl",
    grammarLanguage: "perl",
    parserPackage: "tree-sitter-perl",
    relPath: "src/example.pl",
    literal: "old_name",
    replacement: "new_name",
    content: [
      "sub old_name {}",
      "old_name();",
      'my $text = "old_name";',
      "# old_name should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(bareword) @target",
  },
  {
    languageId: "r",
    grammarLanguage: "r",
    parserPackage: "@davisvaughan/tree-sitter-r",
    relPath: "R/example.R",
    literal: "old_name",
    replacement: "new_name",
    content: [
      "old_name <- function() {}",
      "old_name()",
      'text <- "old_name"',
      "# old_name should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "elixir",
    grammarLanguage: "elixir",
    parserPackage: "tree-sitter-elixir",
    relPath: "lib/example.ex",
    literal: "old_name",
    replacement: "new_name",
    content: [
      "defmodule Example do",
      "  def old_name do",
      "    old_name()",
      '    text = "old_name"',
      "  end",
      "end",
      "# old_name should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier) @target",
  },
  {
    languageId: "fsharp",
    grammarLanguage: "fsharp",
    parserPackage: "tree-sitter-fsharp",
    relPath: "src/Example.fs",
    literal: "oldName",
    replacement: "newName",
    content: [
      "let oldName = 1",
      "let value = oldName",
      'let text = "oldName"',
      "// oldName should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(identifier_pattern) @target",
  },
  {
    languageId: "fortran",
    grammarLanguage: "fortran",
    parserPackage: "tree-sitter-fortran",
    relPath: "src/example.f90",
    literal: "old_name",
    replacement: "new_name",
    content: [
      "program old_name",
      'print *, "old_name"',
      "! old_name should stay in comments",
      "end program old_name",
      "",
    ].join("\n"),
    structuralQuery: "(name) @target",
  },
  {
    languageId: "haskell",
    grammarLanguage: "haskell",
    parserPackage: "tree-sitter-haskell",
    relPath: "src/Example.hs",
    literal: "oldName",
    replacement: "newName",
    content: [
      "oldName = 1",
      "main = print oldName",
      'text = "oldName"',
      "-- oldName should stay in comments",
      "",
    ].join("\n"),
    structuralQuery: "(variable) @target",
  },
];

function packageRootFor(parserPackage: string): string {
  return join(
    homedir(),
    ".sdl-mcp",
    "cache",
    "language-packs",
    "node_modules",
    ...parserPackage.split("/"),
  );
}

type LazyParserAvailability =
  | { status: "missing"; packageRoot: string }
  | { status: "available"; packageRoot: string }
  | { status: "unavailable"; packageRoot: string };

function cachedLazyParserAvailability(
  fixture: LazyLanguageFixture,
): LazyParserAvailability {
  const packageRoot = packageRootFor(fixture.parserPackage);
  if (!existsSync(packageRoot)) return { status: "missing", packageRoot };

  clearCache(fixture.grammarLanguage);
  registerGrammarPackageRoot(fixture.parserPackage, packageRoot);
  return getParser(fixture.grammarLanguage) === null
    ? { status: "unavailable", packageRoot }
    : { status: "available", packageRoot };
}

describe("search-edit structural matcher", () => {
  it("maps built-in structural extensions to public language ids", () => {
    const expected = new Map<string, string>([
      ["src/example.ts", "typescript"],
      ["src/example.tsx", "typescript"],
      ["src/example.js", "typescript"],
      ["src/example.jsx", "typescript"],
      ["src/example.mjs", "typescript"],
      ["src/example.cjs", "typescript"],
      ["src/example.py", "python"],
      ["src/example.pyw", "python"],
      ["src/example.go", "go"],
      ["src/example.java", "java"],
      ["src/example.cs", "csharp"],
      ["src/example.c", "c"],
      ["src/example.h", "c"],
      ["src/example.cc", "cpp"],
      ["src/example.cpp", "cpp"],
      ["src/example.cxx", "cpp"],
      ["src/example.hh", "cpp"],
      ["src/example.hpp", "cpp"],
      ["src/example.hxx", "cpp"],
      ["src/example.php", "php"],
      ["src/example.phtml", "php"],
      ["src/example.rs", "rust"],
      ["src/example.kt", "kotlin"],
      ["src/example.kts", "kotlin"],
      ["scripts/example.sh", "shell"],
      ["scripts/example.bash", "shell"],
      ["scripts/example.zsh", "shell"],
      ["scripts/example.ps1", "powershell"],
      ["scripts/example.psm1", "powershell"],
      ["scripts/example.psd1", "powershell"],
      ["src/example.rb", "ruby"],
      ["src/example.rake", "ruby"],
      ["src/example.lua", "lua"],
      ["lib/example.dart", "dart"],
      ["Sources/example.swift", "swift"],
      ["src/example.groovy", "groovy"],
      ["src/example.gradle", "groovy"],
      ["src/example.gvy", "groovy"],
      ["src/example.gy", "groovy"],
      ["src/example.gsh", "groovy"],
      ["src/example.pl", "perl"],
      ["src/example.pm", "perl"],
      ["src/example.t", "perl"],
      ["src/example.pod", "perl"],
      ["R/example.R", "r"],
      ["R/example.r", "r"],
      ["lib/example.ex", "elixir"],
      ["lib/example.exs", "elixir"],
      ["src/Example.fs", "fsharp"],
      ["src/Example.fsi", "fsharp"],
      ["src/Example.fsx", "fsharp"],
      ["src/example.f90", "fortran"],
      ["src/example.f95", "fortran"],
      ["src/example.f03", "fortran"],
      ["src/example.f08", "fortran"],
      ["src/example.f", "fortran"],
      ["src/example.for", "fortran"],
      ["src/example.f77", "fortran"],
      ["src/Example.hs", "haskell"],
      ["src/Example.lhs", "haskell"],
    ]);

    for (const [filePath, languageId] of expected) {
      assert.equal(
        getStructuralLanguageForPath(filePath),
        languageId,
        filePath,
      );
    }
    assert.equal(getStructuralLanguageForPath("README.md"), null);
    assert.ok(getStructuralLanguageIds().includes("python"));
    assert.ok(getStructuralLanguageIds().includes("powershell"));
    assert.ok(getStructuralLanguageIds().includes("haskell"));
    assert.ok(getStructuralExtensions("typescript").includes(".mjs"));
    assert.ok(getStructuralExtensions("powershell").includes(".ps1"));
    assert.ok(getStructuralExtensions("fortran").includes(".f90"));
  });

  it("covers descriptor-specific identifier node types", () => {
    const cases = [
      {
        relPath: "src/package.go",
        content: "package oldpkg\nfunc main() {}\n",
        literal: "oldpkg",
        expectedNodeType: "package_identifier",
      },
      {
        relPath: "src/fields.go",
        content:
          "package main\ntype OldType struct { oldField int }\nfunc main(){ var x OldType; _ = x.oldField }\n",
        literal: "oldField",
        expectedNodeType: "field_identifier",
      },
      {
        relPath: "src/field.c",
        content:
          "struct S { int old_field; }; int main(){ struct S s; return s.old_field; }\n",
        literal: "old_field",
        expectedNodeType: "field_identifier",
      },
      {
        relPath: "src/ns.cpp",
        content: "namespace old_ns { struct OldType { int old_field; }; }\n",
        literal: "old_ns",
        expectedNodeType: "namespace_identifier",
      },
      {
        relPath: "src/vars.php",
        content: "<?php $oldName = 1; echo $oldName;\n",
        literal: "$oldName",
        expectedNodeType: "variable_name",
      },
      {
        relPath: "src/types.rs",
        content:
          "struct OldType { old_field: i32 } fn main(){ let x = OldType { old_field: 1 }; }\n",
        literal: "OldType",
        expectedNodeType: "type_identifier",
      },
      {
        relPath: "src/types.kt",
        content: "class OldType {\n  val oldField: Int = 1\n}\n",
        literal: "OldType",
        expectedNodeType: "type_identifier",
      },
      {
        relPath: "scripts/vars.sh",
        content: "echo $old_name\nold_cmd arg\n",
        literal: "old_name",
        expectedNodeType: "variable_name",
      },
      {
        relPath: "scripts/commands.sh",
        content: "echo $old_name\nold_cmd arg\n",
        literal: "old_cmd",
        expectedNodeType: "command_name",
      },
    ] as const;

    for (const testCase of cases) {
      const edits = collectIdentifierSourceEdits({
        content: testCase.content,
        relPath: testCase.relPath,
        literal: testCase.literal,
        replacement: "replacement",
        global: true,
      });

      assert.ok(edits.length >= 1, testCase.relPath);
      assert.equal(
        edits.some(
          (edit) => edit.captures[0]?.nodeType === testCase.expectedNodeType,
        ),
        true,
        testCase.relPath,
      );
    }
  });

  for (const fixture of LANGUAGE_FIXTURES) {
    it(`replaces exact ${fixture.languageId} AST identifiers without touching strings or comments`, () => {
      const edits = collectIdentifierSourceEdits({
        content: fixture.content,
        relPath: fixture.relPath,
        literal: fixture.literal,
        replacement: fixture.replacement,
        global: true,
      });

      assert.ok(edits.length >= 1, fixture.languageId);
      const updated = applyEdits(fixture.content, edits);
      assert.match(updated, new RegExp(fixture.replacement));
      assert.match(updated, new RegExp(`"${fixture.literal}"`));
      assert.match(
        updated,
        new RegExp(`${fixture.literal} should stay in comments`),
      );
    });

    it(`runs ${fixture.languageId} structural tree-sitter queries`, () => {
      const edits = collectStructuralSourceEdits({
        content: fixture.content,
        relPath: fixture.relPath,
        structural: {
          language: fixture.languageId,
          treeSitterQuery: fixture.structuralQuery,
          requiredCaptures: { target: fixture.literal },
        },
        replacement: fixture.replacement,
        global: false,
      });

      assert.equal(edits.length, 1, fixture.languageId);
      assert.equal(edits[0].captures[0]?.text, fixture.literal);
      assert.match(
        applyEdits(fixture.content, edits),
        new RegExp(fixture.replacement),
      );
    });
  }

  for (const fixture of LAZY_LANGUAGE_FIXTURES) {
    it(`uses the ${fixture.languageId} lazy parser for AST identifiers when available`, (t) => {
      const availability = cachedLazyParserAvailability(fixture);
      if (availability.status === "missing") {
        t.skip(
          `${fixture.parserPackage} is not installed in ${availability.packageRoot}`,
        );
        return;
      }
      assert.equal(availability.status, "available", availability.packageRoot);

      const edits = collectIdentifierSourceEdits({
        content: fixture.content,
        relPath: fixture.relPath,
        literal: fixture.literal,
        replacement: fixture.replacement,
        global: true,
      });

      assert.ok(edits.length >= 1, fixture.languageId);
      const updated = applyEdits(fixture.content, edits);
      assert.match(updated, new RegExp(fixture.replacement));
      assert.match(updated, new RegExp(`"${fixture.literal}"`));
      assert.match(
        updated,
        new RegExp(`${fixture.literal} should stay in comments`),
      );
    });

    it(`runs ${fixture.languageId} lazy structural queries when available`, (t) => {
      const availability = cachedLazyParserAvailability(fixture);
      if (availability.status === "missing") {
        t.skip(
          `${fixture.parserPackage} is not installed in ${availability.packageRoot}`,
        );
        return;
      }
      assert.equal(availability.status, "available", availability.packageRoot);

      const edits = collectStructuralSourceEdits({
        content: fixture.content,
        relPath: fixture.relPath,
        structural: {
          language: fixture.languageId,
          treeSitterQuery: fixture.structuralQuery,
          requiredCaptures: { target: fixture.literal },
        },
        replacement: fixture.replacement,
        global: false,
      });

      assert.equal(edits.length, 1, fixture.languageId);
      assert.equal(edits[0].captures[0]?.text, fixture.literal);
      assert.match(
        applyEdits(fixture.content, edits),
        new RegExp(fixture.replacement),
      );
    });
  }
  it("keeps identifier ranges aligned after multibyte characters", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const content = [
      `const prefix = "${emoji}";`,
      "const oldName = 1;",
      "oldName();",
      "",
    ].join("\n");

    const edits = collectIdentifierSourceEdits({
      content,
      relPath: "src/example.ts",
      literal: "oldName",
      replacement: "newName",
      global: true,
    });

    assert.equal(edits.length, 2);
    assert.equal(
      applyEdits(content, edits),
      [
        `const prefix = "${emoji}";`,
        "const newName = 1;",
        "newName();",
        "",
      ].join("\n"),
    );
  });

  it("targets tree-sitter query captures with capture interpolation", () => {
    const content = ['oldName("a");', 'other("b");', ""].join("\n");

    const edits = collectStructuralSourceEdits({
      content,
      relPath: "src/example.ts",
      structural: {
        treeSitterQuery: `
          (call_expression
            function: (identifier) @callee
            arguments: (arguments) @args) @target
        `,
        requiredCaptures: { callee: "oldName" },
      },
      replacement: "newName$args",
      global: true,
    });

    assert.equal(edits.length, 1);
    assert.equal(
      edits[0].captures.some((capture) => capture.name === "args"),
      true,
    );
    assert.equal(applyEdits(content, edits), 'newName("a");\nother("b");\n');
  });

  it("caps structural collection before scanning every query window", () => {
    const content = Array.from(
      { length: 8_000 },
      (_, index) => `const oldName${index} = oldName;`,
    ).join("\n");

    const edits = collectStructuralSourceEdits({
      content,
      relPath: "src/large.ts",
      structural: {
        treeSitterQuery: "(identifier) @target",
        requiredCaptures: { target: "oldName" },
      },
      replacement: "newName",
      global: true,
      maxMatches: 5,
    });

    assert.equal(edits.length, 5);
    assert.deepEqual(
      edits.map((edit) => edit.captures[0]?.text),
      ["oldName", "oldName", "oldName", "oldName", "oldName"],
    );
  });

  it("stops structural collection when the aggregate deadline is exhausted", () => {
    assert.throws(
      () =>
        collectStructuralSourceEdits({
          content: "const oldName = oldName;\n",
          relPath: "src/deadline.ts",
          structural: {
            treeSitterQuery: "(identifier) @target",
            requiredCaptures: { target: "oldName" },
          },
          replacement: "newName",
          global: true,
          deadlineMs: Date.now() - 1,
        }),
      /structural-query-time-budget/,
    );
  });

  it("throws a validation error for malformed structural queries", () => {
    for (const fixture of LANGUAGE_FIXTURES) {
      assert.throws(
        () =>
          collectStructuralSourceEdits({
            content: fixture.content,
            relPath: fixture.relPath,
            structural: {
              language: fixture.languageId,
              treeSitterQuery: fixture.structuralQuery.replace(") @target", ""),
            },
            replacement: fixture.replacement,
            global: true,
          }),
        /Invalid structural tree-sitter query/,
        fixture.languageId,
      );
    }
  });

  it("supports JSX/TSX captures through the TSX grammar", () => {
    const content = "export const View = () => <Button oldName={value} />;\n";

    const edits = collectStructuralSourceEdits({
      content,
      relPath: "src/view.tsx",
      structural: {
        treeSitterQuery: `
          (jsx_attribute
            (property_identifier) @name) @target
        `,
        requiredCaptures: { name: "oldName" },
      },
      replacement: "newName={value}",
      global: true,
    });

    assert.equal(edits.length, 1);
    assert.equal(
      applyEdits(content, edits),
      "export const View = () => <Button newName={value} />;\n",
    );
  });

  it("throws for cached structural queries incompatible with the candidate grammar variant", () => {
    const structural = {
      language: "typescript",
      treeSitterQuery: `
        (jsx_attribute
          (property_identifier) @name) @target
      `,
      requiredCaptures: { name: "oldName" },
    };
    const queryCache = createStructuralQueryCache(structural, "typescript");

    assert.throws(
      () =>
        collectStructuralSourceEdits({
          content: "export const plain = oldName;\n",
          relPath: "src/plain.ts",
          structural,
          replacement: "newName={value}",
          queryCache,
          global: true,
        }),
      /Invalid structural tree-sitter query for src\/plain\.ts/i,
    );
  });

  it("checks the aggregate time budget before parsing structural candidates", () => {
    assert.throws(
      () =>
        collectStructuralSourceEdits({
          content: "const oldName = 1;\n",
          relPath: "src/example.ts",
          structural: {
            language: "typescript",
            treeSitterQuery: "(identifier) @target",
            requiredCaptures: { target: "oldName" },
          },
          replacement: "newName",
          deadlineMs: Date.now() - 1,
        }),
      /structural-query-time-budget/,
    );
  });

  it("uses plugin structural matcher descriptors when a plugin opts in", () => {
    resetRegistry();
    try {
      registerAdapter(
        ".plug",
        "plug-ts",
        () => new TypeScriptAdapter(),
        "plugin",
        "test-plugin",
        {
          identifierNodeTypes: ["identifier"],
          createQuery: (queryString) =>
            createQueryForExtensionOrThrow(".ts", queryString),
        },
      );

      const content = [
        "const oldName = 1;",
        'const text = "oldName";',
        "// oldName should stay in comments",
        "oldName();",
        "",
      ].join("\n");
      const edits = collectIdentifierSourceEdits({
        content,
        relPath: "src/example.plug",
        literal: "oldName",
        replacement: "newName",
        global: true,
      });

      assert.equal(getStructuralLanguageForPath("src/example.plug"), "plug-ts");
      assert.equal(edits.length, 2);
      assert.match(applyEdits(content, edits), /const newName = 1/);
    } finally {
      resetRegistry();
      loadBuiltInAdapters();
    }
  });
});
