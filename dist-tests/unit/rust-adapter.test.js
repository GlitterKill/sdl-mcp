import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RustAdapter } from "../../dist/indexer/adapter/rust.js";
describe("Rust Adapter", () => {
    const adapter = new RustAdapter();
    describe("ML2-C3.2: Import Extraction", () => {
        it("should extract use statements with simple path", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/imports.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.rs");
            const stdHashMap = imports.find((imp) => imp.specifier === "std::collections::HashMap");
            assert.ok(stdHashMap, "Should find std::collections::HashMap import");
            assert.strictEqual(stdHashMap?.imports[0], "HashMap");
            assert.strictEqual(stdHashMap?.isExternal, true);
            assert.strictEqual(stdHashMap?.isRelative, false);
        });
        it("should extract wildcard imports", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/imports.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.rs");
            const wildcardImport = imports.find((imp) => imp.specifier === "std::io");
            assert.ok(wildcardImport, "Should find std::io import");
            assert.strictEqual(wildcardImport?.imports[0], "*");
        });
        it("should extract use statements with scoped list", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/imports.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.rs");
            const scopedList = imports.find((imp) => imp.specifier === "std::collections");
            assert.ok(scopedList, "Should find std::collections import");
            assert.ok(scopedList?.imports.includes("HashMap"), "Should include HashMap");
            assert.ok(scopedList?.imports.includes("HashSet"), "Should include HashSet");
        });
        it("should extract use statements with aliases", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/imports.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.rs");
            const aliasImport = imports.find((imp) => imp.specifier === "std::io::Result");
            assert.ok(aliasImport, "Should find std::io::Result import");
            assert.strictEqual(aliasImport?.imports[0], "IoResult");
        });
        it("should identify relative imports (self, super, crate)", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/imports.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.rs");
            const selfImport = imports.find((imp) => imp.specifier === "self::my_module::MyStruct");
            assert.ok(selfImport, "Should find self:: import");
            assert.strictEqual(selfImport?.isRelative, true);
            assert.strictEqual(selfImport?.isExternal, false);
            const superImport = imports.find((imp) => imp.specifier === "super::parent_module::ParentStruct");
            assert.ok(superImport, "Should find super:: import");
            assert.strictEqual(superImport?.isRelative, true);
            const crateImport = imports.find((imp) => imp.specifier === "crate::root_module::RootStruct");
            assert.ok(crateImport, "Should find crate:: import");
            assert.strictEqual(crateImport?.isRelative, true);
        });
        it("should extract module declarations (mod foo;)", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/imports.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.rs");
            const myModule = imports.find((imp) => imp.specifier === "my_module");
            assert.ok(myModule, "Should find my_module declaration");
            assert.strictEqual(myModule?.isRelative, true);
            assert.strictEqual(myModule?.isExternal, false);
            assert.strictEqual(myModule?.imports[0], "my_module");
            const internal = imports.find((imp) => imp.specifier === "internal");
            assert.ok(internal, "Should find internal module declaration");
            const utils = imports.find((imp) => imp.specifier === "utils");
            assert.ok(utils, "Should find utils module declaration");
        });
        it("should identify external crate uses", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/imports.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.rs");
            const serdeImport = imports.find((imp) => imp.specifier === "serde");
            assert.ok(serdeImport, "Should find serde import");
            assert.strictEqual(serdeImport?.isExternal, true);
            assert.strictEqual(serdeImport?.isRelative, false);
            const tokioImport = imports.find((imp) => imp.specifier === "tokio::runtime::Runtime");
            assert.ok(tokioImport, "Should find tokio::runtime::Runtime import");
            assert.strictEqual(tokioImport?.isExternal, true);
        });
        it("should extract re-exports", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/imports.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.rs");
            const reExport = imports.find((imp) => imp.specifier === "crate::my_module::PublicStruct");
            assert.ok(reExport, "Should find re-export");
        });
        it("should handle mixed use statements", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/imports.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.rs");
            const mixedImport = imports.find((imp) => imp.specifier === "std::collections::HashMap");
            assert.ok(mixedImport, "Should find HashMap import");
            assert.ok(imports.length > 0, "Should have imports");
        });
        it("should match expected imports output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/imports.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.rs");
            assert.ok(imports.length > 0, "Should extract imports");
            const useImports = imports.filter((imp) => !imp.isExternal && imp.specifier.includes("::"));
            assert.ok(useImports.length > 0, "Should have use statement imports");
            const modImports = imports.filter((imp) => !imp.specifier.includes("::") &&
                ["my_module", "internal", "utils"].includes(imp.specifier));
            assert.strictEqual(modImports.length, 3, "Should have 3 mod declarations");
            const externalImports = imports.filter((imp) => imp.isExternal);
            assert.ok(externalImports.length > 0, "Should have external crate imports");
        });
    });
    describe("ML2-C3.1: Symbol Extraction", () => {
        it("should extract module declarations", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/symbols.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const myModule = symbols.find((s) => s.name === "my_module");
            assert.ok(myModule, "Should extract my_module");
            assert.strictEqual(myModule?.kind, "module");
            assert.strictEqual(myModule?.exported, true);
            const inlineMod = symbols.find((s) => s.name === "inline_mod");
            assert.ok(inlineMod, "Should extract inline_mod");
            assert.strictEqual(inlineMod?.kind, "module");
        });
        it("should extract functions with parameters and return types", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/symbols.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const addFunc = symbols.find((s) => s.name === "add");
            assert.ok(addFunc, "Should extract add function");
            assert.strictEqual(addFunc?.kind, "function");
            assert.strictEqual(addFunc?.exported, true);
            assert.ok(addFunc?.signature);
            assert.strictEqual(addFunc?.signature?.params.length, 2);
            assert.strictEqual(addFunc?.signature?.returns, "i32");
            const multiplyFunc = symbols.find((s) => s.name === "multiply");
            assert.ok(multiplyFunc, "Should extract multiply function");
            assert.strictEqual(multiplyFunc?.exported, false);
        });
        it("should extract generic functions", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/symbols.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const identityFunc = symbols.find((s) => s.name === "identity");
            assert.ok(identityFunc, "Should extract identity function");
            assert.ok(identityFunc?.signature);
            assert.ok(identityFunc?.signature?.generics);
            assert.strictEqual(identityFunc?.signature?.generics?.length, 1);
        });
        it("should extract structs with fields", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/symbols.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const pointStruct = symbols.find((s) => s.name === "Point");
            assert.ok(pointStruct, "Should extract Point struct");
            assert.strictEqual(pointStruct?.kind, "class");
            assert.strictEqual(pointStruct?.exported, true);
            assert.ok(pointStruct?.signature);
            assert.strictEqual(pointStruct?.signature?.params.length, 2);
            const internalPoint = symbols.find((s) => s.name === "InternalPoint");
            assert.ok(internalPoint, "Should extract InternalPoint struct");
            assert.strictEqual(internalPoint?.exported, false);
        });
        it("should extract generic structs", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/symbols.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const boxStruct = symbols.find((s) => s.name === "Box");
            assert.ok(boxStruct, "Should extract Box struct");
            assert.ok(boxStruct?.signature);
            assert.ok(boxStruct?.signature?.generics);
            assert.strictEqual(boxStruct?.signature?.generics?.length, 1);
        });
        it("should extract enums with variants", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/symbols.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const directionEnum = symbols.find((s) => s.name === "Direction");
            assert.ok(directionEnum, "Should extract Direction enum");
            assert.strictEqual(directionEnum?.kind, "type");
            assert.strictEqual(directionEnum?.exported, true);
            assert.ok(directionEnum?.signature);
            assert.strictEqual(directionEnum?.signature?.params.length, 4);
            const messageEnum = symbols.find((s) => s.name === "Message");
            assert.ok(messageEnum, "Should extract Message enum");
            assert.ok(messageEnum?.signature);
        });
        it("should extract traits", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/symbols.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const drawableTrait = symbols.find((s) => s.name === "Drawable");
            assert.ok(drawableTrait, "Should extract Drawable trait");
            assert.strictEqual(drawableTrait?.kind, "interface");
            assert.strictEqual(drawableTrait?.exported, true);
            const containerTrait = symbols.find((s) => s.name === "Container");
            assert.ok(containerTrait, "Should extract Container trait");
            assert.ok(containerTrait?.signature);
            assert.ok(containerTrait?.signature?.generics);
        });
        it("should extract impl block methods", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/symbols.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const newMethod = symbols.find((s) => s.name === "new");
            assert.ok(newMethod, "Should extract new method");
            assert.strictEqual(newMethod?.kind, "method");
            const distanceMethod = symbols.find((s) => s.name === "distance_from_origin");
            assert.ok(distanceMethod, "Should extract distance_from_origin method");
            assert.strictEqual(distanceMethod?.kind, "method");
        });
        it("should extract type aliases", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/symbols.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const userIdAlias = symbols.find((s) => s.name === "UserId");
            assert.ok(userIdAlias, "Should extract UserId type alias");
            assert.strictEqual(userIdAlias?.kind, "type");
            assert.strictEqual(userIdAlias?.exported, true);
            const internalIdAlias = symbols.find((s) => s.name === "InternalId");
            assert.ok(internalIdAlias, "Should extract InternalId type alias");
            assert.strictEqual(internalIdAlias?.exported, false);
        });
        it("should extract visibility modifiers correctly", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/symbols.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const publicStruct = symbols.find((s) => s.name === "Point");
            assert.strictEqual(publicStruct?.exported, true);
            assert.strictEqual(publicStruct?.visibility, "public");
            const privateStruct = symbols.find((s) => s.name === "InternalPoint");
            assert.strictEqual(privateStruct?.exported, false);
            assert.strictEqual(privateStruct?.visibility, "private");
            const crateVisible = symbols.find((s) => s.name === "crate_internal");
            assert.ok(crateVisible, "Should find crate_internal function");
            assert.strictEqual(crateVisible?.visibility, "internal");
            const crateVisStruct = symbols.find((s) => s.name === "CrateVisibility");
            assert.ok(crateVisStruct, "Should find CrateVisibility struct");
            assert.strictEqual(crateVisStruct?.visibility, "public");
        });
    });
    describe("ML2-C3.3: Call Extraction", () => {
        it("should extract simple function calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/calls.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const calls = adapter.extractCalls(tree, content, "test.rs", symbols);
            const simpleCalls = calls.filter((c) => c.calleeIdentifier === "simple_function");
            assert.ok(simpleCalls.length >= 2, "Should find at least 2 calls to simple_function");
            assert.strictEqual(simpleCalls[0]?.callType, "function");
        });
        it("should extract method calls with receiver", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/calls.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const calls = adapter.extractCalls(tree, content, "test.rs", symbols);
            const distanceCalls = calls.filter((c) => c.calleeIdentifier.includes("distance"));
            assert.ok(distanceCalls.length > 0, "Should find method calls");
            assert.strictEqual(distanceCalls[0]?.callType, "method");
        });
        it("should extract associated function calls (Type::func)", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/calls.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const calls = adapter.extractCalls(tree, content, "test.rs", symbols);
            const pointNewCalls = calls.filter((c) => c.calleeIdentifier.includes("Point::new"));
            assert.ok(pointNewCalls.length > 0, "Should find Point::new calls");
            assert.strictEqual(pointNewCalls[0]?.callType, "function");
            const circleCalls = calls.filter((c) => c.calleeIdentifier.includes("Circle::from_radius"));
            assert.ok(circleCalls.length > 0, "Should find Circle::from_radius calls");
        });
        it("should extract chained method calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/calls.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const calls = adapter.extractCalls(tree, content, "test.rs", symbols);
            const pushCalls = calls.filter((c) => c.calleeIdentifier.includes("push"));
            assert.ok(pushCalls.length >= 3, "Should find multiple push calls");
            const lenCalls = calls.filter((c) => c.calleeIdentifier.includes("len"));
            assert.ok(lenCalls.length > 0, "Should find len call");
        });
        it("should extract macro invocations as unresolved", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/calls.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const calls = adapter.extractCalls(tree, content, "test.rs", symbols);
            const macroCalls = calls.filter((c) => c.calleeIdentifier.includes("!"));
            assert.ok(macroCalls.length > 0, "Should find macro calls");
            assert.strictEqual(macroCalls[0]?.isResolved, false);
            assert.strictEqual(macroCalls[0]?.callType, "dynamic");
            const printlnCalls = calls.filter((c) => c.calleeIdentifier === "println!");
            assert.ok(printlnCalls.length >= 2, "Should find println! calls");
        });
        it("should extract module-qualified calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/calls.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const calls = adapter.extractCalls(tree, content, "test.rs", symbols);
            const moduleCalls = calls.filter((c) => c.calleeIdentifier.includes("::"));
            assert.ok(moduleCalls.length > 0, "Should find module-qualified calls");
            assert.ok(moduleCalls.some((c) => c.calleeIdentifier.includes("Point::")), "Should have Point:: associated function calls");
        });
        it("should track caller context for calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/calls.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const calls = adapter.extractCalls(tree, content, "test.rs", symbols);
            const outerFunc = symbols.find((s) => s.name === "outer_function");
            assert.ok(outerFunc, "Should find outer_function");
            const callsInOuter = calls.filter((c) => c.callerNodeId === outerFunc?.nodeId);
            assert.ok(callsInOuter.length > 0, "Should have calls with caller context");
        });
    });
    describe("ML2-C3.4: Golden Files", () => {
        it("should match expected symbols output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/symbols.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            assert.strictEqual(symbols.length, 40, "Should extract 40 symbols from symbols.rs");
            const modules = symbols.filter((s) => s.kind === "module");
            assert.strictEqual(modules.length, 3, "Should have 3 modules");
            const functions = symbols.filter((s) => s.kind === "function");
            assert.strictEqual(functions.length, 8, "Should have 8 functions");
            const structs = symbols.filter((s) => s.kind === "class");
            assert.strictEqual(structs.length, 9, "Should have 9 structs");
            const types = symbols.filter((s) => s.kind === "type");
            assert.strictEqual(types.length, 8, "Should have 8 type declarations (type aliases + enums)");
            const traits = symbols.filter((s) => s.kind === "interface");
            assert.strictEqual(traits.length, 3, "Should have 3 traits");
            const methods = symbols.filter((s) => s.kind === "method");
            assert.strictEqual(methods.length, 9, "Should have 9 impl methods");
        });
        it("should match expected imports output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/imports.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.rs");
            assert.strictEqual(imports.length, 16, "Should extract 16 imports from imports.rs");
            const useImports = imports.filter((imp) => imp.specifier.includes("::"));
            assert.ok(useImports.length > 0, "Should have use statement imports");
            const modImports = imports.filter((imp) => !imp.specifier.includes("::") &&
                ["my_module", "internal", "utils"].includes(imp.specifier));
            assert.strictEqual(modImports.length, 3, "Should have 3 mod declarations");
            const wildcardImports = imports.filter((imp) => imp.imports.includes("*"));
            assert.ok(wildcardImports.length > 0, "Should have wildcard imports");
            const externalImports = imports.filter((imp) => imp.isExternal);
            assert.ok(externalImports.length > 0, "Should have external crate imports");
        });
        it("should match expected calls output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/rust/calls.rs"), "utf-8");
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const calls = adapter.extractCalls(tree, content, "test.rs", symbols);
            assert.ok(calls.length >= 30, "Should extract at least 30 calls");
            const functionCalls = calls.filter((c) => c.callType === "function");
            assert.ok(functionCalls.length > 10, "Should have function calls");
            const methodCalls = calls.filter((c) => c.callType === "method");
            assert.ok(methodCalls.length > 5, "Should have method calls");
            const macroCalls = calls.filter((c) => c.calleeIdentifier.includes("!"));
            assert.ok(macroCalls.length > 5, "Should have macro calls");
            assert.strictEqual(macroCalls[0]?.isResolved, false);
            const resolvedCalls = calls.filter((c) => c.isResolved);
            assert.ok(resolvedCalls.length > 0, "Should have resolved calls");
            const unresolvedCalls = calls.filter((c) => !c.isResolved);
            assert.ok(unresolvedCalls.length > 0, "Should have unresolved calls");
        });
    });
    describe("Integration", () => {
        it("should handle complete Rust file with all constructs", () => {
            const content = `
struct Point {
    x: i32,
    y: i32,
}

impl Point {
    pub fn new(x: i32, y: i32) -> Self {
        Point { x, y }
    }

    pub fn distance(&self) -> i32 {
        self.x + self.y
    }
}

fn main() {
    let p = Point::new(10, 20);
    p.distance();
    println!("Point: {}, {}", p.x, p.y);
}
      `;
            const tree = adapter.parse(content, "test.rs");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.rs");
            const imports = adapter.extractImports(tree, content, "test.rs");
            const calls = adapter.extractCalls(tree, content, "test.rs", symbols);
            assert.ok(symbols.length > 0, "Should have symbols");
            assert.strictEqual(symbols.filter((s) => s.kind === "class").length, 1);
            assert.strictEqual(symbols.filter((s) => s.kind === "method").length, 2);
            assert.strictEqual(symbols.filter((s) => s.kind === "function").length, 1);
            assert.ok(calls.length > 0, "Should have calls");
            const newCall = calls.find((c) => c.calleeIdentifier.includes("Point::new"));
            assert.ok(newCall, "Should find Point::new call");
            assert.strictEqual(newCall?.callType, "function");
            const distanceCall = calls.find((c) => c.calleeIdentifier.includes("distance"));
            assert.ok(distanceCall, "Should find distance call");
            assert.strictEqual(distanceCall?.callType, "method");
            const macroCall = calls.find((c) => c.calleeIdentifier === "println!");
            assert.ok(macroCall, "Should find println! macro call");
            assert.strictEqual(macroCall?.isResolved, false);
        });
    });
});
//# sourceMappingURL=rust-adapter.test.js.map