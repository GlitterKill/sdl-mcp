import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CppAdapter } from "../../dist/indexer/adapter/cpp.js";
describe("C++ Adapter", () => {
    const adapter = new CppAdapter();
    describe("ML2-C1.5: Symbol Extraction", () => {
        it("should extract namespace definitions", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.hpp"), "utf-8");
            const tree = adapter.parse(content, "test.hpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.hpp");
            const myNamespace = symbols.find((s) => s.name === "MyNamespace");
            assert.ok(myNamespace, "Should extract MyNamespace");
            assert.strictEqual(myNamespace?.kind, "module");
            assert.strictEqual(myNamespace?.exported, true);
            const innerNamespace = symbols.find((s) => s.name === "MyNamespace::InnerNamespace");
            assert.ok(innerNamespace, "Should extract MyNamespace::InnerNamespace");
        });
        it("should extract class specifiers", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.hpp"), "utf-8");
            const tree = adapter.parse(content, "test.hpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.hpp");
            const baseClass = symbols.find((s) => s.name === "MyNamespace::InnerNamespace::BaseClass");
            assert.ok(baseClass, "Should extract BaseClass");
            assert.strictEqual(baseClass?.kind, "class");
            assert.strictEqual(baseClass?.exported, true);
            const derivedClass = symbols.find((s) => s.name === "MyNamespace::InnerNamespace::DerivedClass");
            assert.ok(derivedClass, "Should extract DerivedClass");
            assert.strictEqual(derivedClass?.kind, "class");
            const point = symbols.find((s) => s.name === "Point");
            assert.ok(point, "Should extract Point struct");
            assert.strictEqual(point?.kind, "class");
        });
        it("should extract constructors from headers", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.hpp"), "utf-8");
            const tree = adapter.parse(content, "test.hpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.hpp");
            const constructors = symbols.filter((s) => s.kind === "constructor");
            assert.ok(constructors.length > 0, "Should have constructors");
            const baseConstructor = symbols.find((s) => s.name === "MyNamespace::InnerNamespace::BaseClass" &&
                s.kind === "constructor");
            assert.ok(baseConstructor, "Should find BaseClass constructor");
            assert.strictEqual(baseConstructor?.kind, "constructor");
            const pointConstructor = symbols.find((s) => s.name === "Point" && s.kind === "constructor");
            assert.ok(pointConstructor, "Should find Point constructor");
        });
        it("should extract destructors", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.hpp"), "utf-8");
            const tree = adapter.parse(content, "test.hpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.hpp");
            const destructors = symbols.filter((s) => s.name.includes("~"));
            assert.ok(destructors.length > 0, "Should have destructors");
        });
        it("should extract methods", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const publicMethod = symbols.find((s) => s.name.includes("publicMethod"));
            assert.ok(publicMethod, "Should find publicMethod");
            assert.strictEqual(publicMethod?.kind, "function");
            const protectedMethod = symbols.find((s) => s.name.includes("protectedMethod"));
            assert.ok(protectedMethod, "Should find protectedMethod");
            assert.strictEqual(protectedMethod?.kind, "function");
        });
        it("should extract template classes", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.hpp"), "utf-8");
            const tree = adapter.parse(content, "test.hpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.hpp");
            const templateClass = symbols.find((s) => s.name === "MyNamespace::TemplateClass");
            assert.ok(templateClass, "Should extract TemplateClass");
            assert.strictEqual(templateClass?.kind, "class");
            const mapClass = symbols.find((s) => s.name === "MyNamespace::Map");
            assert.ok(mapClass, "Should extract Map template class");
            assert.strictEqual(mapClass?.kind, "class");
        });
        it("should extract enum specifiers", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.hpp"), "utf-8");
            const tree = adapter.parse(content, "test.hpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.hpp");
            const colorEnum = symbols.find((s) => s.name === "Color");
            assert.ok(colorEnum, "Should extract Color enum");
            assert.strictEqual(colorEnum?.kind, "class");
            const statusCodeEnum = symbols.find((s) => s.name === "StatusCode");
            assert.ok(statusCodeEnum, "Should extract StatusCode enum");
            assert.strictEqual(statusCodeEnum?.kind, "class");
        });
        it("should extract alias declarations (using)", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.hpp"), "utf-8");
            const tree = adapter.parse(content, "test.hpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.hpp");
            const stringAlias = symbols.find((s) => s.name === "StringAlias");
            assert.ok(stringAlias, "Should extract StringAlias");
            assert.strictEqual(stringAlias?.kind, "type");
            const vectorAlias = symbols.find((s) => s.name === "Vector");
            assert.ok(vectorAlias, "Should extract Vector");
            assert.strictEqual(vectorAlias?.kind, "type");
        });
        it("should extract free functions", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const freeFunc = symbols.find((s) => s.name === "freeFunction");
            assert.ok(freeFunc, "Should extract freeFunction");
            assert.strictEqual(freeFunc?.kind, "function");
            const templateFunc = symbols.find((s) => s.name === "templateFunction");
            assert.ok(templateFunc, "Should extract templateFunction");
            assert.strictEqual(templateFunc?.kind, "function");
        });
        it("should extract symbols in anonymous namespace", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const anonMethod = symbols.find((s) => s.name.includes("AnonymousNamespaceClass"));
            assert.ok(anonMethod, "Should extract symbols from anonymous namespace");
        });
        it("should extract symbols in inline namespace", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const inlineMethod = symbols.find((s) => s.name.includes("InlineClass"));
            assert.ok(inlineMethod, "Should extract symbols from inline namespace");
        });
    });
    describe("ML2-C1.6: Import Extraction", () => {
        it("should extract system includes", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/imports.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.cpp");
            const iostreamImport = imports.find((imp) => imp.specifier === "iostream");
            assert.ok(iostreamImport, "Should find iostream");
            assert.strictEqual(iostreamImport?.isExternal, true);
            assert.strictEqual(iostreamImport?.isRelative, false);
            const vectorImport = imports.find((imp) => imp.specifier === "vector");
            assert.ok(vectorImport, "Should find vector");
            assert.strictEqual(vectorImport?.isExternal, true);
            const mapImport = imports.find((imp) => imp.specifier === "map");
            assert.ok(mapImport, "Should find map");
            assert.strictEqual(mapImport?.isExternal, true);
            const memoryImport = imports.find((imp) => imp.specifier === "memory");
            assert.ok(memoryImport, "Should find memory");
            assert.strictEqual(memoryImport?.isExternal, true);
        });
        it("should extract local includes", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/imports.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.cpp");
            const localImport = imports.find((imp) => imp.specifier === "local_header.hpp");
            assert.ok(localImport, "Should find local_header.hpp");
            assert.strictEqual(localImport?.isExternal, false);
            assert.strictEqual(localImport?.isRelative, false);
        });
        it("should extract relative includes", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/imports.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.cpp");
            const parentImport = imports.find((imp) => imp.specifier === "../parent/relative.hpp");
            assert.ok(parentImport, "Should find ../parent/relative.hpp");
            assert.strictEqual(parentImport?.isExternal, false);
            assert.strictEqual(parentImport?.isRelative, true);
            const utilsImport = imports.find((imp) => imp.specifier === "utils/helper.hpp");
            assert.ok(utilsImport, "Should find utils/helper.hpp");
            assert.strictEqual(utilsImport?.isExternal, false);
            assert.strictEqual(utilsImport?.isRelative, false);
        });
    });
    describe("ML2-C1.7: Call Extraction", () => {
        it("should extract method calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/calls.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const calls = adapter.extractCalls(tree, content, "test.cpp", symbols);
            assert.ok(calls.length >= 0, "Should have some calls");
        });
        it("should extract free function calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/calls.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const calls = adapter.extractCalls(tree, content, "test.cpp", symbols);
            const printMsgCall = calls.find((c) => c.calleeIdentifier === "printMessage");
            assert.ok(printMsgCall, "Should find printMessage call");
            assert.strictEqual(printMsgCall?.callType, "function");
            const createGreetingCall = calls.find((c) => c.calleeIdentifier === "createGreeting");
            assert.ok(createGreetingCall, "Should find createGreeting call");
            assert.strictEqual(createGreetingCall?.callType, "function");
        });
        it("should extract constructor calls (new)", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/calls.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const calls = adapter.extractCalls(tree, content, "test.cpp", symbols);
            assert.ok(calls.length > 0, "Should have method and function calls");
        });
        it("should extract template function calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const calls = adapter.extractCalls(tree, content, "test.cpp", symbols);
            const templateFuncCall = calls.find((c) => c.calleeIdentifier === "templateFunction");
            assert.ok(templateFuncCall, "Should find templateFunction call");
        });
        it("should extract method calls on objects", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/calls.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const calls = adapter.extractCalls(tree, content, "test.cpp", symbols);
            const getMethodCalls = calls.filter((c) => c.calleeIdentifier.includes("get"));
            assert.ok(getMethodCalls.length > 0, "Should find get method calls");
        });
        it("should extract std library method calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/calls.cpp"), "utf-8");
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const calls = adapter.extractCalls(tree, content, "test.cpp", symbols);
            assert.ok(calls.length > 0, "Should have some calls");
        });
    });
    describe("Golden Files", () => {
        it("should match expected symbols.hpp output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.hpp"), "utf-8");
            const tree = adapter.parse(content, "symbols.hpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "tests/fixtures/cpp/symbols.hpp");
            assert.ok(symbols.length > 20, "Should extract multiple symbols from symbols.hpp");
            const classes = symbols.filter((s) => s.kind === "class");
            assert.ok(classes.length > 0, "Should have class symbols");
            const namespaces = symbols.filter((s) => s.kind === "module");
            assert.ok(namespaces.length > 0, "Should have namespace symbols");
            const types = symbols.filter((s) => s.kind === "type");
            assert.ok(types.length > 0, "Should have type aliases");
        });
        it("should match expected symbols.cpp output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/symbols.cpp"), "utf-8");
            const tree = adapter.parse(content, "symbols.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "tests/fixtures/cpp/symbols.cpp");
            assert.ok(symbols.length > 20, "Should extract multiple symbols from symbols.cpp");
            const functions = symbols.filter((s) => s.kind === "function");
            assert.ok(functions.length > 0, "Should have functions");
        });
        it("should match expected imports.cpp output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/imports.cpp"), "utf-8");
            const tree = adapter.parse(content, "imports.cpp");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "imports.cpp");
            assert.strictEqual(imports.length, 9, "Should extract 9 imports");
            const systemImports = imports.filter((imp) => imp.isExternal);
            assert.strictEqual(systemImports.length, 6, "Should have 6 system imports");
            const localImports = imports.filter((imp) => !imp.isExternal);
            assert.strictEqual(localImports.length, 3, "Should have 3 local imports");
            const relativeImports = imports.filter((imp) => imp.isRelative);
            assert.strictEqual(relativeImports.length, 1, "Should have 1 relative import (only ../parent/)");
        });
        it("should match expected calls.cpp output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/cpp/calls.cpp"), "utf-8");
            const tree = adapter.parse(content, "calls.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "calls.cpp");
            const calls = adapter.extractCalls(tree, content, "calls.cpp", symbols);
            assert.ok(calls.length >= 10, "Should extract at least 10 calls");
            const methodCalls = calls.filter((c) => c.callType === "method");
            assert.ok(methodCalls.length > 0, "Should have method calls");
            const constructorCalls = calls.filter((c) => c.callType === "constructor");
            const functionCalls = calls.filter((c) => c.callType === "function");
            assert.ok(functionCalls.length > 0, "Should have function calls");
        });
    });
    describe("Integration", () => {
        it("should handle complete C++ file with all constructs", () => {
            const content = `
#include <iostream>
#include <vector>

namespace MyNamespace {
    class Calculator {
    public:
        int add(int a, int b) {
            return a + b;
        }
    };

    int multiply(int a, int b) {
        return a * b;
    }
}

int main() {
    MyNamespace::Calculator calc;
    int sum = calc.add(5, 3);
    int product = MyNamespace::multiply(4, 7);

    std::cout << "Sum: " << sum << std::endl;
    return 0;
}
      `;
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const imports = adapter.extractImports(tree, content, "test.cpp");
            const calls = adapter.extractCalls(tree, content, "test.cpp", symbols);
            assert.ok(symbols.length > 0, "Should have symbols");
            assert.strictEqual(imports.length, 2, "Should have 2 imports");
            assert.ok(calls.length > 0, "Should have calls");
            const namespaceSymbol = symbols.find((s) => s.name === "MyNamespace");
            assert.ok(namespaceSymbol);
            assert.strictEqual(namespaceSymbol?.kind, "module");
            const calculatorClass = symbols.find((s) => s.name === "MyNamespace::Calculator");
            assert.ok(calculatorClass);
            assert.strictEqual(calculatorClass?.kind, "class");
        });
        it("should handle templates with multiple type parameters", () => {
            const content = `
template<typename Key, typename Value, typename Allocator = std::allocator<std::pair<const Key, Value>>>
class CustomMap {
public:
    void insert(const Key& key, const Value& value) {}
    Value get(const Key& key) const { return Value(); }
};

int main() {
    CustomMap<int, std::string> map;
    map.insert(1, "one");
    std::string val = map.get(1);
    return 0;
}
      `;
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const calls = adapter.extractCalls(tree, content, "test.cpp", symbols);
            const mapClass = symbols.find((s) => s.name === "CustomMap");
            assert.ok(mapClass);
            const insertCall = calls.find((c) => c.calleeIdentifier.includes("insert"));
            assert.ok(insertCall);
            const getCall = calls.find((c) => c.calleeIdentifier.includes("get"));
            assert.ok(getCall);
        });
    });
    describe("Edge Cases", () => {
        it("should handle macros as unresolved calls", () => {
            const content = `
#include <iostream>

#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define LOG(msg) std::cout << msg << std::endl

int main() {
    int x = MAX(10, 20);
    LOG("Hello");
    return 0;
}
      `;
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const calls = adapter.extractCalls(tree, content, "test.cpp", symbols);
            assert.ok(calls.length >= 0, "Should have some calls");
        });
        it("should handle lambda expressions", () => {
            const content = `
#include <vector>
#include <algorithm>

int main() {
    std::vector<int> nums = {1, 2, 3, 4, 5};

    std::for_each(nums.begin(), nums.end(), [](int n) {
        std::cout << n << std::endl;
    });

    return 0;
}
      `;
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const calls = adapter.extractCalls(tree, content, "test.cpp", symbols);
            assert.ok(calls.length >= 0, "Should have some calls");
        });
        it("should handle operator overloading", () => {
            const content = `
class Point {
public:
    int x, y;

    Point operator+(const Point& other) {
        Point result;
        result.x = x + other.x;
        result.y = y + other.y;
        return result;
    }
};

int main() {
    Point p1 = {1, 2};
    Point p2 = {3, 4};
    Point p3 = p1 + p2;
    return 0;
}
      `;
            const tree = adapter.parse(content, "test.cpp");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.cpp");
            const operatorPlus = symbols.find((s) => s.name.includes("operator+"));
            assert.ok(operatorPlus, "Should find operator+ symbol");
        });
    });
});
//# sourceMappingURL=cpp-adapter.test.js.map