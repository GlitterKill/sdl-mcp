import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ShellAdapter } from "../../dist/indexer/adapter/shell.js";

describe("Shell Adapter", () => {
  const adapter = new ShellAdapter();

  describe("ML2-C5.1: Symbol Extraction", () => {
    it("should extract function definitions with name() style", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      const helloWorld = symbols.find((s) => s.name === "hello_world");
      assert.ok(helloWorld, "Should extract hello_world function");
      assert.strictEqual(helloWorld?.kind, "function");
      assert.strictEqual(helloWorld?.exported, true);
    });

    it("should extract function definitions with function keyword style", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      const greet = symbols.find((s) => s.name === "greet");
      assert.ok(greet, "Should extract greet function");
      assert.strictEqual(greet?.kind, "function");
      assert.strictEqual(greet?.exported, true);
    });

    it("should extract function definitions with parameters in body", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      const greetUser = symbols.find((s) => s.name === "greet_user");
      assert.ok(greetUser, "Should extract greet_user function");
      assert.strictEqual(greetUser?.kind, "function");
      assert.strictEqual(greetUser?.exported, true);
    });

    it("should extract global variables", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      const globalVar = symbols.find((s) => s.name === "GLOBAL_VAR");
      assert.ok(globalVar, "Should extract GLOBAL_VAR variable");
      assert.strictEqual(globalVar?.kind, "variable");
      assert.strictEqual(globalVar?.exported, false);
    });

    it("should extract exported variables", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      const exportedVar = symbols.find((s) => s.name === "EXPORTED_VAR");
      assert.ok(exportedVar, "Should extract EXPORTED_VAR variable");
      assert.strictEqual(exportedVar?.kind, "variable");
      assert.strictEqual(exportedVar?.exported, true);
    });

    it("should extract readonly variables", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      const readonlyVar = symbols.find((s) => s.name === "READONLY_VAR");
      assert.ok(readonlyVar, "Should extract READONLY_VAR variable");
      assert.strictEqual(readonlyVar?.kind, "variable");
      assert.strictEqual(readonlyVar?.exported, false);
    });

    it("should extract array variables", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      const arrayVar = symbols.find((s) => s.name === "ARRAY_VAR");
      assert.ok(arrayVar, "Should extract ARRAY_VAR variable");
      assert.strictEqual(arrayVar?.kind, "variable");
    });

    it("should extract associative array variables", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      const assocVar = symbols.find((s) => s.name === "ASSOC_VAR");
      assert.ok(assocVar, "Should extract ASSOC_VAR variable");
      assert.strictEqual(assocVar?.kind, "variable");
    });

    it("should extract local variables inside functions", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      const localVar = symbols.find((s) => s.name === "local_var");
      assert.ok(localVar, "Should extract local_var variable");
      assert.strictEqual(localVar?.kind, "variable");
      assert.strictEqual(localVar?.exported, false);
    });

    it("should extract aliases as variables", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      const llAlias = symbols.find((s) => s.name === "ll");
      assert.ok(llAlias, "Should extract ll alias");
      assert.strictEqual(llAlias?.kind, "variable");
      assert.strictEqual(llAlias?.exported, true);
      assert.ok(
        llAlias?.nodeId.endsWith(":alias"),
        "Alias nodeId should end with :alias",
      );

      const grepAlias = symbols.find((s) => s.name === "grep");
      assert.ok(grepAlias, "Should extract grep alias");
      assert.strictEqual(grepAlias?.kind, "variable");
      assert.ok(grepAlias?.nodeId.endsWith(":alias"));
    });

    it("should extract functions with multiple variable reassignments", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      const countVars = symbols.filter((s) => s.name === "count");
      assert.ok(
        countVars.length >= 2,
        "Should have multiple count variable instances",
      );
    });
  });

  describe("ML2-C5.2: Import Extraction", () => {
    it("should extract source commands with relative paths", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/imports.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.sh");

      const utilsImport = imports.find((imp) => imp.specifier === "./utils.sh");
      assert.ok(utilsImport, "Should find ./utils.sh import");
      assert.strictEqual(utilsImport?.isRelative, true);
      assert.strictEqual(utilsImport?.isExternal, false);
    });

    it("should extract source commands with absolute paths", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/imports.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.sh");

      const absoluteImport = imports.find(
        (imp) => imp.specifier === "/usr/local/lib/common.sh",
      );
      assert.ok(absoluteImport, "Should find /usr/local/lib/common.sh import");
      assert.strictEqual(absoluteImport?.isRelative, false);
      assert.strictEqual(absoluteImport?.isExternal, false);
    });

    it("should extract dot notation source commands", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/imports.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.sh");

      const dotImport = imports.find((imp) => imp.specifier === "./helpers.sh");
      assert.ok(dotImport, "Should find ./helpers.sh import (dot notation)");
      assert.strictEqual(dotImport?.isRelative, true);
    });

    it("should extract source with parent directory relative paths", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/imports.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.sh");

      const parentImport = imports.find(
        (imp) => imp.specifier === "../lib/config.sh",
      );
      assert.ok(parentImport, "Should find ../lib/config.sh import");
      assert.strictEqual(parentImport?.isRelative, true);
    });

    it("should extract source with nested relative paths", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/imports.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.sh");

      const nestedImport = imports.find(
        (imp) => imp.specifier === "./lib/utils/logger.sh",
      );
      assert.ok(nestedImport, "Should find ./lib/utils/logger.sh import");
      assert.strictEqual(nestedImport?.isRelative, true);
    });

    it("should strip quotes from file paths", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/imports.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.sh");

      const quotedImport = imports.find(
        (imp) => imp.specifier === "./quoted-path.sh",
      );
      assert.ok(quotedImport, "Should find ./quoted-path.sh (quotes stripped)");
      assert.strictEqual(quotedImport?.specifier, "./quoted-path.sh");

      const anotherQuotedImport = imports.find(
        (imp) => imp.specifier === "./another-quoted.sh",
      );
      assert.ok(
        anotherQuotedImport,
        "Should find ./another-quoted.sh (quotes stripped)",
      );
    });

    it("should handle multiple source commands", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/imports.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.sh");

      assert.ok(imports.length > 5, "Should extract multiple source commands");
    });
  });

  describe("ML2-C5.3: Call Extraction", () => {
    it("should extract function calls inside function bodies", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const orchestrateCalls = calls.filter((c) =>
        c.callerNodeId.includes("orchestrate"),
      );
      assert.ok(
        orchestrateCalls.length >= 3,
        "Should find calls inside orchestrate function",
      );
    });

    it("should extract function calls with correct resolution", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const helloWorldCall = calls.find(
        (c) => c.calleeIdentifier === "hello_world" && c.isResolved === true,
      );
      assert.ok(helloWorldCall, "Should resolve hello_world call");
      assert.strictEqual(helloWorldCall?.callType, "function");
      assert.ok(helloWorldCall?.calleeSymbolId);
    });

    it("should identify external commands as dynamic calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const lsCall = calls.find((c) => c.calleeIdentifier === "ls");
      assert.ok(lsCall, "Should find ls command call");
      assert.strictEqual(lsCall?.isResolved, false);
      assert.strictEqual(lsCall?.callType, "dynamic");
    });

    it("should identify alias invocations as dynamic calls", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const llCalls = calls.filter((c) => c.calleeIdentifier === "ll");
      assert.ok(llCalls.length > 0, "Should find ll alias invocation");
      assert.strictEqual(llCalls[0]?.isResolved, false);
      assert.strictEqual(llCalls[0]?.callType, "dynamic");
    });

    it("should extract calls with arguments", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const greetUserCalls = calls.filter(
        (c) => c.calleeIdentifier === "greet_user",
      );
      assert.ok(
        greetUserCalls.length >= 2,
        "Should find multiple greet_user calls with different arguments",
      );
    });

    it("should extract function calls in command substitution", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const calculateCall = calls.find(
        (c) =>
          c.calleeIdentifier === "calculate" && c.callerNodeId.includes("sum"),
      );
      assert.ok(
        calculateCall,
        "Should find calculate call inside command substitution",
      );
      assert.strictEqual(calculateCall?.isResolved, true);
    });

    it("should extract calls in pipelines", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const catCall = calls.find((c) => c.calleeIdentifier === "cat");
      assert.ok(catCall, "Should find cat command in pipeline");
    });

    it("should extract calls in subshells", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const subshellCalls = calls.filter((c) =>
        c.calleeIdentifier.includes("calculate"),
      );
      assert.ok(
        subshellCalls.length >= 2,
        "Should find calls in subshell $(...)",
      );
    });

    it("should extract calls in conditional statements", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const ifCalculateCall = calls.find(
        (c) =>
          c.calleeIdentifier === "calculate" &&
          c.range.startLine === 110 &&
          c.range.startCol === 3,
      );
      assert.ok(ifCalculateCall, "Should find calculate call in if condition");
    });

    it("should skip source commands (not function calls)", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const sourceCalls = calls.filter(
        (c) => c.calleeIdentifier === "source" || c.calleeIdentifier === ".",
      );
      assert.strictEqual(
        sourceCalls.length,
        0,
        "Should not extract source commands as calls",
      );
    });

    it("should skip alias definitions (not function calls)", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const aliasDefinitionCalls = calls.filter(
        (c) => c.calleeIdentifier === "alias",
      );
      assert.strictEqual(
        aliasDefinitionCalls.length,
        0,
        "Should not extract alias definitions as calls",
      );
    });

    it("should correctly identify caller for calls in global scope", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const globalCalls = calls.filter((c) => c.callerNodeId === "global");
      assert.ok(globalCalls.length > 0, "Should have calls in global scope");

      const echoCall = calls.find(
        (c) => c.calleeIdentifier === "echo" && c.range.startLine === 136,
      );
      assert.ok(echoCall, "Should find echo call");
      assert.strictEqual(echoCall?.callerNodeId, "global");
    });
  });

  describe("ML2-C5.4: Golden Files", () => {
    it("should match expected symbols output", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/symbols.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");

      assert.strictEqual(symbols.length, 25, "Should extract 25 symbols");
    });

    it("should match expected imports output", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/imports.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const imports = adapter.extractImports(tree, content, "test.sh");

      assert.strictEqual(imports.length, 12, "Should extract 12 imports");
    });

    it("should match expected calls output", () => {
      const content = readFileSync(
        join(process.cwd(), "tests/fixtures/shell/calls.sh"),
        "utf-8",
      );
      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      assert.strictEqual(calls.length, 54, "Should extract 54 calls");
    });
  });

  describe("Integration", () => {
    it("should handle complete Shell file with all constructs", () => {
      const content = `
#!/usr/bin/env bash

export API_KEY="secret"
readonly VERSION="1.0"

hello() {
    echo "Hello"
}

greet() {
    local name="$1"
    echo "Hi $name"
}

main() {
    source ./config.sh
    hello
    greet "World"
    ls -la
}

main
      `;

      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const imports = adapter.extractImports(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      assert.ok(symbols.length > 0, "Should have symbols");
      assert.strictEqual(imports.length, 1, "Should have 1 import");
      assert.ok(calls.length > 0, "Should have calls");

      const apiKey = symbols.find((s) => s.name === "API_KEY");
      assert.ok(apiKey);
      assert.strictEqual(apiKey?.kind, "variable");
      assert.strictEqual(apiKey?.exported, true);

      const helloFunc = symbols.find((s) => s.name === "hello");
      assert.ok(helloFunc);
      assert.strictEqual(helloFunc?.kind, "function");

      const configImport = imports.find(
        (imp) => imp.specifier === "./config.sh",
      );
      assert.ok(configImport);
      assert.strictEqual(configImport?.isRelative, true);

      const helloCall = calls.find((c) => c.calleeIdentifier === "hello");
      assert.ok(helloCall);
      assert.strictEqual(helloCall?.isResolved, true);
      assert.strictEqual(helloCall?.callType, "function");

      const lsCall = calls.find((c) => c.calleeIdentifier === "ls");
      assert.ok(lsCall);
      assert.strictEqual(lsCall?.isResolved, false);
      assert.strictEqual(lsCall?.callType, "dynamic");
    });
  });

  describe("Command Substitution Edge Cases", () => {
    it("should handle nested command substitution", () => {
      const content = `
result=$(echo "inner")
nested=$(date +%Y)
      `;

      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const echoCall = calls.find((c) => c.calleeIdentifier === "echo");
      assert.ok(echoCall, "Should find echo call in $(...)");

      const dateCall = calls.find((c) => c.calleeIdentifier === "date");
      assert.ok(dateCall, "Should find date call in $(...)");
    });

    it("should handle command substitution with pipelines", () => {
      const content = `
files=$(ls | grep "\\.sh$" | head -5)
      `;

      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const lsCall = calls.find((c) => c.calleeIdentifier === "ls");
      assert.ok(lsCall, "Should find ls call in pipeline inside $(...)");

      const grepCall = calls.find((c) => c.calleeIdentifier === "grep");
      assert.ok(grepCall, "Should find grep call in pipeline inside $(...)");

      const headCall = calls.find((c) => c.calleeIdentifier === "head");
      assert.ok(headCall, "Should find head call in pipeline inside $(...)");
    });

    it("should handle backtick command substitution", () => {
      const content = `
old_style=\`hostname\`
      `;

      const tree = adapter.parse(content, "test.sh");
      assert.ok(tree);

      const symbols = adapter.extractSymbols(tree, content, "test.sh");
      const calls = adapter.extractCalls(tree, content, "test.sh", symbols);

      const hostnameCall = calls.find((c) => c.calleeIdentifier === "hostname");
      assert.ok(hostnameCall, "Should find hostname call in backticks");
    });
  });
});
