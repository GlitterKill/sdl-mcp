import Parser from "tree-sitter";
import type { ExtractedSymbol } from "./extractCalls.js";
export declare function findEnclosingSymbol(node: Parser.SyntaxNode, symbols: ExtractedSymbol[]): string;
