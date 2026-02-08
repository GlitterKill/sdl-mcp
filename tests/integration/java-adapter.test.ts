import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { JavaAdapter } from "../../dist/indexer/adapter/java.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Java Adapter Tests (ML-C3.x)", () => {
  const adapter = new JavaAdapter();
  const fixturesDir = resolve(__dirname, "..", "fixtures", "java");

  describe("ML-C3.1: Symbol Extraction", () => {
    it("should extract all symbols correctly", () => {
      const filePath = resolve(fixturesDir, "symbols.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree, "Should parse Java code");

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const goldenPath = resolve(fixturesDir, "expected-symbols.json");
      const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));

      assert.strictEqual(
        symbols.length,
        golden.length,
        "Should extract same number of symbols",
      );

      for (let i = 0; i < symbols.length; i++) {
        const actual = symbols[i];
        const expected = golden[i];

        assert.strictEqual(
          actual.name,
          expected.name,
          `Symbol ${i}: name mismatch`,
        );
        assert.strictEqual(
          actual.kind,
          expected.kind,
          `Symbol ${i}: kind mismatch`,
        );
        assert.strictEqual(
          actual.exported,
          expected.exported,
          `Symbol ${i}: exported mismatch`,
        );
        assert.strictEqual(
          actual.visibility,
          expected.visibility,
          `Symbol ${i}: visibility mismatch`,
        );

        if (expected.signature) {
          assert.ok(actual.signature, `Symbol ${i}: should have signature`);
          assert.strictEqual(
            actual.signature?.params.length,
            expected.signature.params.length,
            `Symbol ${i}: params count mismatch`,
          );
          assert.strictEqual(
            actual.signature?.returns,
            expected.signature.returns,
            `Symbol ${i}: returns mismatch`,
          );
        }

        assert.deepStrictEqual(
          actual.range,
          expected.range,
          `Symbol ${i}: range mismatch`,
        );
      }

      console.log(`✓ Extracted ${symbols.length} symbols for symbols.java`);
    });

    it("should extract classes with modifiers", () => {
      const filePath = resolve(fixturesDir, "symbols.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const symbolsClass = symbols.find((s) => s.name === "Symbols");
      assert.ok(symbolsClass, "Should extract Symbols class");
      assert.strictEqual(symbolsClass.kind, "class");
      assert.strictEqual(symbolsClass.visibility, "public");
      assert.strictEqual(symbolsClass.exported, true);
    });

    it("should extract methods with visibility and signature", () => {
      const filePath = resolve(fixturesDir, "symbols.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const publicMethod = symbols.find((s) => s.name === "publicMethod");
      assert.ok(publicMethod, "Should extract publicMethod");
      assert.strictEqual(publicMethod.kind, "method");
      assert.strictEqual(publicMethod.visibility, "public");
      assert.ok(publicMethod.signature);
      assert.strictEqual(publicMethod.signature?.params.length, 2);
      assert.strictEqual(publicMethod.signature?.returns, "String");

      const privateMethod = symbols.find((s) => s.name === "privateMethod");
      assert.ok(privateMethod, "Should extract privateMethod");
      assert.strictEqual(privateMethod.visibility, "private");
      assert.strictEqual(privateMethod.exported, false);
    });

    it("should identify constructors", () => {
      const filePath = resolve(fixturesDir, "symbols.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const constructor = symbols.find(
        (s) => s.name === "Symbols" && s.kind === "constructor",
      );
      assert.ok(constructor, "Should extract constructor");
      assert.strictEqual(constructor.kind, "constructor");
      assert.ok(constructor.signature);
      assert.strictEqual(constructor.signature?.returns, "Symbols");
    });

    it("should extract interfaces", () => {
      const filePath = resolve(fixturesDir, "symbols.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const interfaceSym = symbols.find((s) => s.name === "ExampleInterface");
      assert.ok(interfaceSym, "Should extract ExampleInterface");
      assert.strictEqual(interfaceSym.kind, "interface");
    });

    it("should extract enums", () => {
      const filePath = resolve(fixturesDir, "symbols.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const enumSym = symbols.find((s) => s.name === "Status");
      assert.ok(enumSym, "Should extract Status enum");
      assert.strictEqual(enumSym.kind, "class");
    });

    it("should extract records", () => {
      const filePath = resolve(fixturesDir, "symbols.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const record = symbols.find((s) => s.name === "Point");
      assert.ok(record, "Should extract Point record");
      assert.strictEqual(record.kind, "class");
    });

    it("should extract fields with visibility", () => {
      const filePath = resolve(fixturesDir, "symbols.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const privateField = symbols.find((s) => s.name === "privateField");
      assert.ok(privateField, "Should extract privateField");
      assert.strictEqual(privateField.kind, "variable");
      assert.strictEqual(privateField.visibility, "private");

      const publicField = symbols.find((s) => s.name === "publicField");
      assert.ok(publicField, "Should extract publicField");
      assert.strictEqual(publicField.visibility, "public");
    });

    it("should extract package as module", () => {
      const filePath = resolve(fixturesDir, "symbols.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const pkg = symbols.find((s) => s.name === "com.example");
      assert.ok(pkg, "Should extract package");
      assert.strictEqual(pkg.kind, "module");
      assert.strictEqual(pkg.visibility, "public");
    });
  });

  describe("ML-C3.2: Import Extraction", () => {
    it("should extract all imports correctly", () => {
      const filePath = resolve(fixturesDir, "imports.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree, "Should parse Java code");

      const imports = adapter.extractImports(tree, content, filePath);

      const goldenPath = resolve(fixturesDir, "expected-imports.json");
      const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));

      assert.deepStrictEqual(imports, golden);
      console.log(`✓ Extracted ${imports.length} imports for imports.java`);
    });

    it("should parse single imports", () => {
      const filePath = resolve(fixturesDir, "imports.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, filePath);

      const listImport = imports.find((i) => i.specifier === "java.util.List");
      assert.ok(listImport, "Should extract List import");
      assert.ok(listImport.imports.includes("List"));
    });

    it("should parse wildcard imports", () => {
      const filePath = resolve(fixturesDir, "imports.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, filePath);

      const wildcardImport = imports.find((i) => i.specifier === "java.util");
      assert.ok(wildcardImport, "Should extract wildcard import");
      assert.ok(wildcardImport.imports.includes("util"));
    });

    it("should identify static imports", () => {
      const filePath = resolve(fixturesDir, "imports.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, filePath);

      const staticImport = imports.find(
        (i) => i.specifier === "java.util.Collections.EMPTY_LIST",
      );
      assert.ok(staticImport, "Should extract static import");
      assert.ok(staticImport.imports.includes("EMPTY_LIST"));
    });
  });

  describe("ML-C3.3: Call Extraction", () => {
    it("should extract all calls correctly", () => {
      const filePath = resolve(fixturesDir, "calls.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree, "Should parse Java code");

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const goldenPath = resolve(fixturesDir, "expected-calls.json");
      const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));

      assert.strictEqual(
        calls.length,
        golden.length,
        "Should extract same number of calls",
      );

      for (let i = 0; i < calls.length; i++) {
        const actual = calls[i];
        const expected = golden[i];

        assert.strictEqual(
          actual.calleeIdentifier,
          expected.calleeIdentifier,
          `Call ${i}: calleeIdentifier mismatch`,
        );
        assert.strictEqual(
          actual.isResolved,
          expected.isResolved,
          `Call ${i}: isResolved mismatch`,
        );
        assert.strictEqual(
          actual.callType,
          expected.callType,
          `Call ${i}: callType mismatch`,
        );

        if (expected.calleeSymbolId) {
          assert.ok(
            actual.calleeSymbolId,
            `Call ${i}: should have calleeSymbolId`,
          );
        }

        assert.deepStrictEqual(
          actual.range,
          expected.range,
          `Call ${i}: range mismatch`,
        );
      }

      console.log(`✓ Extracted ${calls.length} calls for calls.java`);
    });

    it("should extract method calls with context", () => {
      const filePath = resolve(fixturesDir, "calls.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const addCall = calls.find((c) => c.calleeIdentifier === "list.add");
      assert.ok(addCall, "Should extract list.add call");
      assert.strictEqual(addCall.callType, "method");
    });

    it("should create constructor edges for new expressions", () => {
      const filePath = resolve(fixturesDir, "calls.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const newCall = calls.find((c) =>
        c.calleeIdentifier.includes("new ArrayList"),
      );
      assert.ok(newCall, "Should extract new ArrayList call");
      assert.strictEqual(newCall.callType, "constructor");
    });

    it("should capture chained calls", () => {
      const filePath = resolve(fixturesDir, "calls.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const toUpperCaseCall = calls.find(
        (c) => c.calleeIdentifier === '"hello".toUpperCase',
      );
      assert.ok(toUpperCaseCall, "Should extract toUpperCase call");
      assert.strictEqual(toUpperCaseCall.callType, "method");
    });

    it("should identify this calls", () => {
      const filePath = resolve(fixturesDir, "calls.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      assert.ok(calls.length > 0, "Should extract calls");
    });

    it("should identify super calls", () => {
      const filePath = resolve(fixturesDir, "calls.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const superCall = calls.find(
        (c) => c.calleeIdentifier === "super.parentMethod",
      );
      assert.ok(superCall, "Should extract super.parentMethod call");
      assert.strictEqual(superCall.callType, "method");
    });

    it("should resolve calls to symbols in same file", () => {
      const filePath = resolve(fixturesDir, "calls.java");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const nestedMethodCall = calls.find(
        (c) => c.calleeIdentifier === "nestedMethod",
      );
      assert.ok(nestedMethodCall, "Should extract nestedMethod call");
      assert.strictEqual(nestedMethodCall.isResolved, true);
      assert.ok(
        nestedMethodCall.calleeSymbolId?.endsWith("nestedMethod:method"),
        "Should resolve to nestedMethod symbol",
      );
    });
  });
});
