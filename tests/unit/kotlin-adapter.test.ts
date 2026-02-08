import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { KotlinAdapter } from "../../dist/indexer/adapter/kotlin.js";

describe("Kotlin Adapter", () => {
  const adapter = new KotlinAdapter();

  describe("ML-C2.1: Symbol Extraction", () => {
    it("should extract package declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const pkgSymbol = symbols.find((s) => s.kind === "module");
      assert.ok(pkgSymbol, "Should extract package as module");
      assert.strictEqual(pkgSymbol?.name, "com.example.kotlin");
      assert.strictEqual(pkgSymbol?.exported, true);
    });

    it("should extract class declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const userClass = symbols.find((s) => s.name === "User");
      assert.ok(userClass, "Should extract User class");
      assert.strictEqual(userClass?.kind, "class");
      assert.strictEqual(userClass?.exported, true);
    });

    it("should extract data class declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const taskClass = symbols.find((s) => s.name === "Task");
      assert.ok(taskClass, "Should extract Task data class");
      assert.strictEqual(taskClass?.kind, "class");
      assert.strictEqual(taskClass?.exported, true);
    });

    it("should extract open class declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const animalClass = symbols.find((s) => s.name === "Animal");
      assert.ok(animalClass, "Should extract Animal open class");
      assert.strictEqual(animalClass?.kind, "class");
      assert.strictEqual(animalClass?.exported, true);
    });

    it("should extract interface declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const repoInterface = symbols.find((s) => s.name === "Repository");
      assert.ok(repoInterface, "Should extract Repository interface");
      assert.strictEqual(repoInterface?.kind, "interface");
      assert.strictEqual(repoInterface?.exported, true);
      assert.ok(repoInterface?.signature?.generics);
      assert.strictEqual(repoInterface?.signature?.generics?.length, 1);
    });

    it("should extract object declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const dbConnection = symbols.find((s) => s.name === "DatabaseConnection");
      assert.ok(dbConnection, "Should extract DatabaseConnection object");
      assert.strictEqual(dbConnection?.kind, "class");
      assert.strictEqual(dbConnection?.exported, true);
    });

    it("should extract function declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const connectFunc = symbols.find((s) => s.name === "connect");
      assert.ok(connectFunc, "Should extract connect function");
      assert.strictEqual(connectFunc?.kind, "function");
      assert.strictEqual(connectFunc?.exported, true);
      assert.ok(connectFunc?.signature);
      assert.strictEqual(connectFunc?.signature?.returns, "String");
    });

    it("should extract method declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const findByIdMethod = symbols.find((s) => s.name === "findById");
      assert.ok(findByIdMethod, "Should extract findById method");
      assert.strictEqual(findByIdMethod?.kind, "function");
      assert.ok(findByIdMethod?.signature);
      assert.strictEqual(findByIdMethod?.signature?.params.length, 1);
      assert.strictEqual(findByIdMethod?.signature?.params[0].name, "id");
    });

    it("should extract property declarations", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const usersProperty = symbols.find((s) => s.name === "users");
      assert.ok(usersProperty, "Should extract users property");
      assert.strictEqual(usersProperty?.kind, "variable");
      assert.strictEqual(usersProperty?.exported, false);
      assert.strictEqual(usersProperty?.visibility, "private");
    });

    it("should extract secondary constructors", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const constructors = symbols.filter((s) => s.kind === "constructor");
      assert.ok(
        constructors.length >= 2,
        "Should extract multiple constructors",
      );
    });

    it("should extract companion object constants", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const maxLength = symbols.find((s) => s.name === "MAX_TITLE_LENGTH");
      assert.ok(maxLength, "Should extract MAX_TITLE_LENGTH constant");
      assert.strictEqual(maxLength?.kind, "variable");
    });

    it("should extract generic type parameters", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const repoInterface = symbols.find((s) => s.name === "Repository");
      assert.ok(repoInterface?.signature?.generics);
      assert.strictEqual(repoInterface?.signature?.generics?.length, 1);
      assert.strictEqual(repoInterface?.signature?.generics?.[0], "T");

      const transformMethod = symbols.find((s) => s.name === "transformUser");
      assert.ok(transformMethod?.signature?.generics);
      assert.strictEqual(transformMethod?.signature?.generics?.length, 1);
      assert.strictEqual(transformMethod?.signature?.generics?.[0], "T");
    });

    it("should extract visibility modifiers", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const publicSymbol = symbols.find((s) => s.name === "findById");
      assert.strictEqual(publicSymbol?.visibility, "public");

      const privateSymbol = symbols.find((s) => s.name === "users");
      assert.strictEqual(privateSymbol?.visibility, "private");
    });

    it("should extract extension functions", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const extensionFunc = symbols.find(
        (s) => s.name === "capitalizeExtension",
      );
      assert.ok(extensionFunc, "Should extract extension function");
      assert.strictEqual(extensionFunc?.kind, "function");
    });
  });

  describe("ML-C2.2: Import Extraction", () => {
    it("should extract simple imports", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/imports.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.kt");

      assert.ok(imports.some((imp) => imp.specifier === "java.util.List"));
      assert.ok(imports.some((imp) => imp.specifier === "java.util.Map"));
      assert.ok(
        imports.some((imp) => imp.specifier === "kotlin.collections.ArrayList"),
      );
    });

    it("should extract aliased imports", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/imports.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.kt");

      const javaHashMap = imports.find(
        (imp) => imp.specifier === "java.util.HashMap",
      );
      assert.ok(javaHashMap, "Should find HashMap import");
      assert.strictEqual(javaHashMap?.imports[0], "JavaHashMap");

      const mySet = imports.find(
        (imp) => imp.specifier === "java.util.HashSet",
      );
      assert.ok(mySet, "Should find HashSet import");
      assert.strictEqual(mySet?.imports[0], "MySet");
    });

    it("should extract wildcard imports", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/imports.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.kt");

      const wildcard1 = imports.find((imp) => imp.specifier === "java.util");
      assert.ok(wildcard1, "Should find java.util import");
      assert.strictEqual(wildcard1?.imports[0], "*");

      const wildcard2 = imports.find(
        (imp) => imp.specifier === "kotlin.collections",
      );
      assert.ok(wildcard2, "Should find kotlin.collections import");
      assert.strictEqual(wildcard2?.imports[0], "*");
    });

    it("should identify external vs relative imports", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/imports.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.kt");

      for (const imp of imports) {
        assert.strictEqual(
          imp.isExternal,
          true,
          "All imports should be external",
        );
        assert.strictEqual(
          imp.isRelative,
          false,
          "No imports should be relative",
        );
      }
    });
  });

  describe("ML-C2.3: Call Extraction", () => {
    it("should extract simple function calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const processCall = calls.find(
        (c) => c.calleeIdentifier === "processInput",
      );
      assert.ok(processCall, "Should find processInput call");
      assert.strictEqual(processCall?.callType, "function");
    });

    it("should extract method calls on objects", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const listAdd = calls.find((c) => c.calleeIdentifier === "list.add");
      assert.ok(listAdd, "Should find list.add call");
      assert.strictEqual(listAdd?.callType, "method");
    });

    it("should extract chained method calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const chainedCalls = calls.filter(
        (c) =>
          c.calleeIdentifier.includes(".toUpperCase") ||
          c.calleeIdentifier.includes(".trim") ||
          c.calleeIdentifier.includes(".substring"),
      );
      assert.ok(
        chainedCalls.length > 0,
        "Should find individual chained method calls",
      );
      assert.strictEqual(chainedCalls[0]?.callType, "method");
    });

    it("should extract companion object calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const createCall = calls.find((c) =>
        c.calleeIdentifier.includes("create"),
      );
      assert.ok(createCall, "Should find companion object create call");
    });

    it("should extract constructor calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const userCall = calls.find((c) => c.calleeIdentifier === "User");
      assert.ok(userCall, "Should find User constructor call");
      assert.strictEqual(userCall?.callType, "constructor");

      const taskCall = calls.find((c) => c.calleeIdentifier === "Task");
      assert.ok(taskCall, "Should find Task constructor call");
      assert.strictEqual(taskCall?.callType, "constructor");
    });

    it("should extract extension function calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const extensionCall = calls.find((c) =>
        c.calleeIdentifier.includes("capitalizeExtension"),
      );
      assert.ok(extensionCall, "Should find extension function call");
    });

    it("should extract this.method calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const thisCall = calls.find((c) => c.calleeIdentifier.includes("this."));
      assert.ok(thisCall, "Should find this.method call");
    });

    it("should extract nested function calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const outerCall = calls.find(
        (c) => c.calleeIdentifier === "processInput",
      );
      assert.ok(outerCall, "Should find outer processInput call");

      const innerCall = calls.find(
        (c) => c.calleeIdentifier === "uppercaseInput",
      );
      assert.ok(innerCall, "Should find nested uppercaseInput call");
    });

    it("should extract lambda calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const mapCall = calls.find((c) => c.calleeIdentifier.includes("map"));
      assert.ok(mapCall, "Should find map lambda call");
    });
  });

  describe("ML-C2.4: Golden Files", () => {
    it("should match expected symbols output", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/symbols.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");

      const expected = JSON.parse(
        readFileSync(
          join(process.cwd(), "tests/fixtures/kotlin/expected-symbols.json"),
          "utf-8",
        ),
      );

      assert.strictEqual(
        symbols.length,
        expected.length,
        `Should extract ${expected.length} symbols, got ${symbols.length}`,
      );
    });

    it("should match expected imports output", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/imports.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.kt");

      const expected = JSON.parse(
        readFileSync(
          join(process.cwd(), "tests/fixtures/kotlin/expected-imports.json"),
          "utf-8",
        ),
      );

      assert.strictEqual(
        imports.length,
        expected.length,
        `Should extract ${expected.length} imports, got ${imports.length}`,
      );
    });

    it("should match expected calls output", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const expected = JSON.parse(
        readFileSync(
          join(process.cwd(), "tests/fixtures/kotlin/expected-calls.json"),
          "utf-8",
        ),
      );

      assert.strictEqual(
        calls.length,
        expected.length,
        `Should extract ${expected.length} calls, got ${calls.length}`,
      );
    });
  });

  describe("Integration", () => {
    it("should handle complete Kotlin file with all constructs", () => {
      const content = `
package com.example

class Service {
    fun process(): String {
        return "done"
    }
}

fun main() {
    val service = Service()
    service.process()
}
      `;

      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      assert.ok(symbols.length > 0, "Should have symbols");

      const serviceClass = symbols.find((s) => s.name === "Service");
      assert.ok(serviceClass);
      assert.strictEqual(serviceClass?.kind, "class");

      const processMethod = symbols.find((s) => s.name === "process");
      assert.ok(processMethod);
      assert.strictEqual(processMethod?.kind, "function");

      const processCall = calls.find((c) =>
        c.calleeIdentifier.includes("process"),
      );
      assert.ok(processCall);
      assert.strictEqual(processCall?.callType, "method");
    });
  });

  describe("Edge Cases", () => {
    it("should handle extension function call edge cases", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const extensionCalls = calls.filter((c) =>
        c.calleeIdentifier.includes("Extension"),
      );
      assert.ok(
        extensionCalls.length > 0,
        "Should extract extension function calls",
      );
    });

    it("should handle constructor calls correctly", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const constructorCalls = calls.filter(
        (c) => c.callType === "constructor",
      );
      assert.ok(
        constructorCalls.length >= 2,
        "Should identify constructor calls",
      );
    });

    it("should handle chained call edge cases", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/kotlin/calls.kt"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.kt");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.kt");
      const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

      const chainedCalls = calls.filter((c) =>
        c.calleeIdentifier.includes("."),
      );
      assert.ok(chainedCalls.length > 0, "Should extract chained calls");
    });
  });
});
