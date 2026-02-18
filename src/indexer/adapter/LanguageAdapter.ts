import { Tree } from "tree-sitter";
import type {
  ExtractedSymbol,
  ExtractedCall,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import type { EdgeResolutionStrategy } from "../../db/schema.js";

export interface CallResolutionContext {
  call: ExtractedCall;
  importedNameToSymbolIds: Map<string, string[]>;
  namespaceImports: Map<string, Map<string, string>>;
  nameToSymbolIds: Map<string, string[]>;
}

export interface AdapterResolvedCall {
  symbolId: string | null;
  isResolved: boolean;
  confidence?: number;
  strategy?: EdgeResolutionStrategy;
  candidateCount?: number;
  targetName?: string;
}

export interface LanguageAdapter {
  languageId: string;

  fileExtensions: readonly string[];

  getParser(): any;

  parse(content: string, filePath: string): Tree | null;

  parseAsync?(content: string, filePath: string): Promise<Tree | null>;

  extractAll?(
    content: string,
    filePath: string,
  ): Promise<{
    tree: Tree | null;
    symbols: ExtractedSymbol[];
    imports: ExtractedImport[];
    calls: ExtractedCall[];
  }>;

  extractSymbols(
    tree: Tree,
    content: string,
    filePath: string,
  ): ExtractedSymbol[];

  extractImports(
    tree: Tree,
    content: string,
    filePath: string,
  ): ExtractedImport[];

  extractCalls(
    tree: Tree,
    content: string,
    filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[];

  /**
   * Optional language-specific call target resolver.
   * Can improve precision beyond generic fallback heuristics.
   */
  resolveCall?(context: CallResolutionContext): AdapterResolvedCall | null;
}
