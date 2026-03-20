import { describe, it } from "node:test";
import assert from "node:assert";

import { adapters } from "../../dist/indexer/adapter/adapters.js";

describe("Adapter Extension Mapping", () => {
  const extensionMap = new Map(adapters.map((a) => [a.extension, a]));

  describe("TypeScript/JavaScript extensions", () => {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
      it(`should map ${ext} to typescript adapter`, () => {
        const entry = extensionMap.get(ext);
        assert.ok(entry, `${ext} should have an adapter mapping`);
        assert.strictEqual(
          entry?.languageId,
          "typescript",
          `${ext} should map to typescript`,
        );
      });
    }
  });

  describe("Python extensions", () => {
    for (const ext of [".py", ".pyw"]) {
      it(`should map ${ext} to python adapter`, () => {
        const entry = extensionMap.get(ext);
        assert.ok(entry, `${ext} should have an adapter mapping`);
        assert.strictEqual(
          entry?.languageId,
          "python",
          `${ext} should map to python`,
        );
      });
    }
  });

  describe("Shell extensions", () => {
    for (const ext of [".sh", ".bash", ".zsh"]) {
      it(`should map ${ext} to shell adapter`, () => {
        const entry = extensionMap.get(ext);
        assert.ok(entry, `${ext} should have an adapter mapping`);
        assert.strictEqual(
          entry?.languageId,
          "shell",
          `${ext} should map to shell`,
        );
      });
    }
  });

  describe("Other language extensions", () => {
    const expectedMappings: [string, string][] = [
      [".java", "java"],
      [".go", "go"],
      [".cs", "csharp"],
      [".c", "c"],
      [".h", "c"],
      [".cc", "cpp"],
      [".cpp", "cpp"],
      [".cxx", "cpp"],
      [".hh", "cpp"],
      [".hpp", "cpp"],
      [".hxx", "cpp"],
      [".php", "php"],
      [".phtml", "php"],
      [".rs", "rust"],
      [".kt", "kotlin"],
      [".kts", "kotlin"],
    ];

    for (const [ext, lang] of expectedMappings) {
      it(`should map ${ext} to ${lang} adapter`, () => {
        const entry = extensionMap.get(ext);
        assert.ok(entry, `${ext} should have an adapter mapping`);
        assert.strictEqual(
          entry?.languageId,
          lang,
          `${ext} should map to ${lang}`,
        );
      });
    }
  });

  describe("CLAUDE.md enforcement extensions", () => {
    // All extensions listed in the CLAUDE.md blocked-extensions table must have mappings
    const enforcedExtensions = [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
      ".py", ".pyw",
      ".go",
      ".java",
      ".cs",
      ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx",
      ".php", ".phtml",
      ".rs",
      ".kt", ".kts",
      ".sh", ".bash", ".zsh",
    ];

    for (const ext of enforcedExtensions) {
      it(`enforced extension ${ext} should have an adapter`, () => {
        const entry = extensionMap.get(ext);
        assert.ok(
          entry,
          `Enforced extension ${ext} is in CLAUDE.md but missing from adapter mappings`,
        );
      });
    }
  });

  describe("Adapter factories produce valid instances", () => {
    it("should create working adapter instances for all extensions", () => {
      for (const entry of adapters) {
        const adapter = entry.factory();
        assert.ok(adapter, `Factory for ${entry.extension} should produce an adapter`);
        assert.ok(
          typeof adapter.parse === "function",
          `Adapter for ${entry.extension} should have parse method`,
        );
        assert.ok(
          typeof adapter.extractSymbols === "function",
          `Adapter for ${entry.extension} should have extractSymbols method`,
        );
      }
    });
  });

  describe("No duplicate extension entries", () => {
    it("should not have duplicate extensions", () => {
      const extensions = adapters.map((a) => a.extension);
      const unique = new Set(extensions);
      assert.strictEqual(
        extensions.length,
        unique.size,
        `Found duplicate extensions: ${extensions.filter(
          (e, i) => extensions.indexOf(e) !== i,
        )}`,
      );
    });
  });
});
