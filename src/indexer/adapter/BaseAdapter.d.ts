import Parser from "tree-sitter";
import type { Tree } from "tree-sitter";
import type { LanguageAdapter } from "./LanguageAdapter.js";
import type { ExtractedSymbol, ExtractedCall } from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
export declare abstract class BaseAdapter implements LanguageAdapter {
    abstract languageId: string;
    abstract fileExtensions: readonly string[];
    protected parser: Parser | null;
    getParser(): Parser | null;
    parse(content: string, filePath: string): Tree | null;
    parseAsync(content: string, filePath: string): Promise<Tree | null>;
    extractAll(content: string, filePath: string): Promise<{
        tree: Tree | null;
        symbols: ExtractedSymbol[];
        imports: ExtractedImport[];
        calls: ExtractedCall[];
    }>;
    abstract extractSymbols(tree: Tree, content: string, filePath: string): ExtractedSymbol[];
    abstract extractImports(tree: Tree, content: string, filePath: string): ExtractedImport[];
    abstract extractCalls(tree: Tree, content: string, filePath: string, extractedSymbols: ExtractedSymbol[]): ExtractedCall[];
    protected handleParseErrors(_filePath: string, _tree: Tree): void;
    protected logParseError(filePath: string, error: unknown): void;
    protected extractRange(node: Parser.SyntaxNode): ExtractedSymbol["range"];
    protected findEnclosingSymbol(node: Parser.SyntaxNode, symbols: ExtractedSymbol[]): string;
    protected hasAncestorOfType(node: Parser.SyntaxNode, type: string): boolean;
}
export declare function createClearCacheFunction(languageId: string): () => void;
