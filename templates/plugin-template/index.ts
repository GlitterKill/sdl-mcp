import { BaseAdapter } from "sdl-mcp/dist/indexer/adapter/BaseAdapter.js";
import type { LanguageAdapter } from "sdl-mcp/dist/indexer/adapter/LanguageAdapter.js";
import type { PluginAdapter } from "sdl-mcp/dist/indexer/adapter/plugin/types.js";
import type {
  ExtractedCall,
  ExtractedSymbol,
} from "sdl-mcp/dist/indexer/treesitter/extractCalls.js";
import type { ExtractedImport } from "sdl-mcp/dist/indexer/treesitter/extractImports.js";

const PLUGIN_API_VERSION = "1.0.0";

export const manifest = {
  name: "sdl-mcp-mylang-plugin",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "MyLang adapter plugin for SDL-MCP",
  author: "Your Name",
  license: "MIT",
  adapters: [
    {
      extension: ".mylang",
      languageId: "mylang",
    },
  ],
};

const REGEX_PARSE_TREE = {
  rootNode: {
    descendantsOfType: () => [],
  },
  delete: () => undefined,
} as NonNullable<ReturnType<LanguageAdapter["parse"]>>;

function createRange(
  lineIndex: number,
  startCol: number,
  length: number,
): ExtractedSymbol["range"] {
  return {
    startLine: lineIndex + 1,
    startCol,
    endLine: lineIndex + 1,
    endCol: startCol + length,
  };
}

function createNodeId(
  filePath: string,
  kind: ExtractedSymbol["kind"],
  name: string,
  lineIndex: number,
  startCol: number,
): string {
  return `${filePath}:${kind}:${name}:${lineIndex + 1}:${startCol}`;
}

function findNearestCallerNodeId(
  lineNumber: number,
  extractedSymbols: ExtractedSymbol[],
): string {
  const containingOrPrevious = extractedSymbols
    .filter((symbol) => symbol.range.startLine <= lineNumber)
    .at(-1);

  return containingOrPrevious?.nodeId ?? "";
}

export class MyLangAdapter extends BaseAdapter {
  languageId = "mylang" as const;
  fileExtensions = [".mylang"] as const;

  getParser(): null {
    return null;
  }

  parse(
    _content: string,
    _filePath: string,
  ): NonNullable<ReturnType<LanguageAdapter["parse"]>> {
    // Regex-only adapters do not have a tree-sitter grammar. Return a minimal
    // tree-shaped object so the indexer still calls the extraction hooks.
    return REGEX_PARSE_TREE;
  }

  extractSymbols(
    _tree: unknown,
    content: string,
    filePath: string,
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];

    const lines = content.split("\n");

    lines.forEach((line, index) => {
      const funcMatch = line.match(/function\s+(\w+)\s*\(/);
      if (funcMatch) {
        const name = funcMatch[1];
        const startCol = line.indexOf(name);
        symbols.push({
          nodeId: createNodeId(filePath, "function", name, index, startCol),
          name,
          kind: "function",
          exported: false,
          range: createRange(index, startCol, name.length),
        });
      }

      const classMatch = line.match(/class\s+(\w+)/);
      if (classMatch) {
        const name = classMatch[1];
        const startCol = line.indexOf(name);
        symbols.push({
          nodeId: createNodeId(filePath, "class", name, index, startCol),
          name,
          kind: "class",
          exported: false,
          range: createRange(index, startCol, name.length),
        });
      }
    });

    return symbols;
  }

  extractImports(
    _tree: unknown,
    content: string,
    _filePath: string,
  ): ExtractedImport[] {
    const imports: ExtractedImport[] = [];

    const lines = content.split("\n");

    lines.forEach((line) => {
      const importMatch = line.match(/import\s+"(.+)"/);
      if (importMatch) {
        const specifier = importMatch[1];
        imports.push({
          specifier,
          isRelative: specifier.startsWith("."),
          isExternal: !specifier.startsWith("."),
          imports: [],
          isReExport: false,
        });
      }
    });

    return imports;
  }

  extractCalls(
    _tree: unknown,
    content: string,
    _filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[] {
    const calls: ExtractedCall[] = [];

    const lines = content.split("\n");

    lines.forEach((line, index) => {
      if (/^\s*function\s+\w+\s*\(/.test(line)) {
        return;
      }

      const callPattern = /\b(\w+)\s*\(/g;
      for (const callMatch of line.matchAll(callPattern)) {
        const functionName = callMatch[1];
        const symbol = extractedSymbols.find((s) => s.name === functionName);

        if (symbol) {
          const startCol = callMatch.index ?? line.indexOf(functionName);
          calls.push({
            callerNodeId: findNearestCallerNodeId(index + 1, extractedSymbols),
            calleeIdentifier: functionName,
            isResolved: true,
            callType: symbol.kind === "class" ? "constructor" : "function",
            calleeSymbolId: symbol.nodeId,
            range: createRange(index, startCol, functionName.length),
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
      extension: ".mylang",
      languageId: "mylang",
      factory: () => new MyLangAdapter(),
    },
  ];
}

export default { manifest, createAdapters };
