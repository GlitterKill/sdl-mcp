import type { Tree } from "tree-sitter";
import { BaseAdapter } from "./BaseAdapter.js";
import type {
  AdapterResolvedCall,
  CallResolutionContext,
} from "./LanguageAdapter.js";
import type {
  ExtractedSymbol,
  ExtractedCall,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import { extractSymbols as extractSymbolsImpl } from "../treesitter/extractSymbols.js";
import { extractImports as extractImportsImpl } from "../treesitter/extractImports.js";
import { extractCalls as extractCallsImpl } from "../treesitter/extractCalls.js";
import { createClearCacheFunction } from "./BaseAdapter.js";
import {
  BUILTIN_GLOBAL_NAMESPACES,
  NODE_BUILTIN_MODULE_NAMES,
} from "../edge-builder/builtins.js";

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

  resolveCall(context: CallResolutionContext): AdapterResolvedCall | null {
    const identifier = context.call.calleeIdentifier
      .replace(/^new\s+/, "")
      .trim();
    if (!identifier) {
      return null;
    }

    // Handle super calls — not resolvable to a specific symbol
    if (identifier === "super" || identifier.startsWith("super.")) {
      return null;
    }

    // Handle dotted calls: prefix.member
    if (identifier.includes(".")) {
      const parts = identifier.split(".");
      const prefix = parts[0];
      const member = parts[parts.length - 1];

      // JS/TS built-in globals — never resolve to repo symbols
      if (BUILTIN_GLOBAL_NAMESPACES.has(prefix)) {
        return null;
      }

      // Node.js built-in modules used as namespace — never resolve
      if (NODE_BUILTIN_MODULE_NAMES.has(prefix)) {
        return null;
      }

      // Check namespace imports: import * as X from "..." → X.member
      const nsMap = context.namespaceImports.get(prefix);
      if (nsMap && nsMap.has(member)) {
        return {
          symbolId: nsMap.get(member) ?? null,
          isResolved: true,
          confidence: 0.92,
          strategy: "exact",
        };
      }

      // this.method → look up method in local file symbols
      if (prefix === "this") {
        const local = context.nameToSymbolIds.get(member);
        if (local && local.length === 1) {
          return {
            symbolId: local[0],
            isResolved: true,
            strategy: "heuristic",
            confidence: 0.78,
          };
        }
      }

      return null; // Dotted but unresolved — fall through to generic
    }

    // Direct import lookup: import { foo } from "..." → foo()
    const imported = context.importedNameToSymbolIds.get(identifier);
    if (imported && imported.length === 1) {
      return {
        symbolId: imported[0],
        isResolved: true,
        strategy: "exact",
        confidence: 0.88,
      };
    }

    return null; // Fall through to generic resolution
  }
}

const clearCache = createClearCacheFunction("typescript");

export { TypeScriptAdapter, clearCache };
