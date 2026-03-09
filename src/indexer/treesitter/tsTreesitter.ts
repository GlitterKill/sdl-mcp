import { createRequire } from "node:module";
import Parser from "tree-sitter";
import { getParser, createQuery, SupportedLanguage } from "./grammarLoader.js";
import { QUERY_PREVIEW_LENGTH } from "../../config/constants.js";
import { logger } from "../../util/logger.js";

// Lazy synchronous require for the tsx sub-grammar.
// tree-sitter-typescript exports both .typescript and .tsx sub-grammars.
// The .tsx grammar handles JSX syntax nodes that .typescript rejects.
const require = createRequire(import.meta.url);

// Tree-sitter has a default 32KB buffer limit that causes "Invalid argument"
// errors on larger files. We use a 1MB buffer to handle large source files.
// See: https://github.com/tree-sitter/tree-sitter/issues/3473
const TREESITTER_BUFFER_SIZE = 1024 * 1024; // 1 MB

// Cached tsx parser — created on first use
let tsxParser: Parser | null | undefined;

/**
 * Get or create a parser using the tsx sub-grammar from tree-sitter-typescript.
 * Falls back to null if the grammar cannot be loaded.
 */
function getTsxParser(): Parser | null {
  if (tsxParser !== undefined) {
    return tsxParser;
  }

  try {
    const mod = require("tree-sitter-typescript");
    const lang = mod.tsx;
    if (!lang) {
      logger.warn("tree-sitter-typescript does not export a tsx sub-grammar");
      tsxParser = null;
      return null;
    }
    const parser = new Parser();
    parser.setLanguage(lang);
    tsxParser = parser;
    logger.debug("Created tsx parser for TSX/JSX files");
    return parser;
  } catch (error) {
    logger.warn("Failed to create tsx parser", {
      error: error instanceof Error ? error.message : String(error),
    });
    tsxParser = null;
    return null;
  }
}

export interface ParseResult {
  tree: Parser.Tree;
  language: SupportedLanguage;
}

export function parseFile(
  content: string,
  extension: string,
): ParseResult | null {
  try {
    const isTS = extension === ".ts";
    const isTSX = extension === ".tsx";
    const isJS = extension === ".js";
    const isJSX = extension === ".jsx";

    if (!isTS && !isTSX && !isJS && !isJSX) {
      return null;
    }

    // TSX/JSX files contain JSX syntax that the base typescript grammar rejects.
    // Use the tsx sub-grammar for these extensions.
    const needsTsx = isTSX || isJSX;
    const parser = needsTsx ? getTsxParser() : getParser("typescript");
    if (!parser) {
      return null;
    }

    // Use larger buffer size to handle files >32KB
    const tree = parser.parse(content, undefined, {
      bufferSize: TREESITTER_BUFFER_SIZE,
    });

    if (!tree || tree.rootNode.hasError) {
      return null;
    }

    return {
      tree,
      language: "typescript",
    };
  } catch (error) {
    logger.warn("Failed to parse TypeScript file", {
      extension,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function queryTree(tree: Parser.Tree, query: string): any[] {
  try {
    const tsQuery = createQuery("typescript", query);
    if (!tsQuery) {
      return [];
    }
    const matches = tsQuery.matches(tree.rootNode);
    return matches;
  } catch (error) {
    const queryPreview =
      query.length > QUERY_PREVIEW_LENGTH
        ? query.substring(0, QUERY_PREVIEW_LENGTH) + "..."
        : query;
    logger.warn("Failed to execute tree query", {
      queryPreview,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
