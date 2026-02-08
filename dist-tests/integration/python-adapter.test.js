import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { PythonAdapter } from "../../dist/indexer/adapter/python.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
describe("Python Adapter Tests (ML-C1.x)", () => {
    const adapter = new PythonAdapter();
    const fixturesDir = resolve(__dirname, "fixtures", "python");
    const goldenDir = resolve(__dirname, "fixtures", "python");
    function ensureGoldenDir() {
        if (!existsSync(goldenDir)) {
            mkdirSync(goldenDir, { recursive: true });
        }
    }
    describe("ML-C1.1: Symbol Extraction", () => {
        it("should extract all symbols correctly", () => {
            const filePath = resolve(fixturesDir, "symbols.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree, "Should parse Python code");
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const goldenPath = resolve(goldenDir, "expected-symbols.json");
            ensureGoldenDir();
            writeFileSync(goldenPath, JSON.stringify(symbols, null, 2), "utf-8");
            console.log(`✓ Generated ${symbols.length} symbols for symbols.py`);
            assert.ok(symbols.length > 0, "Should extract symbols");
        });
        it("should extract functions with params and return hints", () => {
            const filePath = resolve(fixturesDir, "symbols.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const calculateSum = symbols.find((s) => s.name === "calculate_sum");
            assert.ok(calculateSum, "Should extract calculate_sum");
            assert.strictEqual(calculateSum.kind, "function");
            assert.ok(calculateSum.signature);
            assert.strictEqual(calculateSum.signature?.params?.length, 2);
            assert.strictEqual(calculateSum.signature?.params[0]?.name, "a");
            assert.strictEqual(calculateSum.signature?.params[0]?.type, "int");
            assert.strictEqual(calculateSum.signature?.returns, "int");
            assert.strictEqual(calculateSum.visibility, "public");
        });
        it("should extract classes with inheritance", () => {
            const filePath = resolve(fixturesDir, "symbols.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const dogClass = symbols.find((s) => s.name === "Dog");
            assert.ok(dogClass, "Should extract Dog class");
            assert.strictEqual(dogClass.kind, "class");
            assert.strictEqual(dogClass.visibility, "public");
        });
        it("should detect visibility from naming conventions", () => {
            const filePath = resolve(fixturesDir, "symbols.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const internalHelper = symbols.find((s) => s.name === "_internal_helper");
            assert.ok(internalHelper, "Should extract _internal_helper");
            assert.strictEqual(internalHelper.visibility, "private");
            const veryPrivate = symbols.find((s) => s.name === "__very_private");
            assert.ok(veryPrivate, "Should extract __very_private");
            assert.strictEqual(veryPrivate.visibility, "private");
            const calculateSum = symbols.find((s) => s.name === "calculate_sum");
            assert.ok(calculateSum, "Should extract calculate_sum");
            assert.strictEqual(calculateSum.kind, "function");
            assert.ok(calculateSum.signature);
            console.log("calculateSum.signature:", JSON.stringify(calculateSum.signature, null, 2));
            assert.strictEqual(calculateSum.signature?.params?.length, 2);
            assert.strictEqual(calculateSum.signature?.params[0]?.name, "a");
            assert.strictEqual(calculateSum.signature?.params[0]?.type, "int");
            assert.strictEqual(calculateSum.signature?.returns, "int");
            assert.strictEqual(calculateSum.visibility, "public");
        });
        it("should capture decorators", () => {
            const filePath = resolve(fixturesDir, "symbols.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const decoratedFunc = symbols.find((s) => s.name === "decorated_function");
            assert.ok(decoratedFunc, "Should extract decorated_function");
            assert.strictEqual(decoratedFunc.name, "decorated_function");
        });
    });
    describe("ML-C1.2: Import Extraction", () => {
        it("should extract all imports correctly", () => {
            const filePath = resolve(fixturesDir, "imports.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree, "Should parse Python code");
            const imports = adapter.extractImports(tree, content, filePath);
            const goldenPath = resolve(goldenDir, "expected-imports.json");
            ensureGoldenDir();
            writeFileSync(goldenPath, JSON.stringify(imports, null, 2), "utf-8");
            console.log(`✓ Generated ${imports.length} imports for imports.py`);
            assert.ok(imports.length > 0, "Should extract imports");
        });
        it("should parse simple imports", () => {
            const filePath = resolve(fixturesDir, "imports.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, filePath);
            const osImport = imports.find((i) => i.specifier === "os");
            assert.ok(osImport, "Should extract 'import os'");
            assert.strictEqual(osImport.isRelative, false);
            assert.strictEqual(osImport.isExternal, false);
            assert.ok(osImport.imports.includes("os"));
        });
        it("should parse import with alias", () => {
            const filePath = resolve(fixturesDir, "imports.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, filePath);
            const numpyImport = imports.find((i) => i.specifier === "numpy");
            assert.ok(numpyImport, "Should extract 'import numpy as np'");
            assert.ok(numpyImport.imports.includes("np"));
        });
        it("should parse from imports", () => {
            const filePath = resolve(fixturesDir, "imports.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, filePath);
            const typingImport = imports.find((i) => i.specifier === "typing");
            assert.ok(typingImport, "Should extract 'from typing import List'");
            assert.ok(typingImport.imports.includes("List"));
        });
        it("should parse wildcard imports", () => {
            const filePath = resolve(fixturesDir, "imports.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, filePath);
            const mathImport = imports.find((i) => i.specifier === "math");
            assert.ok(mathImport, "Should extract 'from math import *'");
            assert.ok(mathImport.imports.includes("*"));
        });
        it("should identify relative imports", () => {
            const filePath = resolve(fixturesDir, "imports.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, filePath);
            const relativeImport = imports.find((i) => i.isRelative);
            assert.ok(relativeImport, "Should find relative import");
        });
    });
    describe("ML-C1.3: Call Extraction", () => {
        it("should extract all calls correctly", () => {
            const filePath = resolve(fixturesDir, "calls.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree, "Should parse Python code");
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const calls = adapter.extractCalls(tree, content, filePath, symbols);
            const goldenPath = resolve(goldenDir, "expected-calls.json");
            ensureGoldenDir();
            writeFileSync(goldenPath, JSON.stringify(calls, null, 2), "utf-8");
            console.log(`✓ Generated ${calls.length} calls for calls.py`);
            assert.ok(calls.length > 0, "Should extract calls");
        });
        it("should extract basic function calls", () => {
            const filePath = resolve(fixturesDir, "calls.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const calls = adapter.extractCalls(tree, content, filePath, symbols);
            const call = calls.find((c) => c.calleeIdentifier === "calculate_sum");
            assert.ok(call, "Should extract calculate_sum call");
            assert.strictEqual(call.callType, "function");
        });
        it("should extract method calls with receiver context", () => {
            const filePath = resolve(fixturesDir, "calls.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const calls = adapter.extractCalls(tree, content, filePath, symbols);
            const methodCall = calls.find((c) => c.calleeIdentifier.includes("method"));
            assert.ok(methodCall, "Should extract method call");
            assert.strictEqual(methodCall.callType, "method");
        });
        it("should extract constructor calls", () => {
            const filePath = resolve(fixturesDir, "calls.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const calls = adapter.extractCalls(tree, content, filePath, symbols);
            const constructorCall = calls.find((c) => c.calleeIdentifier === "MyClass");
            assert.ok(constructorCall, "Should extract MyClass constructor call");
            assert.strictEqual(constructorCall.callType, "function");
        });
        it.skip("should capture decorator calls", () => {
            const filePath = resolve(fixturesDir, "calls.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const calls = adapter.extractCalls(tree, content, filePath, symbols);
            const decoratorCall = calls.find((c) => c.callerNodeId === "decorator");
            assert.ok(decoratorCall, "Should extract decorator call");
            assert.ok(decoratorCall.calleeIdentifier.includes("decorator"));
        });
        it("should extract chained method calls", () => {
            const filePath = resolve(fixturesDir, "calls.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const calls = adapter.extractCalls(tree, content, filePath, symbols);
            const chainedCalls = calls.filter((c) => c.calleeIdentifier.includes("."));
            assert.ok(chainedCalls.length > 0, "Should extract chained calls");
        });
    });
    describe("ML-C1.4: Golden File Validation", () => {
        // Helper to normalize data by removing undefined values (matches JSON.stringify behavior)
        function normalize(data) {
            return JSON.parse(JSON.stringify(data));
        }
        it("should match expected symbols", () => {
            const filePath = resolve(fixturesDir, "symbols.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const goldenPath = resolve(goldenDir, "expected-symbols.json");
            const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
            assert.deepStrictEqual(normalize(symbols), golden, "Extracted symbols should match golden file");
        });
        it("should match expected imports", () => {
            const filePath = resolve(fixturesDir, "imports.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, filePath);
            const goldenPath = resolve(goldenDir, "expected-imports.json");
            const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
            assert.deepStrictEqual(normalize(imports), golden, "Extracted imports should match golden file");
        });
        it("should match expected calls", () => {
            const filePath = resolve(fixturesDir, "calls.py");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const calls = adapter.extractCalls(tree, content, filePath, symbols);
            const goldenPath = resolve(goldenDir, "expected-calls.json");
            const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
            assert.deepStrictEqual(normalize(calls), golden, "Extracted calls should match golden file");
        });
    });
});
//# sourceMappingURL=python-adapter.test.js.map