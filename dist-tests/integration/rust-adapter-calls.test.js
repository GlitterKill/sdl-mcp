import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { RustAdapter } from "../../dist/indexer/adapter/rust.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
describe("Rust Adapter Tests - Call Extraction (ML2-C3.3)", () => {
    const adapter = new RustAdapter();
    const fixturesDir = resolve(__dirname, "fixtures", "rust");
    describe("ML2-C3.3: Call Extraction", () => {
        it("should extract function calls with caller context", () => {
            const code = `
fn simple_function(x: i32) -> i32 {
    x + 1
}

fn test_simple_calls() {
    simple_function(5);
    simple_function(10);
}
`;
            const filePath = resolve(fixturesDir, "calls.rs");
            const tree = adapter.parse(code, filePath);
            assert.ok(tree, "Should parse Rust code");
            const symbols = adapter.extractSymbols(tree, code, filePath);
            const calls = adapter.extractCalls(tree, code, filePath, symbols);
            const simpleFunctionCalls = calls.filter((c) => c.calleeIdentifier.includes("simple_function"));
            assert.ok(simpleFunctionCalls.length >= 2, `Should extract at least 2 calls to simple_function, got ${simpleFunctionCalls.length}`);
            for (const call of simpleFunctionCalls) {
                assert.strictEqual(call.callType, "function");
                assert.ok(call.callerNodeId, "Should have caller context");
            }
        });
        it("should extract method calls with receiver", () => {
            const code = `
struct Point {
    x: i32,
    y: i32,
}

impl Point {
    pub fn new(x: i32, y: i32) -> Self {
        Point { x, y }
    }

    pub fn distance(&self) -> i32 {
        10
    }
}

fn test_method_calls() {
    let mut p = Point::new(0, 0);
    p.distance();
}
`;
            const filePath = resolve(fixturesDir, "calls.rs");
            const tree = adapter.parse(code, filePath);
            assert.ok(tree, "Should parse Rust code");
            const symbols = adapter.extractSymbols(tree, code, filePath);
            const calls = adapter.extractCalls(tree, code, filePath, symbols);
            const methodCalls = calls.filter((c) => c.callType === "method");
            assert.ok(methodCalls.length > 0, `Should extract method calls, got ${methodCalls.length}`);
            const distanceCall = calls.find((c) => c.calleeIdentifier.includes("distance"));
            assert.ok(distanceCall, "Should find distance method call");
            assert.strictEqual(distanceCall.callType, "method");
        });
        it("should extract associated function calls (Type::func())", () => {
            const code = `
struct Point {
    x: i32,
    y: i32,
}

impl Point {
    pub fn new(x: i32, y: i32) -> Self {
        Point { x, y }
    }
}

fn test_associated() {
    let p = Point::new(0, 0);
}
`;
            const filePath = resolve(fixturesDir, "calls.rs");
            const tree = adapter.parse(code, filePath);
            assert.ok(tree, "Should parse Rust code");
            const symbols = adapter.extractSymbols(tree, code, filePath);
            const calls = adapter.extractCalls(tree, code, filePath, symbols);
            const newCall = calls.find((c) => c.calleeIdentifier.includes("Point::new"));
            assert.ok(newCall, "Should find Point::new associated function call");
            assert.strictEqual(newCall.callType, "function");
            assert.ok(newCall.calleeIdentifier.includes("::"), "Should contain :: separator");
        });
        it("should extract macro invocations as unresolved edges", () => {
            const code = `
fn test_macros() {
    println!("Hello, world!");
    vec![1, 2, 3];
    assert!(true);
}
`;
            const filePath = resolve(fixturesDir, "calls.rs");
            const tree = adapter.parse(code, filePath);
            assert.ok(tree, "Should parse Rust code");
            const symbols = adapter.extractSymbols(tree, code, filePath);
            const calls = adapter.extractCalls(tree, code, filePath, symbols);
            const macroCalls = calls.filter((c) => c.calleeIdentifier.endsWith("!"));
            assert.ok(macroCalls.length >= 2, `Should extract at least 2 macro calls, got ${macroCalls.length}`);
            for (const macroCall of macroCalls) {
                assert.strictEqual(macroCall.isResolved, false, "Macro calls should be unresolved");
                assert.strictEqual(macroCall.callType, "dynamic", "Macro calls should have dynamic type");
            }
        });
        it("should extract calls from comprehensive fixture", () => {
            const filePath = resolve(__dirname, "..", "fixtures", "rust", "calls.rs");
            const content = readFileSync(filePath, "utf-8");
            const tree = adapter.parse(content, filePath);
            assert.ok(tree, "Should parse Rust code");
            const symbols = adapter.extractSymbols(tree, content, filePath);
            const calls = adapter.extractCalls(tree, content, filePath, symbols);
            console.log(`✓ Extracted ${symbols.length} symbols and ${calls.length} calls`);
            assert.ok(calls.length > 0, "Should extract calls from fixture");
            const functionCalls = calls.filter((c) => c.callType === "function");
            const methodCalls = calls.filter((c) => c.callType === "method");
            const macroCalls = calls.filter((c) => c.calleeIdentifier.endsWith("!"));
            console.log(`  - Function calls: ${functionCalls.length}`);
            console.log(`  - Method calls: ${methodCalls.length}`);
            console.log(`  - Macro calls: ${macroCalls.length}`);
            assert.ok(functionCalls.length > 0, "Should have function calls");
            assert.ok(methodCalls.length > 0, "Should have method calls");
            assert.ok(macroCalls.length > 0, "Should have macro calls");
        });
        it("should handle chained method calls", () => {
            const code = `
struct VecWrapper {
    data: Vec<i32>,
}

impl VecWrapper {
    pub fn new() -> Self {
        VecWrapper { data: Vec::new() }
    }

    pub fn push(mut self, value: i32) -> Self {
        self.data.push(value);
        self
    }
}

fn test_chained() {
    let wrapper = VecWrapper::new().push(1).push(2);
}
`;
            const filePath = resolve(fixturesDir, "calls.rs");
            const tree = adapter.parse(code, filePath);
            assert.ok(tree, "Should parse Rust code");
            const symbols = adapter.extractSymbols(tree, code, filePath);
            const calls = adapter.extractCalls(tree, code, filePath, symbols);
            const pushCalls = calls.filter((c) => c.calleeIdentifier.includes("push"));
            assert.ok(pushCalls.length >= 2, `Should extract at least 2 push calls (chained), got ${pushCalls.length}`);
            for (const call of pushCalls) {
                assert.strictEqual(call.callType, "method", "Chained push calls should be method type");
            }
        });
        it("should track caller context correctly", () => {
            const code = `
fn outer() {
    fn inner() {}
    inner();
}

fn global() {
    outer();
}
`;
            const filePath = resolve(fixturesDir, "calls.rs");
            const tree = adapter.parse(code, filePath);
            assert.ok(tree, "Should parse Rust code");
            const symbols = adapter.extractSymbols(tree, code, filePath);
            const calls = adapter.extractCalls(tree, code, filePath, symbols);
            const outerFunc = symbols.find((s) => s.name === "outer");
            const globalFunc = symbols.find((s) => s.name === "global");
            assert.ok(outerFunc, "Should find outer function");
            assert.ok(globalFunc, "Should find global function");
            const outerCall = calls.find((c) => c.calleeIdentifier === "outer");
            assert.ok(outerCall, "Should find call to outer");
            assert.strictEqual(outerCall.callerNodeId, globalFunc.nodeId, "Call should be attributed to global function");
        });
    });
});
//# sourceMappingURL=rust-adapter-calls.test.js.map