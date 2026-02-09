import Parser from "tree-sitter";
import { SupportedLanguage } from "./grammarLoader.js";
export interface ParseResult {
    tree: Parser.Tree;
    language: SupportedLanguage;
}
export declare function parseFile(content: string, extension: string): ParseResult | null;
export declare function queryTree(tree: Parser.Tree, query: string): any[];
