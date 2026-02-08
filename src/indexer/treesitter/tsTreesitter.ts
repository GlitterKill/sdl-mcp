import Parser from "tree-sitter";
import { getParser, createQuery, SupportedLanguage } from "./grammarLoader.js";
import { QUERY_PREVIEW_LENGTH } from "../../config/constants.js";

// Tree-sitter has a default 32KB buffer limit that causes "Invalid argument"
// errors on larger files. We use a 1MB buffer to handle large source files.
// See: https://github.com/tree-sitter/tree-sitter/issues/3473
const TREESITTER_BUFFER_SIZE = 1024 * 1024; // 1 MB

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

    const parser = getParser("typescript");
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
    process.stderr.write(
      `[sdl-mcp] Failed to parse TypeScript file (extension: ${extension}): ${error instanceof Error ? error.message : String(error)}\n`,
    );
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
    process.stderr.write(
      `[sdl-mcp] Failed to execute tree query "${queryPreview}": ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return [];
  }
}
