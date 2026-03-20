import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CSharpAdapter } from "../../dist/indexer/adapter/csharp.js";

describe("C# Adapter", () => {
  const adapter = new CSharpAdapter();

  describe("Symbol Extraction", () => {
    it("should extract class definitions", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/csharp/symbols.cs"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.cs");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.cs");
      const classes = symbols.filter((s) => s.kind === "class");
      assert.ok(classes.length >= 1, "Should extract at least one class");

      const usersController = symbols.find(
        (s) => s.name === "UsersController",
      );
      assert.ok(usersController, "Should extract UsersController class");
      assert.strictEqual(usersController?.kind, "class");
    });

    it("should extract method definitions", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/csharp/symbols.cs"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.cs");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.cs");
      const methods = symbols.filter((s) => s.kind === "method");
      assert.ok(methods.length >= 1, "Should extract at least one method");
    });

    it("should extract namespace as module", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/csharp/symbols.cs"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.cs");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.cs");
      const modules = symbols.filter((s) => s.kind === "module");
      assert.ok(modules.length >= 1, "Should extract at least one namespace");
    });

    it("should extract interfaces", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/csharp/symbols.cs"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.cs");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.cs");
      const interfaces = symbols.filter((s) => s.kind === "interface");
      assert.ok(
        interfaces.length >= 1,
        "Should extract at least one interface",
      );
    });

    it("should match expected symbols count", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/csharp/symbols.cs"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.cs");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(
        tree,
        content,
        "tests/fixtures/csharp/symbols.cs",
      );

      const expected = JSON.parse(
        readFileSync(
          join(
            process.cwd(),
            "tests/fixtures/csharp/expected-symbols.json",
          ),
          "utf-8",
        ),
      );

      assert.strictEqual(
        symbols.length,
        expected.length,
        `Should extract ${expected.length} symbols`,
      );
    });
  });

  describe("Import Extraction", () => {
    it("should extract using directives", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/csharp/imports.cs"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.cs");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.cs");
      assert.ok(imports.length >= 1, "Should extract at least one import");
    });

    it("should match expected imports count", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/csharp/imports.cs"),
        "utf-8",
      );
      const tree = adapter.parse(content, "imports.cs");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "imports.cs");

      const expected = JSON.parse(
        readFileSync(
          join(
            process.cwd(),
            "tests/fixtures/csharp/expected-imports.json",
          ),
          "utf-8",
        ),
      );

      assert.strictEqual(
        imports.length,
        expected.length,
        `Should extract ${expected.length} imports`,
      );
    });
  });

  describe("Call Extraction", () => {
    it("should extract method calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/csharp/calls.cs"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.cs");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.cs");
      const calls = adapter.extractCalls(tree, content, "test.cs", symbols);
      assert.ok(calls.length >= 1, "Should extract at least one call");
    });

    it("should match expected calls count", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/csharp/calls.cs"),
        "utf-8",
      );
      const tree = adapter.parse(content, "calls.cs");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "calls.cs");
      const calls = adapter.extractCalls(tree, content, "calls.cs", symbols);

      const expected = JSON.parse(
        readFileSync(
          join(
            process.cwd(),
            "tests/fixtures/csharp/expected-calls.json",
          ),
          "utf-8",
        ),
      );

      assert.strictEqual(
        calls.length,
        expected.length,
        `Should extract ${expected.length} calls`,
      );
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty file", () => {
      const tree = adapter.parse("", "test.cs");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, "", "test.cs");
      assert.strictEqual(symbols.length, 0, "Empty file should produce no symbols");
    });

    it("should handle simple class with method", () => {
      const content = `
namespace TestApp {
    public class Calculator {
        public int Add(int a, int b) {
            return a + b;
        }
    }
}
      `;
      const tree = adapter.parse(content, "test.cs");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.cs");
      assert.ok(symbols.length >= 2, "Should extract namespace/class/method");

      const calcClass = symbols.find((s) => s.name === "Calculator");
      assert.ok(calcClass, "Should extract Calculator class");
    });
  });
});
