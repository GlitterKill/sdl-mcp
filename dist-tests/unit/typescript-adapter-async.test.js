import { describe, it } from "node:test";
import assert from "node:assert";
import { TypeScriptAdapter } from "../../dist/indexer/adapter/typescript.js";
describe("TypeScriptAdapter async methods", () => {
    const adapter = new TypeScriptAdapter();
    const testCode = `
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export const message = "Hello World";
  `;
    const filePath = "test.ts";
    it("parseAsync should return the same result as parse", async () => {
        const tree = adapter.parse(testCode, filePath);
        const treeAsync = await adapter.parseAsync?.(testCode, filePath);
        assert.ok(tree);
        assert.ok(treeAsync);
        assert.strictEqual(tree.rootNode.type, treeAsync.rootNode.type);
    });
    it("extractAll should return tree, symbols, imports, and calls", async () => {
        const result = await adapter.extractAll?.(testCode, filePath);
        assert.ok(result);
        assert.ok(result.tree);
        assert.ok(Array.isArray(result.symbols));
        assert.ok(Array.isArray(result.imports));
        assert.ok(Array.isArray(result.calls));
    });
    it("extractAll should extract symbols correctly", async () => {
        const result = await adapter.extractAll?.(testCode, filePath);
        assert.ok(result);
        assert.ok(result.symbols.length > 0);
        const greetSymbol = result.symbols.find((s) => s.name === "greet");
        assert.ok(greetSymbol);
        assert.strictEqual(greetSymbol.kind, "function");
        assert.strictEqual(greetSymbol.exported, true);
    });
    it("extractAll should handle parse errors gracefully", async () => {
        const invalidCode = "export function incomplete {";
        const result = await adapter.extractAll?.(invalidCode, "invalid.ts");
        assert.ok(result);
        assert.ok(result.tree);
        assert.ok(result.tree.rootNode.hasError);
        assert.strictEqual(result.symbols.length, 0);
        assert.strictEqual(result.imports.length, 0);
        assert.strictEqual(result.calls.length, 0);
    });
    it("extractAll should bundle all extraction steps", async () => {
        const codeWithImports = `
import { useState } from "react";
import axios from "axios";

export function fetchData(url: string) {
  return axios.get(url);
}

export function App() {
  const [data, setData] = useState(null);
  fetchData("/api/data");
}
`;
        const result = await adapter.extractAll?.(codeWithImports, "app.tsx");
        assert.ok(result);
        assert.ok(result.tree);
        assert.ok(result.symbols.length >= 2);
        assert.ok(result.imports.length >= 2);
        assert.ok(result.calls.length >= 2);
        const fetchDataSymbol = result.symbols.find((s) => s.name === "fetchData");
        assert.ok(fetchDataSymbol);
        assert.strictEqual(fetchDataSymbol.kind, "function");
        const reactImport = result.imports.find((i) => i.specifier === "react");
        assert.ok(reactImport);
        assert.ok(reactImport.imports.includes("useState"));
        const axiosImport = result.imports.find((i) => i.specifier === "axios");
        assert.ok(axiosImport);
        assert.strictEqual(axiosImport.defaultImport, "axios");
        const getCall = result.calls.find((c) => c.calleeIdentifier === "get");
        assert.ok(getCall);
        const useStateCall = result.calls.find((c) => c.calleeIdentifier === "useState");
        assert.ok(useStateCall);
    });
});
//# sourceMappingURL=typescript-adapter-async.test.js.map