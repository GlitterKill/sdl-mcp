import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  loadPlugin,
  getPluginAdapters,
  clearLoadedPlugins,
  getHostApiVersion,
} from "../../dist/indexer/adapter/plugin/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Example Plugin Integration Tests (V06-10)", () => {
  const pluginDir = join(process.cwd(), "test-example-plugin");
  const fixturesDir = resolve(__dirname, "fixtures", "example-plugin");
  const goldenDir = resolve(__dirname, "fixtures", "example-plugin");
  let pluginPath: string;

  function ensureGoldenDir(): void {
    if (!existsSync(goldenDir)) {
      mkdirSync(goldenDir, { recursive: true });
    }
  }

  beforeEach(() => {
    clearLoadedPlugins();
    if (existsSync(pluginDir)) {
      rmSync(pluginDir, { recursive: true, force: true });
    }
    mkdirSync(pluginDir, { recursive: true });

    pluginPath = join(pluginDir, "example-plugin.mjs");
    const pluginContent = `
      export const manifest = {
        name: "example-plugin",
        version: "1.0.0",
        apiVersion: "${getHostApiVersion()}",
        description: "Example adapter plugin demonstrating the plugin system",
        author: "SDL-MCP Team",
        license: "MIT",
        adapters: [
          { extension: ".ex", languageId: "example-lang" },
        ],
      };

      export async function createAdapters() {
        return [{
          extension: ".ex",
          languageId: "example-lang",
          factory: () => {
            return {
              languageId: "example-lang",
              fileExtensions: [".ex"],
              getParser: () => null,
              parse: (content, filePath) => ({ content, filePath }),
              extractSymbols: (tree, content, filePath) => {
                const symbols = [];
                const lines = content.split("\\n");
                lines.forEach((line, index) => {
                  const funcMatch = line.match(/fn\\s+(\\w+)\\s*\\(/);
                  if (funcMatch) {
                    symbols.push({
                      id: filePath + ":fn:" + funcMatch[1],
                      name: funcMatch[1],
                      kind: "function",
                      filePath,
                      range: {
                        startLine: index + 1,
                        startCol: line.indexOf(funcMatch[1]),
                        endLine: index + 1,
                        endCol: line.indexOf(funcMatch[1]) + funcMatch[1].length,
                      },
                      parentId: null,
                      metadata: {},
                    });
                  }
                  const classMatch = line.match(/class\\s+(\\w+)/);
                  if (classMatch) {
                    symbols.push({
                      id: filePath + ":class:" + classMatch[1],
                      name: classMatch[1],
                      kind: "class",
                      filePath,
                      range: {
                        startLine: index + 1,
                        startCol: line.indexOf(classMatch[1]),
                        endLine: index + 1,
                        endCol: line.indexOf(classMatch[1]) + classMatch[1].length,
                      },
                      parentId: null,
                      metadata: {},
                    });
                  }
                });
                return symbols;
              },
              extractImports: (tree, content, filePath) => {
                const imports = [];
                const lines = content.split("\\n");
                lines.forEach((line, index) => {
                  const importMatch = line.match(/import\\s+"(.+)"/);
                  if (importMatch) {
                    imports.push({
                      id: filePath + ":import:" + index,
                      filePath,
                      range: {
                        startLine: index + 1,
                        startCol: line.indexOf("import"),
                        endLine: index + 1,
                        endCol: line.length,
                      },
                      moduleName: importMatch[1],
                      symbols: [],
                    });
                  }
                });
                return imports;
              },
              extractCalls: (tree, content, filePath, extractedSymbols) => {
                const calls = [];
                const lines = content.split("\\n");
                const keywords = new Set(["fn", "class", "if", "else", "for", "while", "return", "import"]);
                lines.forEach((line, index) => {
                  const trimmed = line.trim();
                  if (trimmed.startsWith("fn ") || trimmed.startsWith("class ")) return;
                  const callRegex = /(\\w+)\\s*\\(/g;
                  let callMatch;
                  while ((callMatch = callRegex.exec(line)) !== null) {
                    const functionName = callMatch[1];
                    if (keywords.has(functionName)) continue;
                    const symbol = extractedSymbols.find((s) => s.name === functionName);
                    const targetId = symbol ? symbol.id : filePath + ":unresolved:" + functionName;
                    calls.push({
                      id: filePath + ":call:" + index + ":" + functionName,
                      filePath,
                      range: {
                        startLine: index + 1,
                        startCol: callMatch.index,
                        endLine: index + 1,
                        endCol: callMatch.index + functionName.length,
                      },
                      targetSymbolId: targetId,
                      resolution: symbol ? "resolved" : "unresolved",
                    });
                  }
                });
                return calls;
              },
            };
          },
        }];
      }

      export default { manifest, createAdapters };
    `;
    writeFileSync(pluginPath, pluginContent);
  });

  afterEach(() => {
    clearLoadedPlugins();
    if (existsSync(pluginDir)) {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  describe("AC1: Sample Plugin Indexing Tests", () => {
    let pluginAdapter: any;

    beforeEach(async () => {
      const result = await loadPlugin(pluginPath);
      assert.ok(result.loaded, "Example plugin should load successfully");
      const adapters = await getPluginAdapters(result.plugin);
      assert.ok(adapters.length > 0, "Plugin should provide adapters");
      pluginAdapter = adapters[0].factory();
    });

    describe("Symbol Extraction", () => {
      it("should extract functions from .ex files", () => {
        const filePath = resolve(fixturesDir, "symbols.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        assert.ok(tree, "Should parse .ex file");

        const symbols = pluginAdapter.extractSymbols(tree, content, filePath);

        const myMethod = symbols.find((s: any) => s.name === "myMethod");
        assert.ok(myMethod, "Should extract myMethod function");
        assert.strictEqual(myMethod.kind, "function");
        assert.strictEqual(myMethod.filePath, filePath);
        assert.ok(myMethod.range, "Should have range information");

        const calculateSum = symbols.find(
          (s: any) => s.name === "calculateSum",
        );
        assert.ok(calculateSum, "Should extract calculateSum function");
        assert.strictEqual(calculateSum.kind, "function");
      });

      it("should extract classes from .ex files", () => {
        const filePath = resolve(fixturesDir, "symbols.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        assert.ok(tree);

        const symbols = pluginAdapter.extractSymbols(tree, content, filePath);

        const myClass = symbols.find((s: any) => s.name === "MyClass");
        assert.ok(myClass, "Should extract MyClass");
        assert.strictEqual(myClass.kind, "class");
        assert.strictEqual(myClass.filePath, filePath);
      });

      it("should generate golden file for symbols", () => {
        const filePath = resolve(fixturesDir, "symbols.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        const symbols = pluginAdapter.extractSymbols(tree, content, filePath);

        const goldenPath = resolve(goldenDir, "expected-symbols.json");
        ensureGoldenDir();
        writeFileSync(goldenPath, JSON.stringify(symbols, null, 2), "utf-8");

        assert.ok(symbols.length > 0, "Should extract symbols");
      });

      it("should validate against golden file", () => {
        const filePath = resolve(fixturesDir, "symbols.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        const symbols = pluginAdapter.extractSymbols(tree, content, filePath);

        const goldenPath = resolve(goldenDir, "expected-symbols.json");
        const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));

        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(symbols)),
          golden,
          "Extracted symbols should match golden file",
        );
      });
    });

    describe("Import Extraction", () => {
      it("should extract imports from .ex files", () => {
        const filePath = resolve(fixturesDir, "imports.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        assert.ok(tree, "Should parse .ex file");

        const imports = pluginAdapter.extractImports(tree, content, filePath);

        assert.ok(imports.length >= 3, "Should extract multiple imports");
        assert.ok(
          imports.some((i: any) => i.moduleName === "stdlib"),
          "Should extract stdlib import",
        );
        assert.ok(
          imports.some((i: any) => i.moduleName === "mylib/utils"),
          "Should extract mylib/utils import",
        );
        assert.ok(
          imports.some((i: any) => i.moduleName === "./local_module"),
          "Should extract relative import",
        );
      });

      it("should generate golden file for imports", () => {
        const filePath = resolve(fixturesDir, "imports.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        const imports = pluginAdapter.extractImports(tree, content, filePath);

        const goldenPath = resolve(goldenDir, "expected-imports.json");
        ensureGoldenDir();
        writeFileSync(goldenPath, JSON.stringify(imports, null, 2), "utf-8");

        assert.ok(imports.length > 0, "Should extract imports");
      });

      it("should validate against golden file", () => {
        const filePath = resolve(fixturesDir, "imports.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        const imports = pluginAdapter.extractImports(tree, content, filePath);

        const goldenPath = resolve(goldenDir, "expected-imports.json");
        const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));

        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(imports)),
          golden,
          "Extracted imports should match golden file",
        );
      });
    });

    describe("Call Extraction", () => {
      it("should extract function calls from .ex files", () => {
        const filePath = resolve(fixturesDir, "calls.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        assert.ok(tree, "Should parse .ex file");

        const symbols = pluginAdapter.extractSymbols(tree, content, filePath);
        const calls = pluginAdapter.extractCalls(
          tree,
          content,
          filePath,
          symbols,
        );

        assert.ok(calls.length > 0, "Should extract calls");

        const helperCall = calls.find((c: any) =>
          c.targetSymbolId.includes("helperFunction"),
        );
        assert.ok(helperCall, "Should extract call to helperFunction");

        const printCall = calls.find((c: any) =>
          c.targetSymbolId.includes("print"),
        );
        assert.ok(printCall, "Should extract call to print");
      });

      it("should extract method calls", () => {
        const filePath = resolve(fixturesDir, "calls.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        const symbols = pluginAdapter.extractSymbols(tree, content, filePath);
        const calls = pluginAdapter.extractCalls(
          tree,
          content,
          filePath,
          symbols,
        );

        const addCall = calls.find((c: any) =>
          c.targetSymbolId.includes("add"),
        );
        assert.ok(addCall, "Should extract add method call");

        const subtractCall = calls.find((c: any) =>
          c.targetSymbolId.includes("subtract"),
        );
        assert.ok(subtractCall, "Should extract subtract method call");
      });

      it("should generate golden file for calls", () => {
        const filePath = resolve(fixturesDir, "calls.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        const symbols = pluginAdapter.extractSymbols(tree, content, filePath);
        const calls = pluginAdapter.extractCalls(
          tree,
          content,
          filePath,
          symbols,
        );

        const goldenPath = resolve(goldenDir, "expected-calls.json");
        ensureGoldenDir();
        writeFileSync(goldenPath, JSON.stringify(calls, null, 2), "utf-8");

        assert.ok(calls.length > 0, "Should extract calls");
      });

      it("should validate against golden file", () => {
        const filePath = resolve(fixturesDir, "calls.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        const symbols = pluginAdapter.extractSymbols(tree, content, filePath);
        const calls = pluginAdapter.extractCalls(
          tree,
          content,
          filePath,
          symbols,
        );

        const goldenPath = resolve(goldenDir, "expected-calls.json");
        const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));

        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(calls)),
          golden,
          "Extracted calls should match golden file",
        );
      });
    });

    describe("AC1: Graph Extraction Tests", () => {
      it("should extract complete graph data structure", () => {
        const filePath = resolve(fixturesDir, "calls.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        assert.ok(tree, "Should parse .ex file");

        const symbols = pluginAdapter.extractSymbols(tree, content, filePath);
        const imports = pluginAdapter.extractImports(tree, content, filePath);
        const calls = pluginAdapter.extractCalls(
          tree,
          content,
          filePath,
          symbols,
        );

        assert.ok(symbols.length > 0, "Should have symbols");
        assert.ok(calls.length > 0, "Should have calls");

        const graphData = {
          symbols,
          imports,
          calls,
        };

        const goldenPath = resolve(goldenDir, "expected-graph.json");
        ensureGoldenDir();
        writeFileSync(goldenPath, JSON.stringify(graphData, null, 2), "utf-8");
      });

      it("should maintain symbol ID references in calls", () => {
        const filePath = resolve(fixturesDir, "calls.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        const symbols = pluginAdapter.extractSymbols(tree, content, filePath);
        const calls = pluginAdapter.extractCalls(
          tree,
          content,
          filePath,
          symbols,
        );

        for (const call of calls) {
          assert.ok(
            call.targetSymbolId,
            "Each call should have a targetSymbolId",
          );
          if (call.resolution === "resolved") {
            const targetSymbol = symbols.find(
              (s: any) => s.id === call.targetSymbolId,
            );
            assert.ok(
              targetSymbol,
              `Resolved call should reference existing symbol: ${call.targetSymbolId}`,
            );
          }
        }
      });

      it("should validate graph structure integrity", () => {
        const filePath = resolve(fixturesDir, "calls.ex");
        const content = readFileSync(filePath, "utf-8");

        const tree = pluginAdapter.parse(content, filePath);
        const symbols = pluginAdapter.extractSymbols(tree, content, filePath);
        const calls = pluginAdapter.extractCalls(
          tree,
          content,
          filePath,
          symbols,
        );

        for (const symbol of symbols) {
          assert.ok(symbol.id, "Symbol should have an ID");
          assert.ok(symbol.name, "Symbol should have a name");
          assert.ok(symbol.kind, "Symbol should have a kind");
          assert.ok(symbol.filePath, "Symbol should have a filePath");
          assert.ok(symbol.range, "Symbol should have range info");
        }

        for (const call of calls) {
          assert.ok(call.id, "Call should have an ID");
          assert.ok(call.targetSymbolId, "Call should have a targetSymbolId");
          assert.ok(call.filePath, "Call should have a filePath");
          assert.ok(call.range, "Call should have range info");
        }
      });
    });

    describe("Adapter Metadata", () => {
      it("should expose correct language ID", () => {
        assert.strictEqual(pluginAdapter.languageId, "example-lang");
      });

      it("should expose correct file extensions", () => {
        assert.ok(pluginAdapter.fileExtensions.includes(".ex"));
      });
    });
  });
});
