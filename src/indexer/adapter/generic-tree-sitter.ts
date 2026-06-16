import Parser from "tree-sitter";
import type { SyntaxNode, Tree } from "tree-sitter";

import type { LanguageAdapter } from "./LanguageAdapter.js";
import type {
  ExtractedCall,
  ExtractedSymbol,
} from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import { getParser } from "../treesitter/grammarLoader.js";
import type { SupportedLanguage } from "../treesitter/grammarLoader.js";
import { logger } from "../../util/logger.js";

export interface GenericSymbolRule {
  readonly nodeTypes: readonly string[];
  readonly kind: ExtractedSymbol["kind"];
  readonly nameFields?: readonly string[];
}

export interface GenericTreeSitterAdapterOptions {
  readonly languageId: string;
  readonly grammarLanguage: SupportedLanguage;
  readonly fileExtensions: readonly string[];
  readonly symbolRules: readonly GenericSymbolRule[];
}

const DEFAULT_NAME_FIELDS = [
  "name",
  "identifier",
  "property",
  "field",
  "module",
] as const;

const IDENTIFIER_NODE_TYPES = new Set([
  "identifier",
  "constant",
  "simple_identifier",
  "type_identifier",
  "property_identifier",
  "variable_name",
  "command_name",
  "name",
]);

const PARAMETER_FIELD_NAMES = [
  "parameters",
  "parameter",
  "parameter_list",
  "formal_parameters",
  "block_parameters",
] as const;

export class GenericTreeSitterAdapter implements LanguageAdapter {
  readonly languageId: string;
  readonly fileExtensions: readonly string[];

  private parser: Parser | null = null;
  private readonly grammarLanguage: SupportedLanguage;
  private readonly symbolRules: readonly GenericSymbolRule[];

  constructor(options: GenericTreeSitterAdapterOptions) {
    this.languageId = options.languageId;
    this.grammarLanguage = options.grammarLanguage;
    this.fileExtensions = options.fileExtensions;
    this.symbolRules = options.symbolRules;
  }

  getParser(): Parser | null {
    if (!this.parser) {
      this.parser = getParser(this.grammarLanguage);
    }
    return this.parser;
  }

  parse(content: string, filePath: string): Tree | null {
    const parser = this.getParser();
    if (!parser) return null;

    try {
      const tree = parser.parse(content, undefined, {
        bufferSize: 1024 * 1024,
      });
      if (!tree) return null;
      if (tree.rootNode.hasError) {
        logger.warn(
          `Syntax errors detected in ${this.languageId} file - attempting partial extraction`,
          { filePath },
        );
      }
      return tree;
    } catch (error) {
      logger.error(`Failed to parse ${this.languageId} file`, {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  extractSymbols(
    tree: Tree,
    _content: string,
    filePath: string,
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];

    const traverse = (node: SyntaxNode): void => {
      const rule = this.symbolRules.find((candidate) =>
        candidate.nodeTypes.includes(node.type),
      );
      if (rule) {
        const nameNode = findNameNode(node, rule.nameFields);
        const name = nameNode?.text.trim();
        if (name) {
          symbols.push({
            nodeId: `${filePath}:${name}:${symbols.length}`,
            kind: rule.kind,
            name,
            exported: true,
            range: toRange(node),
            signature: buildSignature(node),
            visibility: name.startsWith("_") ? "private" : "public",
          });
        }
      }

      for (const child of node.children) {
        traverse(child);
      }
    };

    traverse(tree.rootNode);
    return symbols;
  }

  extractImports(
    _tree: Tree,
    _content: string,
    _filePath: string,
  ): ExtractedImport[] {
    return [];
  }

  extractCalls(
    _tree: Tree,
    _content: string,
    _filePath: string,
    _extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[] {
    return [];
  }
}

export function createGenericTreeSitterAdapterFactory(
  options: GenericTreeSitterAdapterOptions,
): () => LanguageAdapter {
  return () => new GenericTreeSitterAdapter(options);
}

function findNameNode(
  node: SyntaxNode,
  nameFields: readonly string[] | undefined,
): SyntaxNode | null {
  for (const field of nameFields ?? DEFAULT_NAME_FIELDS) {
    const candidate = node.childForFieldName(field);
    if (candidate && candidate.text.trim()) return candidate;
  }

  for (const child of node.children) {
    if (IDENTIFIER_NODE_TYPES.has(child.type) && child.text.trim()) {
      return child;
    }
  }

  return null;
}

function buildSignature(
  node: SyntaxNode,
): ExtractedSymbol["signature"] | undefined {
  for (const field of PARAMETER_FIELD_NAMES) {
    const paramsNode = node.childForFieldName(field);
    if (!paramsNode) continue;
    return {
      params: paramsNode.namedChildren.map((child) => ({
        name: child.text.trim(),
      })),
    };
  }
  return undefined;
}

function toRange(node: SyntaxNode): ExtractedSymbol["range"] {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}
