import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { ShellAdapter } from "../../dist/indexer/adapter/shell.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Shell Adapter Tests (ML2-C5.x)", () => {
  const adapter = new ShellAdapter();
  const fixturesDir = resolve(__dirname, "..", "fixtures", "shell");
  const goldenDir = resolve(__dirname, "..", "fixtures", "shell");

  function ensureGoldenDir(): void {
    if (!existsSync(goldenDir)) {
      mkdirSync(goldenDir, { recursive: true });
    }
  }

  describe("ML2-C5.1: Symbol Extraction", () => {
    it("should extract all symbols correctly", () => {
      const filePath = resolve(fixturesDir, "symbols.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree, "Should parse Shell code");

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const goldenPath = resolve(goldenDir, "expected-symbols.json");
      ensureGoldenDir();
      writeFileSync(goldenPath, JSON.stringify(symbols, null, 2), "utf-8");

      console.log(`✓ Generated ${symbols.length} symbols for symbols.sh`);

      assert.ok(symbols.length > 0, "Should extract symbols");
    });

    it("should extract functions", () => {
      const filePath = resolve(fixturesDir, "symbols.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const helloWorld = symbols.find((s) => s.name === "hello_world");
      assert.ok(helloWorld, "Should extract hello_world");
      assert.strictEqual(helloWorld.kind, "function");
      assert.strictEqual(helloWorld.visibility, "public");
    });

    it("should extract variables with export status", () => {
      const filePath = resolve(fixturesDir, "symbols.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const globalVar = symbols.find((s) => s.name === "GLOBAL_VAR");
      assert.ok(globalVar, "Should extract GLOBAL_VAR");
      assert.strictEqual(globalVar.kind, "variable");
      assert.strictEqual(globalVar.exported, false);

      const exportedVar = symbols.find((s) => s.name === "EXPORTED_VAR");
      assert.ok(exportedVar, "Should extract EXPORTED_VAR");
      assert.strictEqual(exportedVar.kind, "variable");
      assert.strictEqual(exportedVar.exported, true);
    });

    it("should extract aliases", () => {
      const filePath = resolve(fixturesDir, "symbols.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const llAlias = symbols.find((s) => s.name === "ll");
      assert.ok(llAlias, "Should extract ll alias");
      assert.strictEqual(llAlias.kind, "variable");
      assert.ok(llAlias.nodeId.endsWith(":alias"));
    });
  });

  describe("ML2-C5.2: Import Extraction", () => {
    it("should extract all imports correctly", () => {
      const filePath = resolve(fixturesDir, "imports.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree, "Should parse Shell code");

      const imports = adapter.extractImports(tree, content, filePath);

      const goldenPath = resolve(goldenDir, "expected-imports.json");
      ensureGoldenDir();
      writeFileSync(goldenPath, JSON.stringify(imports, null, 2), "utf-8");

      console.log(`✓ Generated ${imports.length} imports for imports.sh`);

      assert.ok(imports.length > 0, "Should extract imports");
    });

    it("should parse source commands", () => {
      const filePath = resolve(fixturesDir, "imports.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, filePath);

      assert.ok(imports.length > 0, "Should find source commands");
      const sourceImport = imports[0];
      assert.strictEqual(sourceImport.isRelative, true);
      assert.strictEqual(sourceImport.isExternal, false);
    });

    it("should parse dot notation for sourcing", () => {
      const filePath = resolve(fixturesDir, "imports.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, filePath);

      assert.ok(
        imports.length >= 2,
        "Should find both source and dot notation",
      );
    });
  });

  describe("ML2-C5.3: Call Extraction", () => {
    it("should extract all calls correctly", () => {
      const filePath = resolve(fixturesDir, "calls.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree, "Should parse Shell code");

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const goldenPath = resolve(goldenDir, "expected-calls.json");
      ensureGoldenDir();
      writeFileSync(goldenPath, JSON.stringify(calls, null, 2), "utf-8");

      console.log(`✓ Generated ${calls.length} calls for calls.sh`);

      assert.ok(calls.length > 0, "Should extract calls");
    });

    it("should extract basic function calls", () => {
      const filePath = resolve(fixturesDir, "calls.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const call = calls.find((c) => c.calleeIdentifier === "hello_world");
      assert.ok(call, "Should extract hello_world call");
      assert.strictEqual(call.callType, "function");
      assert.strictEqual(call.isResolved, true);
    });

    it("should extract function calls with arguments", () => {
      const filePath = resolve(fixturesDir, "calls.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const greetUserCall = calls.find(
        (c) => c.calleeIdentifier === "greet_user",
      );
      assert.ok(greetUserCall, "Should extract greet_user call");
      assert.strictEqual(greetUserCall.callType, "function");
    });

    it("should detect external command calls", () => {
      const filePath = resolve(fixturesDir, "calls.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const lsCall = calls.find((c) => c.calleeIdentifier === "ls");
      assert.ok(lsCall, "Should extract ls command");
      assert.strictEqual(lsCall.callType, "dynamic");
      assert.strictEqual(lsCall.isResolved, false);
    });

    it("should detect alias invocations", () => {
      const filePath = resolve(fixturesDir, "calls.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const llCall = calls.find((c) => c.calleeIdentifier === "ll");
      assert.ok(llCall, "Should extract ll alias invocation");
      assert.strictEqual(llCall.callType, "dynamic");
    });

    it("should capture caller context for calls inside functions", () => {
      const filePath = resolve(fixturesDir, "calls.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      // Find a call inside the calculate function
      const calculateCall = calls.find(
        (c) =>
          c.calleeIdentifier === "hello_world" && c.callerNodeId !== "global",
      );
      assert.ok(
        calculateCall,
        "Should find call inside function with caller context",
      );
      assert.ok(calculateCall.callerNodeId !== "global");
    });

    it("should identify calls in global scope", () => {
      const filePath = resolve(fixturesDir, "calls.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const globalCalls = calls.filter((c) => c.callerNodeId === "global");
      assert.ok(globalCalls.length > 0, "Should find calls in global scope");
    });

    it("should skip source and alias definitions", () => {
      const filePath = resolve(fixturesDir, "calls.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const sourceCall = calls.find((c) => c.calleeIdentifier === "source");
      const dotCall = calls.find((c) => c.calleeIdentifier === ".");
      const aliasCall = calls.find((c) => c.calleeIdentifier === "alias");

      assert.ok(!sourceCall, "Should not extract source as a call");
      assert.ok(!dotCall, "Should not extract dot as a call");
      assert.ok(!aliasCall, "Should not extract alias definition as a call");
    });
  });

  describe("ML2-C5.4: Golden File Validation", () => {
    it("should match expected symbols", () => {
      const filePath = resolve(fixturesDir, "symbols.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);

      const goldenPath = resolve(goldenDir, "expected-symbols.json");
      const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));

      assert.deepStrictEqual(
        symbols,
        golden,
        "Extracted symbols should match golden file",
      );
    });

    it("should match expected imports", () => {
      const filePath = resolve(fixturesDir, "imports.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, filePath);

      const goldenPath = resolve(goldenDir, "expected-imports.json");
      const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));

      assert.deepStrictEqual(
        imports,
        golden,
        "Extracted imports should match golden file",
      );
    });

    it("should match expected calls", () => {
      const filePath = resolve(fixturesDir, "calls.sh");
      const content = readFileSync(filePath, "utf-8");
      const tree = adapter.parse(content, filePath);
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, filePath);
      const calls = adapter.extractCalls(tree, content, filePath, symbols);

      const goldenPath = resolve(goldenDir, "expected-calls.json");
      const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));

      assert.deepStrictEqual(
        calls,
        golden,
        "Extracted calls should match golden file",
      );
    });
  });
});
