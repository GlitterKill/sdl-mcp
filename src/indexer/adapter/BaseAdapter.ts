import Parser from "tree-sitter";
import type { Tree } from "tree-sitter";
import type { LanguageAdapter } from "./LanguageAdapter.js";
import type { SupportedLanguage } from "../treesitter/grammarLoader.js";
import {
  getParser,
  clearCache as clearGrammarCache,
} from "../treesitter/grammarLoader.js";
import type {
  ExtractedSymbol,
  ExtractedCall,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import { logger } from "../../util/logger.js";
import { findEnclosingSymbol as findEnclosingSymbolUtil } from "../treesitter/symbolUtils.js";

// Tree-sitter has a default 32KB buffer limit that causes "Invalid argument"
// errors on larger files. We use a 1MB buffer to handle large source files.
// See: https://github.com/tree-sitter/tree-sitter/issues/3473
const TREESITTER_BUFFER_SIZE = 1024 * 1024; // 1 MB

export abstract class BaseAdapter implements LanguageAdapter {
  abstract languageId: string;

  abstract fileExtensions: readonly string[];

  protected parser: Parser | null = null;

  getParser(): Parser | null {
    if (!this.parser) {
      this.parser = getParser(this.languageId as SupportedLanguage);
    }
    return this.parser;
  }

  parse(content: string, filePath: string): Tree | null {
    const parser = this.getParser();
    if (!parser) {
      this.logParseError(filePath, "Parser not available");
      return null;
    }

    try {
      // Use larger buffer size to handle files >32KB
      const tree = parser.parse(content, undefined, {
        bufferSize: TREESITTER_BUFFER_SIZE,
      });

      if (!tree) {
        this.logParseError(filePath, "Failed to parse file");
        return null;
      }

      if (tree.rootNode.hasError) {
        this.handleParseErrors(filePath, tree);
      }

      return tree;
    } catch (error) {
      this.logParseError(filePath, error);
      return null;
    }
  }

  async parseAsync(content: string, filePath: string): Promise<Tree | null> {
    return this.parse(content, filePath);
  }

  async extractAll(
    content: string,
    filePath: string,
  ): Promise<{
    tree: Tree | null;
    symbols: ExtractedSymbol[];
    imports: ExtractedImport[];
    calls: ExtractedCall[];
  }> {
    const tree = this.parse(content, filePath);

    if (!tree) {
      return {
        tree: null,
        symbols: [],
        imports: [],
        calls: [],
      };
    }

    const symbols = this.extractSymbols(tree, content, filePath);
    const imports = this.extractImports(tree, content, filePath);
    const calls = this.extractCalls(tree, content, filePath, symbols);

    return {
      tree,
      symbols,
      imports,
      calls,
    };
  }

  abstract extractSymbols(
    tree: Tree,
    content: string,
    filePath: string,
  ): ExtractedSymbol[];

  abstract extractImports(
    tree: Tree,
    content: string,
    filePath: string,
  ): ExtractedImport[];

  abstract extractCalls(
    tree: Tree,
    content: string,
    filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[];

  protected handleParseErrors(_filePath: string, _tree: Tree): void {}

  protected logParseError(filePath: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to parse file", { filePath, error: message });
  }

  protected extractRange(node: Parser.SyntaxNode): ExtractedSymbol["range"] {
    const start = node.startPosition;
    const end = node.endPosition;

    return {
      startLine: start.row + 1,
      startCol: start.column,
      endLine: end.row + 1,
      endCol: end.column,
    };
  }

  protected findEnclosingSymbol(
    node: Parser.SyntaxNode,
    symbols: ExtractedSymbol[],
  ): string {
    return findEnclosingSymbolUtil(node, symbols);
  }

  protected hasAncestorOfType(node: Parser.SyntaxNode, type: string): boolean {
    let current = node.parent;
    while (current) {
      if (current.type === type) return true;
      current = current.parent;
    }
    return false;
  }
}

export function createClearCacheFunction(languageId: string): () => void {
  return function clearCache(): void {
    clearGrammarCache(languageId as SupportedLanguage);
  };
}
