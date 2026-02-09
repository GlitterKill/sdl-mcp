import Parser from "tree-sitter";
export type SupportedLanguage = "typescript" | "python" | "go" | "java" | "csharp" | "c" | "cpp" | "php" | "rust" | "kotlin" | "bash";
export declare function getParser(language: SupportedLanguage): Parser | null;
export declare function createQuery(language: SupportedLanguage, queryString: string): Parser.Query | null;
export declare function clearCache(language?: SupportedLanguage): void;
