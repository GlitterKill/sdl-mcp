import type {
  LanguageAdapter,
  ExtractedSymbol,
  ExtractedImport,
  ExtractedCall,
} from "sdl-mcp/dist/indexer/adapter/LanguageAdapter.js";
import type {
  AdapterPlugin,
  PluginAdapter,
} from "sdl-mcp/dist/indexer/adapter/plugin/types.js";
import { BaseAdapter } from "sdl-mcp/dist/indexer/adapter/BaseAdapter.js";

const PLUGIN_API_VERSION = "1.0.0";

export const manifest = {
  name: "example-plugin",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Example adapter plugin demonstrating the plugin system",
  author: "SDL-MCP Team",
  license: "MIT",
  adapters: [
    {
      extension: ".ex",
      languageId: "example-lang",
    },
  ],
};

class ExampleLangAdapter extends BaseAdapter {
  languageId = "example-lang" as const;
  fileExtensions = [".ex"] as const;

  extractSymbols(
    _tree: any,
    content: string,
    filePath: string,
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      const funcMatch = line.match(/fn\s+(\w+)\s*\(/);
      if (funcMatch) {
        symbols.push({
          id: `${filePath}:fn:${funcMatch[1]}`,
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

      const classMatch = line.match(/class\s+(\w+)/);
      if (classMatch) {
        symbols.push({
          id: `${filePath}:class:${classMatch[1]}`,
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
  }

  extractImports(
    _tree: any,
    content: string,
    filePath: string,
  ): ExtractedImport[] {
    const imports: ExtractedImport[] = [];
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      const importMatch = line.match(/import\s+"(.+)"/);
      if (importMatch) {
        imports.push({
          id: `${filePath}:import:${index}`,
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
  }

  extractCalls(
    _tree: any,
    content: string,
    filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[] {
    const calls: ExtractedCall[] = [];
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      const callMatch = line.match(/(\w+)\s*\(/);
      if (callMatch) {
        const functionName = callMatch[1];
        const symbol = extractedSymbols.find((s) => s.name === functionName);

        if (symbol) {
          calls.push({
            id: `${filePath}:call:${index}:${functionName}`,
            filePath,
            range: {
              startLine: index + 1,
              startCol: line.indexOf(functionName),
              endLine: index + 1,
              endCol: line.indexOf(functionName) + functionName.length,
            },
            targetSymbolId: symbol.id,
          });
        }
      }
    });

    return calls;
  }
}

export async function createAdapters(): Promise<PluginAdapter[]> {
  return [
    {
      extension: ".ex",
      languageId: "example-lang",
      factory: () => new ExampleLangAdapter(),
    },
  ];
}

export default { manifest, createAdapters };
