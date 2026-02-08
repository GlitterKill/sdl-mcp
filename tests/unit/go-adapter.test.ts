import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GoAdapter } from "../../dist/indexer/adapter/go.js";

describe("Go Adapter", () => {
  const adapter = new GoAdapter();

  describe("ML-C2.1: Symbol Extraction", () => {
    it("should extract package declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/symbols.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");

      const pkgSymbol = symbols.find((s) => s.kind === "module");
      assert.ok(pkgSymbol, "Should extract package as module");
      assert.strictEqual(pkgSymbol?.name, "main");
      assert.strictEqual(pkgSymbol?.exported, true);
    });

    it("should extract functions with parameters and return types", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/symbols.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");

      const addFunc = symbols.find((s) => s.name === "Add");
      assert.ok(addFunc, "Should extract Add function");
      assert.strictEqual(addFunc?.kind, "function");
      assert.strictEqual(addFunc?.exported, true);
      assert.ok(addFunc?.signature);
      assert.strictEqual(addFunc?.signature?.params.length, 2);
      assert.strictEqual(addFunc?.signature?.params[0].name, "a");
      assert.strictEqual(addFunc?.signature?.params[0].type, "int");
      assert.strictEqual(addFunc?.signature?.returns, "int");
    });

    it("should extract methods with receiver type", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/symbols.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");

      const method1 = symbols.find((s) => s.name === "DoSomething");
      assert.ok(method1, "Should extract DoSomething method");
      assert.strictEqual(method1?.kind, "method");
      assert.strictEqual(method1?.exported, true);
      assert.ok(method1?.signature);
      assert.strictEqual(method1?.signature?.params[0].name, "MyType");
    });

    it("should extract type declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/symbols.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");

      const myType = symbols.find((s) => s.name === "MyType");
      assert.ok(myType, "Should extract MyType");
      assert.strictEqual(myType?.kind, "type");
      assert.strictEqual(myType?.exported, true);
    });

    it("should extract const declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/symbols.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");

      const maxRetries = symbols.find((s) => s.name === "MaxRetries");
      assert.ok(maxRetries, "Should extract MaxRetries const");
      assert.strictEqual(maxRetries?.kind, "variable");
      assert.strictEqual(maxRetries?.exported, true);
    });

    it("should extract var declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/symbols.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");

      const globalVar = symbols.find((s) => s.name === "GlobalVar");
      assert.ok(globalVar, "Should extract GlobalVar");
      assert.strictEqual(globalVar?.kind, "variable");
      assert.strictEqual(globalVar?.exported, true);
    });

    it("should export only capitalized symbols", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/symbols.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");

      const exported = symbols.filter((s) => s.exported);
      const unexported = symbols.filter((s) => !s.exported);

      assert.ok(exported.length > 0, "Should have exported symbols");
      assert.ok(unexported.length > 0, "Should have unexported symbols");

      const unexportedType = symbols.find((s) => s.name === "unexportedType");
      assert.strictEqual(unexportedType?.exported, false);

      const multiplyFunc = symbols.find((s) => s.name === "multiply");
      assert.strictEqual(multiplyFunc?.exported, false);
    });
  });

  describe("ML-C2.2: Import Extraction", () => {
    it("should extract single-line imports", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/imports.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.go");

      assert.ok(imports.some((imp) => imp.specifier === "fmt"));
      assert.ok(imports.some((imp) => imp.specifier === "os"));
      assert.ok(imports.some((imp) => imp.specifier === "math/rand"));
    });

    it("should extract aliased imports", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/imports.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.go");

      const stdlibAlias = imports.find((imp) => imp.specifier === "errors");
      assert.ok(stdlibAlias, "Should find errors import");
      assert.strictEqual(stdlibAlias?.imports[0], "stdlib");

      const myaliasImport = imports.find((imp) => imp.specifier === "net/http");
      assert.ok(myaliasImport, "Should find net/http import");
      assert.strictEqual(myaliasImport?.imports[0], "myalias");
    });

    it("should identify external vs relative imports", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/imports.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.go");

      const githubImport = imports.find(
        (imp) => imp.specifier === "github.com/user/lib",
      );
      assert.ok(githubImport, "Should find github import");
      assert.strictEqual(githubImport?.isExternal, true);
      assert.strictEqual(githubImport?.isRelative, false);
    });

    it("should identify dot imports", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/imports.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.go");

      const dotImport = imports.find((imp) => imp.specifier === "strings");
      assert.ok(dotImport, "Should find strings import");
      assert.strictEqual(dotImport?.imports[0], ".");
    });

    it("should identify blank imports", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/imports.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.go");

      const blankImport = imports.find(
        (imp) => imp.specifier === "database/sql",
      );
      assert.ok(blankImport, "Should find database/sql import");
      assert.strictEqual(blankImport?.imports[0], "_");
    });
  });

  describe("ML-C2.3: Call Extraction", () => {
    it("should extract function calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/calls.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");
      const calls = adapter.extractCalls(tree, content, "test.go", symbols);

      const addCall = calls.find((c) => c.calleeIdentifier === "Add");
      assert.ok(addCall, "Should find Add call");
      assert.strictEqual(addCall?.callType, "function");
    });

    it("should extract method calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/calls.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");
      const calls = adapter.extractCalls(tree, content, "test.go", symbols);

      const methodCall = calls.find((c) => c.calleeIdentifier === "t.Method1");
      assert.ok(methodCall, "Should find t.Method1 call");
      assert.strictEqual(methodCall?.callType, "method");
    });

    it("should extract package-qualified calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/calls.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");
      const calls = adapter.extractCalls(tree, content, "test.go", symbols);

      const fmtCall = calls.find((c) => c.calleeIdentifier.includes("fmt"));
      assert.ok(fmtCall, "Should find fmt call");
      assert.strictEqual(fmtCall?.callType, "method");

      const timeCall = calls.find((c) => c.calleeIdentifier.includes("time"));
      assert.ok(timeCall, "Should find time call");
      assert.strictEqual(timeCall?.callType, "method");
    });

    it("should extract go statement calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/calls.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");
      const calls = adapter.extractCalls(tree, content, "test.go", symbols);

      const goCalls = calls.filter(
        (c) => c.calleeIdentifier === "Add" || c.calleeIdentifier === "Method2",
      );

      assert.ok(
        goCalls.length >= 2,
        "Should find at least 2 calls (Add and Method2 in go statements)",
      );
    });

    it("should extract defer statement calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/calls.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");
      const calls = adapter.extractCalls(tree, content, "test.go", symbols);

      const fmtCall = calls.find((c) => c.calleeIdentifier.includes("fmt"));
      assert.ok(fmtCall, "Should find fmt.Println call in defer");

      const addCall = calls.filter((c) => c.calleeIdentifier === "Add");
      assert.ok(
        addCall.length >= 2,
        "Should find multiple Add calls (including defer)",
      );
    });
  });

  describe("ML-C2.4: Golden Files", () => {
    it("should match expected symbols output", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/symbols.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");

      assert.strictEqual(symbols.length, 20, "Should extract 20 symbols");
    });

    it("should match expected imports output", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/imports.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.go");

      assert.strictEqual(
        imports.length,
        10,
        "Should extract 10 imports (unique specs)",
      );
    });

    it("should match expected calls output", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/go/calls.go"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");
      const calls = adapter.extractCalls(tree, content, "test.go", symbols);

      assert.ok(calls.length >= 10, "Should extract at least 10 calls");
    });
  });

  describe("Integration", () => {
    it("should handle complete Go file with all constructs", () => {
      const content = `
package main

import "fmt"

type Service struct{}

func (s *Service) Process() error {
    fmt.Println("processing")
    return nil
}

func main() {
    s := &Service{}
    s.Process()
}
      `;

      const tree = adapter.parse(content, "test.go");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.go");
      const imports = adapter.extractImports(tree, content, "test.go");
      const calls = adapter.extractCalls(tree, content, "test.go", symbols);

      assert.ok(symbols.length > 0, "Should have symbols");
      assert.strictEqual(imports.length, 1, "Should have 1 import");
      assert.ok(calls.length > 0, "Should have calls");

      const serviceType = symbols.find((s) => s.name === "Service");
      assert.ok(serviceType);
      assert.strictEqual(serviceType?.kind, "type");

      const processMethod = symbols.find((s) => s.name === "Process");
      assert.ok(processMethod);
      assert.strictEqual(processMethod?.kind, "method");

      const processCall = calls.find((c) =>
        c.calleeIdentifier.includes("Process"),
      );
      assert.ok(processCall);
      assert.strictEqual(processCall?.callType, "method");
    });
  });
});
