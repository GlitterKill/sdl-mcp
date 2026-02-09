import Parser from "tree-sitter";
export interface ExtractedImport {
    specifier: string;
    isRelative: boolean;
    isExternal: boolean;
    imports: string[];
    defaultImport?: string;
    namespaceImport?: string;
    isReExport: boolean;
}
export declare function extractImports(tree: Parser.Tree): ExtractedImport[];
