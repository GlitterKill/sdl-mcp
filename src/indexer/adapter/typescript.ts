import type { Tree } from "tree-sitter";
import { BaseAdapter } from "./BaseAdapter.js";
import type {
  ExtractedSymbol,
  ExtractedCall,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import { extractSymbols as extractSymbolsImpl } from "../treesitter/extractSymbols.js";
import { extractImports as extractImportsImpl } from "../treesitter/extractImports.js";
import { extractCalls as extractCallsImpl } from "../treesitter/extractCalls.js";
import { createClearCacheFunction } from "./BaseAdapter.js";

class TypeScriptAdapter extends BaseAdapter {
  languageId = "typescript";
  fileExtensions = [".ts", ".tsx", ".js", ".jsx"] as const;

  extractSymbols(
    tree: Tree,
    _content: string,
    filePath: string,
  ): ExtractedSymbol[] {
    const richSymbols = extractSymbolsImpl(tree);

    const symbols: ExtractedSymbol[] = richSymbols.map((symbol) => ({
      nodeId: `${filePath}:${symbol.name}:${symbol.range.startLine}:${symbol.range.startCol}`,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported,
      range: symbol.range,
      signature: symbol.signature,
      visibility: symbol.visibility,
    }));

    return symbols;
  }

  extractImports(
    tree: Tree,
    _content: string,
    _filePath: string,
  ): ExtractedImport[] {
    return extractImportsImpl(tree);
  }

  extractCalls(
    tree: Tree,
    _content: string,
    _filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[] {
    return extractCallsImpl(tree, extractedSymbols);
  }
}

const clearCache = createClearCacheFunction("typescript");

export { TypeScriptAdapter, clearCache };
