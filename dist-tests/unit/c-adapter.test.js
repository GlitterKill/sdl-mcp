import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAdapter } from "../../dist/indexer/adapter/c.js";
describe("C Adapter", () => {
    const adapter = new CAdapter();
    describe("ML2-C1.1: Symbol Extraction", () => {
        it("should extract function definitions with parameters", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/symbols.c"), "utf-8");
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.c");
            const addFunc = symbols.find((s) => s.name === "add_numbers");
            assert.ok(addFunc, "Should extract add_numbers function");
            assert.strictEqual(addFunc?.kind, "function");
            assert.strictEqual(addFunc?.exported, true);
            assert.ok(addFunc?.signature);
            assert.strictEqual(addFunc?.signature?.params.length, 2);
            assert.strictEqual(addFunc?.signature?.params[0].name, "a");
            assert.strictEqual(addFunc?.signature?.params[0].type, "int");
            assert.strictEqual(addFunc?.signature?.returns, "int");
        });
        it("should extract functions with void parameters", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/symbols.c"), "utf-8");
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.c");
            const simpleFunc = symbols.find((s) => s.name === "simple_function");
            assert.ok(simpleFunc, "Should extract simple_function");
            assert.strictEqual(simpleFunc?.kind, "function");
            assert.strictEqual(simpleFunc?.signature?.params.length, 0);
            assert.strictEqual(simpleFunc?.signature?.returns, "void");
        });
        it("should extract functions with pointer parameters", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/symbols.c"), "utf-8");
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.c");
            const printPoint = symbols.find((s) => s.name === "print_point");
            assert.ok(printPoint, "Should extract print_point function");
            assert.strictEqual(printPoint?.signature?.params[0].name, "p");
            assert.strictEqual(printPoint?.signature?.params[0].type, "Point");
            const processData = symbols.find((s) => s.name === "process_data");
            assert.ok(processData, "Should extract process_data function");
            assert.strictEqual(processData?.signature?.params[0].type, "const");
        });
        it("should extract struct specifiers", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/symbols.h"), "utf-8");
            const tree = adapter.parse(content, "test.h");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.h");
            const pointStructs = symbols.filter((s) => s.name === "Point");
            assert.ok(pointStructs.length >= 1, "Should extract Point struct");
            const pointStruct = pointStructs.find((s) => s.kind === "class");
            assert.ok(pointStruct, "Should have Point struct with kind 'class'");
        });
        it("should extract enum specifiers with values", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/symbols.h"), "utf-8");
            const tree = adapter.parse(content, "test.h");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.h");
            const statusEnums = symbols.filter((s) => s.name === "Status");
            assert.ok(statusEnums.length >= 1, "Should extract Status enum");
            const statusEnum = statusEnums.find((s) => s.kind === "class");
            assert.ok(statusEnum, "Should have Status enum with kind 'class'");
        });
        it("should extract typedef declarations", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/symbols.h"), "utf-8");
            const tree = adapter.parse(content, "test.h");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.h");
            const statusCodeType = symbols.find((s) => s.name === "StatusCode");
            assert.ok(statusCodeType, "Should extract StatusCode typedef");
            assert.strictEqual(statusCodeType?.kind, "type");
            const customDataType = symbols.find((s) => s.name === "CustomData");
            assert.ok(customDataType, "Should extract CustomData typedef");
            assert.strictEqual(customDataType?.kind, "type");
            const callbackType = symbols.find((s) => s.name === "Callback");
            assert.ok(callbackType, "Should extract Callback typedef");
            assert.strictEqual(callbackType?.kind, "type");
        });
        it("should extract anonymous typedefs", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/symbols.h"), "utf-8");
            const tree = adapter.parse(content, "test.h");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.h");
            const bufferType = symbols.find((s) => s.name === "Buffer");
            assert.ok(bufferType, "Should extract Buffer typedef");
            assert.strictEqual(bufferType?.kind, "type");
        });
    });
    describe("ML2-C1.2: Import Extraction", () => {
        it("should extract system includes", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/imports.c"), "utf-8");
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.c");
            const stdioImport = imports.find((imp) => imp.specifier === "stdio.h");
            assert.ok(stdioImport, "Should find stdio.h");
            assert.strictEqual(stdioImport?.isExternal, true);
            assert.strictEqual(stdioImport?.isRelative, false);
            const sysTypesImport = imports.find((imp) => imp.specifier === "sys/types.h");
            assert.ok(sysTypesImport, "Should find sys/types.h");
            assert.strictEqual(sysTypesImport?.isExternal, true);
        });
        it("should extract local includes", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/imports.c"), "utf-8");
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.c");
            const localImport = imports.find((imp) => imp.specifier === "local_header.h");
            assert.ok(localImport, "Should find local_header.h");
            assert.strictEqual(localImport?.isExternal, false);
            assert.strictEqual(localImport?.isRelative, false);
        });
        it("should extract relative includes", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/imports.c"), "utf-8");
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.c");
            const parentImport = imports.find((imp) => imp.specifier === "../parent/relative.h");
            assert.ok(parentImport, "Should find ../parent/relative.h");
            assert.strictEqual(parentImport?.isExternal, false);
            assert.strictEqual(parentImport?.isRelative, true);
            const utilsImport = imports.find((imp) => imp.specifier === "utils/helper.h");
            assert.ok(utilsImport, "Should find utils/helper.h");
            assert.strictEqual(utilsImport?.isExternal, false);
            assert.strictEqual(utilsImport?.isRelative, false);
        });
    });
    describe("ML2-C1.3: Call Extraction", () => {
        it("should extract function calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/calls.c"), "utf-8");
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.c");
            const calls = adapter.extractCalls(tree, content, "test.c", symbols);
            const addNumbersCall = calls.find((c) => c.calleeIdentifier === "add_numbers");
            assert.ok(addNumbersCall, "Should find add_numbers call");
            assert.strictEqual(addNumbersCall?.callType, "function");
        });
        it("should extract pointer field access calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/calls.c"), "utf-8");
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.c");
            const calls = adapter.extractCalls(tree, content, "test.c", symbols);
            const printPointCall = calls.find((c) => c.calleeIdentifier === "print_point");
            assert.ok(printPointCall, "Should find print_point calls");
            assert.ok(calls.filter((c) => c.calleeIdentifier === "print_point").length >= 2, "Should have at least 2 print_point calls");
        });
        it("should extract malloc call", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/calls.c"), "utf-8");
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.c");
            const calls = adapter.extractCalls(tree, content, "test.c", symbols);
            const mallocCall = calls.find((c) => c.calleeIdentifier === "malloc");
            assert.ok(mallocCall, "Should find malloc call");
        });
        it("should extract free call", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/calls.c"), "utf-8");
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.c");
            const calls = adapter.extractCalls(tree, content, "test.c", symbols);
            const freeCall = calls.find((c) => c.calleeIdentifier === "free");
            assert.ok(freeCall, "Should find free call");
        });
    });
    describe("ML2-C1.4: Golden Files", () => {
        it("should match expected symbols.h output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/symbols.h"), "utf-8");
            const tree = adapter.parse(content, "symbols.h");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "tests/fixtures/c/symbols.h");
            assert.strictEqual(symbols.length, 14, "Should extract 14 symbols");
            const typedefs = symbols.filter((s) => s.kind === "type");
            assert.strictEqual(typedefs.length, 7, "Should have 7 typedefs");
            const structs = symbols.filter((s) => s.kind === "class");
            assert.strictEqual(structs.length, 7, "Should have 7 structs/enums");
        });
        it("should match expected symbols.c output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/symbols.c"), "utf-8");
            const tree = adapter.parse(content, "symbols.c");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "tests/fixtures/c/symbols.c");
            assert.strictEqual(symbols.length, 9, "Should extract 9 function symbols");
        });
        it("should match expected imports output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/imports.c"), "utf-8");
            const tree = adapter.parse(content, "imports.c");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "imports.c");
            assert.strictEqual(imports.length, 8, "Should extract 8 imports");
            const systemImports = imports.filter((imp) => imp.isExternal);
            assert.strictEqual(systemImports.length, 5, "Should have 5 system imports");
            const localImports = imports.filter((imp) => !imp.isExternal);
            assert.strictEqual(localImports.length, 3, "Should have 3 local imports");
            const relativeImports = imports.filter((imp) => imp.isRelative);
            assert.strictEqual(relativeImports.length, 1, "Should have 1 relative import (only ../parent/)");
        });
        it("should match expected calls output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/c/calls.c"), "utf-8");
            const tree = adapter.parse(content, "calls.c");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "calls.c");
            const calls = adapter.extractCalls(tree, content, "calls.c", symbols);
            assert.ok(calls.length >= 10, "Should extract at least 10 calls");
        });
    });
    describe("Edge Cases", () => {
        it("should handle macros as unresolved calls", () => {
            const content = `
#include <stdio.h>

#define MAX(a, b) ((a) > (b) ? (a) : (b))

int main() {
    int x = MAX(10, 20);
    printf("%d\\n", x);
    return 0;
}
      `;
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.c");
            const calls = adapter.extractCalls(tree, content, "test.c", symbols);
            const printfCall = calls.find((c) => c.calleeIdentifier === "printf");
            assert.ok(printfCall, "Should find printf call");
            const maxCall = calls.find((c) => c.calleeIdentifier === "MAX");
            assert.ok(maxCall, "Macros may be extracted as calls (tree-sitter limitation)");
        });
        it("should handle function pointers", () => {
            const content = `
typedef int (*Callback)(int);

void register_callback(Callback cb) {
    cb(42);
}

int my_callback(int value) {
    return value * 2;
}

int main() {
    register_callback(my_callback);
    return 0;
}
      `;
            const tree = adapter.parse(content, "test.c");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.c");
            const calls = adapter.extractCalls(tree, content, "test.c", symbols);
            const registerCbCall = calls.find((c) => c.calleeIdentifier === "register_callback");
            assert.ok(registerCbCall, "Should find register_callback call");
        });
    });
});
//# sourceMappingURL=c-adapter.test.js.map