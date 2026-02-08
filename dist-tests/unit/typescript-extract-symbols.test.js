import { describe, it } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
describe("TypeScript Symbol Extraction (IE-K.1)", () => {
    it("should extract exported type aliases", () => {
        const TypeScript = require("tree-sitter-typescript");
        const Parser = require("tree-sitter");
        const { extractSymbols, } = require("../../dist/indexer/treesitter/extractSymbols.js");
        const parser = new Parser();
        parser.setLanguage(TypeScript.typescript);
        const code = `
export type RepoId = string;
export type SymbolId = string;
export type EdgeType = "import" | "call" | "config";
`.trim();
        const tree = parser.parse(code);
        const symbols = extractSymbols(tree);
        assert.ok(symbols, "Should extract symbols");
        assert.strictEqual(symbols.length, 3, "Should extract 3 type aliases");
        const repoIdSymbol = symbols.find((s) => s.name === "RepoId");
        assert.ok(repoIdSymbol, "Should find RepoId type alias");
        assert.strictEqual(repoIdSymbol.kind, "type");
        assert.strictEqual(repoIdSymbol.exported, true);
        const symbolIdSymbol = symbols.find((s) => s.name === "SymbolId");
        assert.ok(symbolIdSymbol, "Should find SymbolId type alias");
        assert.strictEqual(symbolIdSymbol.kind, "type");
        assert.strictEqual(symbolIdSymbol.exported, true);
        const edgeTypeSymbol = symbols.find((s) => s.name === "EdgeType");
        assert.ok(edgeTypeSymbol, "Should find EdgeType type alias");
        assert.strictEqual(edgeTypeSymbol.kind, "type");
        assert.strictEqual(edgeTypeSymbol.exported, true);
    });
    it("should extract exported interfaces", () => {
        const TypeScript = require("tree-sitter-typescript");
        const Parser = require("tree-sitter");
        const { extractSymbols, } = require("../../dist/indexer/treesitter/extractSymbols.js");
        const parser = new Parser();
        parser.setLanguage(TypeScript.typescript);
        const code = `
export interface RepoRow {
  repo_id: RepoId;
  root_path: string;
  config_json: string;
  created_at: string;
}

export interface FileRow {
  file_id: number;
  repo_id: RepoId;
  rel_path: string;
}
`.trim();
        const tree = parser.parse(code);
        const symbols = extractSymbols(tree);
        assert.ok(symbols, "Should extract symbols");
        assert.strictEqual(symbols.length, 2, "Should extract 2 interfaces");
        const repoRowSymbol = symbols.find((s) => s.name === "RepoRow");
        assert.ok(repoRowSymbol, "Should find RepoRow interface");
        assert.strictEqual(repoRowSymbol.kind, "interface");
        assert.strictEqual(repoRowSymbol.exported, true);
        const fileRowSymbol = symbols.find((s) => s.name === "FileRow");
        assert.ok(fileRowSymbol, "Should find FileRow interface");
        assert.strictEqual(fileRowSymbol.kind, "interface");
        assert.strictEqual(fileRowSymbol.exported, true);
    });
    it("should mark non-exported types with exported: false", () => {
        const TypeScript = require("tree-sitter-typescript");
        const Parser = require("tree-sitter");
        const { extractSymbols, } = require("../../dist/indexer/treesitter/extractSymbols.js");
        const parser = new Parser();
        parser.setLanguage(TypeScript.typescript);
        const code = `
type InternalType = string;
interface InternalInterface {
  id: number;
}
export type ExportedType = number;
`.trim();
        const tree = parser.parse(code);
        const symbols = extractSymbols(tree);
        assert.ok(symbols, "Should extract symbols");
        assert.strictEqual(symbols.length, 3, "Should extract all 3 symbols");
        const exportedSymbol = symbols.find((s) => s.name === "ExportedType");
        assert.ok(exportedSymbol, "Should find ExportedType");
        assert.strictEqual(exportedSymbol.kind, "type");
        assert.strictEqual(exportedSymbol.exported, true);
        const internalTypeSymbol = symbols.find((s) => s.name === "InternalType");
        assert.ok(internalTypeSymbol, "Should find InternalType");
        assert.strictEqual(internalTypeSymbol.kind, "type");
        assert.strictEqual(internalTypeSymbol.exported, false);
        const internalInterfaceSymbol = symbols.find((s) => s.name === "InternalInterface");
        assert.ok(internalInterfaceSymbol, "Should find InternalInterface");
        assert.strictEqual(internalInterfaceSymbol.kind, "interface");
        assert.strictEqual(internalInterfaceSymbol.exported, false);
    });
    it("should extract type aliases with generics", () => {
        const TypeScript = require("tree-sitter-typescript");
        const Parser = require("tree-sitter");
        const { extractSymbols, } = require("../../dist/indexer/treesitter/extractSymbols.js");
        const parser = new Parser();
        parser.setLanguage(TypeScript.typescript);
        const code = `
export type Result<T> = {
  success: boolean;
  data?: T;
  error?: Error;
};

export type Map<T, U> = Map<T, U>;
`.trim();
        const tree = parser.parse(code);
        const symbols = extractSymbols(tree);
        assert.ok(symbols, "Should extract symbols");
        assert.strictEqual(symbols.length, 2, "Should extract 2 type aliases");
        const resultSymbol = symbols.find((s) => s.name === "Result");
        assert.ok(resultSymbol, "Should find Result type alias");
        assert.strictEqual(resultSymbol.kind, "type");
        assert.strictEqual(resultSymbol.exported, true);
        assert.ok(resultSymbol.signature?.generics, "Should have generics");
        assert.deepStrictEqual(resultSymbol.signature.generics, ["T"]);
        const mapSymbol = symbols.find((s) => s.name === "Map");
        assert.ok(mapSymbol, "Should find Map type alias");
        assert.strictEqual(mapSymbol.kind, "type");
        assert.strictEqual(mapSymbol.exported, true);
        assert.ok(mapSymbol.signature?.generics, "Should have generics");
        assert.deepStrictEqual(mapSymbol.signature.generics, ["T", "U"]);
    });
    it("should extract interfaces with generics and inheritance", () => {
        const TypeScript = require("tree-sitter-typescript");
        const Parser = require("tree-sitter");
        const { extractSymbols, } = require("../../dist/indexer/treesitter/extractSymbols.js");
        const parser = new Parser();
        parser.setLanguage(TypeScript.typescript);
        const code = `
export interface Entity<T> {
  id: T;
  createdAt: Date;
}

export interface User extends Entity<string> {
  name: string;
  email: string;
}
`.trim();
        const tree = parser.parse(code);
        const symbols = extractSymbols(tree);
        assert.ok(symbols, "Should extract symbols");
        assert.strictEqual(symbols.length, 2, "Should extract 2 interfaces");
        const entitySymbol = symbols.find((s) => s.name === "Entity");
        assert.ok(entitySymbol, "Should find Entity interface");
        assert.strictEqual(entitySymbol.kind, "interface");
        assert.strictEqual(entitySymbol.exported, true);
        assert.ok(entitySymbol.signature?.generics, "Should have generics");
        assert.deepStrictEqual(entitySymbol.signature.generics, ["T"]);
        const userSymbol = symbols.find((s) => s.name === "User");
        assert.ok(userSymbol, "Should find User interface");
        assert.strictEqual(userSymbol.kind, "interface");
        assert.strictEqual(userSymbol.exported, true);
    });
    it("should extract mixed exports (functions, classes, types, interfaces)", () => {
        const TypeScript = require("tree-sitter-typescript");
        const Parser = require("tree-sitter");
        const { extractSymbols, } = require("../../dist/indexer/treesitter/extractSymbols.js");
        const parser = new Parser();
        parser.setLanguage(TypeScript.typescript);
        const code = `
export function processData(input: string): number {
  return input.length;
}

export class DataProcessor {
  process(input: string): number {
    return input.length;
  }
}

export type Status = "pending" | "complete" | "failed";

export interface Config {
  maxRetries: number;
  timeout: number;
}
`.trim();
        const tree = parser.parse(code);
        const symbols = extractSymbols(tree);
        assert.ok(symbols, "Should extract symbols");
        assert.strictEqual(symbols.length, 5, "Should extract 5 symbols (function, class, method, type, interface)");
        const functionSymbol = symbols.find((s) => s.name === "processData");
        assert.ok(functionSymbol, "Should find processData function");
        assert.strictEqual(functionSymbol.kind, "function");
        const classSymbol = symbols.find((s) => s.name === "DataProcessor");
        assert.ok(classSymbol, "Should find DataProcessor class");
        assert.strictEqual(classSymbol.kind, "class");
        const methodSymbol = symbols.find((s) => s.name === "process");
        assert.ok(methodSymbol, "Should find process method");
        assert.strictEqual(methodSymbol.kind, "method");
        const typeSymbol = symbols.find((s) => s.name === "Status");
        assert.ok(typeSymbol, "Should find Status type alias");
        assert.strictEqual(typeSymbol.kind, "type");
        const interfaceSymbol = symbols.find((s) => s.name === "Config");
        assert.ok(interfaceSymbol, "Should find Config interface");
        assert.strictEqual(interfaceSymbol.kind, "interface");
        for (const symbol of symbols) {
            assert.strictEqual(symbol.exported, true, `Symbol ${symbol.name} should be marked as exported`);
        }
    });
});
//# sourceMappingURL=typescript-extract-symbols.test.js.map