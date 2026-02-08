import { describe, it } from "node:test";
import assert from "node:assert";
import { MyLangAdapter } from "../dist/index.js";

describe("MyLang Plugin Tests", () => {
  const adapter = new MyLangAdapter();

  describe("Metadata", () => {
    it("should have correct language ID", () => {
      assert.strictEqual(adapter.languageId, "mylang");
    });

    it("should have correct file extensions", () => {
      assert.ok(adapter.fileExtensions.includes(".mylang"));
    });
  });

  describe("Symbol Extraction", () => {
    it("should extract functions", () => {
      const content = `function greet(name: string) {
  print("Hello, " + name + "!");
}`;
      const symbols = adapter.extractSymbols(null, content, "test.mylang");

      const greet = symbols.find((s) => s.name === "greet");
      assert.ok(greet, "Should extract greet function");
      assert.strictEqual(greet.kind, "function");
      assert.strictEqual(greet.filePath, "test.mylang");
      assert.ok(greet.range, "Should have range information");
    });

    it("should extract classes", () => {
      const content = `class Calculator {
  function add(a: number, b: number): number {
    return a + b;
  }
}`;
      const symbols = adapter.extractSymbols(null, content, "test.mylang");

      const calculator = symbols.find((s) => s.name === "Calculator");
      assert.ok(calculator, "Should extract Calculator class");
      assert.strictEqual(calculator.kind, "class");
    });

    it("should handle empty content", () => {
      const content = "";
      const symbols = adapter.extractSymbols(null, content, "test.mylang");

      assert.strictEqual(symbols.length, 0);
    });

    it("should extract multiple symbols", () => {
      const content = `function func1() {}
function func2() {}
class MyClass {}`;
      const symbols = adapter.extractSymbols(null, content, "test.mylang");

      assert.ok(symbols.length >= 3, "Should extract multiple symbols");
      assert.ok(symbols.some((s) => s.name === "func1"));
      assert.ok(symbols.some((s) => s.name === "func2"));
      assert.ok(symbols.some((s) => s.name === "MyClass"));
    });
  });

  describe("Import Extraction", () => {
    it("should extract imports", () => {
      const content = `import "stdlib"
import "mylib/utils"`;
      const imports = adapter.extractImports(null, content, "test.mylang");

      assert.strictEqual(imports.length, 2);
      assert.ok(imports.some((i) => i.moduleName === "stdlib"));
      assert.ok(imports.some((i) => i.moduleName === "mylib/utils"));
    });

    it("should handle empty imports", () => {
      const content = "";
      const imports = adapter.extractImports(null, content, "test.mylang");

      assert.strictEqual(imports.length, 0);
    });

    it("should extract import with correct range", () => {
      const content = `import "stdlib"`;
      const imports = adapter.extractImports(null, content, "test.mylang");

      assert.strictEqual(imports.length, 1);
      assert.strictEqual(imports[0].moduleName, "stdlib");
      assert.strictEqual(imports[0].range.startLine, 1);
      assert.ok(imports[0].range.endCol > imports[0].range.startCol);
    });
  });

  describe("Call Extraction", () => {
    it("should extract function calls", () => {
      const content = `function test() {}
test()`;
      const symbols = adapter.extractSymbols(null, content, "test.mylang");
      const calls = adapter.extractCalls(null, content, "test.mylang", symbols);

      const testCall = calls.find((c) => c.targetSymbolId.includes("test"));
      assert.ok(testCall, "Should extract call to test function");
      assert.strictEqual(testCall.filePath, "test.mylang");
      assert.ok(testCall.range, "Should have range information");
    });

    it("should extract multiple calls", () => {
      const content = `function func1() {}
function func2() {}
func1()
func2()`;
      const symbols = adapter.extractSymbols(null, content, "test.mylang");
      const calls = adapter.extractCalls(null, content, "test.mylang", symbols);

      assert.ok(calls.length >= 2, "Should extract multiple calls");
      assert.ok(calls.some((c) => c.targetSymbolId.includes("func1")));
      assert.ok(calls.some((c) => c.targetSymbolId.includes("func2")));
    });

    it("should not extract calls to undefined symbols", () => {
      const content = `undefinedFunction()`;
      const symbols = adapter.extractSymbols(null, content, "test.mylang");
      const calls = adapter.extractCalls(null, content, "test.mylang", symbols);

      assert.strictEqual(
        calls.length,
        0,
        "Should not extract calls to undefined symbols",
      );
    });
  });

  describe("Graph Structure", () => {
    it("should maintain valid symbol IDs", () => {
      const content = `function test() {}`;
      const symbols = adapter.extractSymbols(null, content, "test.mylang");

      for (const symbol of symbols) {
        assert.ok(symbol.id, "Symbol should have ID");
        assert.ok(
          symbol.id.includes("test.mylang"),
          "ID should include file path",
        );
        assert.ok(symbol.id.includes("test"), "ID should include symbol name");
      }
    });

    it("should maintain valid call references", () => {
      const content = `function test() {}
test()`;
      const symbols = adapter.extractSymbols(null, content, "test.mylang");
      const calls = adapter.extractCalls(null, content, "test.mylang", symbols);

      for (const call of calls) {
        assert.ok(call.targetSymbolId, "Call should have targetSymbolId");
        const targetSymbol = symbols.find((s) => s.id === call.targetSymbolId);
        assert.ok(targetSymbol, "Call should reference existing symbol");
      }
    });

    it("should extract complete graph", () => {
      const content = `import "stdlib"

function helper() {
  return 42
}

function main() {
  helper()
  print("Done")
}`;
      const symbols = adapter.extractSymbols(null, content, "test.mylang");
      const imports = adapter.extractImports(null, content, "test.mylang");
      const calls = adapter.extractCalls(null, content, "test.mylang", symbols);

      assert.ok(symbols.length > 0, "Should have symbols");
      assert.ok(imports.length > 0, "Should have imports");
      assert.ok(calls.length > 0, "Should have calls");

      assert.ok(symbols.some((s) => s.name === "helper"));
      assert.ok(symbols.some((s) => s.name === "main"));
      assert.ok(imports.some((i) => i.moduleName === "stdlib"));
      assert.ok(calls.some((c) => c.targetSymbolId.includes("helper")));
    });
  });
});
