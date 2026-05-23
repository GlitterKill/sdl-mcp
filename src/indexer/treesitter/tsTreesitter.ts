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
let tsxLanguage: Parser.Language | null | undefined;

function getTsxLanguage(): Parser.Language | null {
  if (tsxLanguage !== undefined) {
    return tsxLanguage;
  }

  try {
    const mod = require("tree-sitter-typescript");
    const lang = mod.tsx as Parser.Language | undefined;
    if (!lang) {
      logger.warn("tree-sitter-typescript does not export a tsx sub-grammar");
      tsxLanguage = null;
      return null;
    }
    tsxLanguage = lang;
    return lang;
  } catch (error) {
    logger.warn("Failed to load tsx language", {
      error: error instanceof Error ? error.message : String(error),
    });
    tsxLanguage = null;
    return null;
  }
}

/**
 * Get or create a parser using the tsx sub-grammar from tree-sitter-typescript.
 * Falls back to null if the grammar cannot be loaded.
 */
function getTsxParser(): Parser | null {
  if (tsxParser !== undefined) {
    return tsxParser;
  }

  const lang = getTsxLanguage();
  if (!lang) {
    tsxParser = null;
    return null;
  }

  try {
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

function needsTsxGrammar(extension: string): boolean {
  return extension === ".tsx" || extension === ".jsx";
}

export function createQueryForExtension(
  extension: string,
  queryString: string,
): Parser.Query | null {
  if (!needsTsxGrammar(extension)) {
    return createQuery("typescript", queryString);
  }

  const lang = getTsxLanguage();
  if (!lang) {
    return null;
  }

  try {
    const query = new Parser.Query(lang, queryString);
    logger.debug("Created tsx query");
    return query;
  } catch (error) {
    logger.warn("Failed to create tsx query", {
      error: error instanceof Error ? error.message : String(error),
      query: queryString.substring(0, QUERY_PREVIEW_LENGTH),
    });
    return null;
  }
}

export function createQueryForExtensionOrThrow(
  extension: string,
  queryString: string,
): Parser.Query {
  if (!needsTsxGrammar(extension)) {
    const query = createQuery("typescript", queryString);
    if (!query) {
      throw new Error("Failed to create TypeScript tree-sitter query");
    }
    return query;
  }

  const lang = getTsxLanguage();
  if (!lang) {
    throw new Error("TSX tree-sitter grammar is not available");
  }

  try {
    const query = new Parser.Query(lang, queryString);
    logger.debug("Created tsx query");
    return query;
  } catch (error) {
    throw new Error(
      `Failed to create TSX tree-sitter query: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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
    const isMJS = extension === ".mjs";
    const isCJS = extension === ".cjs";

    if (!isTS && !isTSX && !isJS && !isJSX && !isMJS && !isCJS) {
      return null;
    }

    // TSX/JSX files contain JSX syntax that the base typescript grammar rejects.
    // Use the tsx sub-grammar for these extensions.
    const parser = needsTsxGrammar(extension)
      ? getTsxParser()
      : getParser("typescript");
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

export function queryTree(
  tree: Parser.Tree,
  query: string,
): Parser.QueryMatch[] {
  return queryTreeForExtension(tree, ".ts", query);
}

export function queryTreeForExtension(
  tree: Parser.Tree,
  extension: string,
  query: string,
  options?: Parser.QueryOptions,
): Parser.QueryMatch[] {
  try {
    const tsQuery = createQueryForExtension(extension, query);
    if (!tsQuery) {
      return [];
    }
    const matches = tsQuery.matches(tree.rootNode, options);
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

export function queryTreeForExtensionOrThrow(
  tree: Parser.Tree,
  extension: string,
  query: string,
  options?: Parser.QueryOptions,
): Parser.QueryMatch[] {
  const tsQuery = createQueryForExtensionOrThrow(extension, query);
  try {
    return tsQuery.matches(tree.rootNode, options);
  } catch (error) {
    const queryPreview =
      query.length > QUERY_PREVIEW_LENGTH
        ? query.substring(0, QUERY_PREVIEW_LENGTH) + "..."
        : query;
    throw new Error(
      `Failed to execute tree query "${queryPreview}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
