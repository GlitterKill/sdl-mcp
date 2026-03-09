import { readFile, stat } from "fs/promises";
import type { RepoId, SymbolId } from "../db/schema.js";
import type { Range } from "../domain/types.js";
import { getAbsolutePathFromRepoRoot } from "../util/paths.js";
import { estimateTokens as estimateTokenCount } from "../util/tokenize.js";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import {
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_LINES_HOTPATH,
  DEFAULT_MAX_TOKENS_HOTPATH,
  MAX_FILE_BYTES,
  MAX_TREESITTER_PARSE_BYTES,
} from "../config/constants.js";
import { logger } from "../util/logger.js";
import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";
import { getParser as getGrammarParser } from "../indexer/treesitter/grammarLoader.js";

const tsParser = new Parser();
const tsxParser = new Parser();

tsParser.setLanguage(TypeScript.typescript as unknown as Parser.Language);
tsxParser.setLanguage(TypeScript.tsx as unknown as Parser.Language);

/**
 * Maps file extensions to grammarLoader language IDs for non-JS/TS languages.
 */
const EXTENSION_TO_LANGUAGE: Record<
  string,
  import("../indexer/treesitter/grammarLoader.js").SupportedLanguage
> = {
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".rs": "rust",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".sh": "bash",
  ".bash": "bash",
};

export interface HotPathOptions {
  maxLines?: number;
  maxTokens?: number;
  contextLines?: number;
}

export interface HotPathResult {
  excerpt: string;
  actualRange: Range;
  estimatedTokens: number;
  matchedIdentifiers: string[];
  matchedLineNumbers: number[];
  truncated: boolean;
}

function parseFile(content: string, extension: string): Parser.Tree | null {
  try {
    // Guard: reject content exceeding the tree-sitter safety limit.
    const byteLength = Buffer.byteLength(content, "utf-8");
    if (byteLength > MAX_TREESITTER_PARSE_BYTES) {
      logger.warn(
        "File content exceeds tree-sitter parse limit for hot path, skipping",
        {
          extension,
          byteLength,
          maxBytes: MAX_TREESITTER_PARSE_BYTES,
        },
      );
      return null;
    }

    // JS/TS: use dedicated parsers (handle JSX/TSX correctly)
    const isTS = extension === ".ts";
    const isTSX = extension === ".tsx";
    const isJS = extension === ".js";
    const isJSX = extension === ".jsx";

    let parser: Parser | null = null;

    if (isTS || isTSX || isJS || isJSX) {
      parser = isTS || isJS ? tsParser : tsxParser;
    } else {
      // All other languages: use the shared grammarLoader
      const language = EXTENSION_TO_LANGUAGE[extension];
      if (!language) {
        logger.debug("No grammar available for hot path generation", {
          extension,
        });
        return null;
      }
      parser = getGrammarParser(language);
      if (!parser) {
        logger.debug("Grammar parser not loaded for hot path generation", {
          extension,
          language,
        });
        return null;
      }
    }

    // Use 1MB buffer to handle files >32KB (tree-sitter default limit)
    const tree = parser.parse(content, undefined, {
      bufferSize: 1024 * 1024,
    });

    if (!tree || tree.rootNode.hasError) {
      return null;
    }

    return tree;
  } catch (error) {
    logger.warn("Failed to parse file for hot path", {
      extension,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

interface IdentifierMatchResult {
  matchedLines: Set<number>;
  confirmedIdentifiers: Set<string>;
}

function findLinesMatchingIdentifiers(
  tree: Parser.Tree,
  identifiersToFind: string[],
): IdentifierMatchResult {
  const matchedLines = new Set<number>();
  const confirmedIdentifiers = new Set<string>();

  if (identifiersToFind.length === 0) {
    return { matchedLines, confirmedIdentifiers };
  }

  const identifierSet = new Set<string>(identifiersToFind);

  function recordMatch(text: string, line: number): void {
    matchedLines.add(line);
    if (identifierSet.has(text)) {
      confirmedIdentifiers.add(text);
    }
  }

  function matchesAsMemberExpression(text: string, line: number): boolean {
    const parts = text.split(/[.?\[\]]+/).filter(Boolean);
    for (const part of parts) {
      if (identifierSet.has(part)) {
        recordMatch(part, line);
        return true;
      }
    }
    return false;
  }

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "identifier") {
      if (identifierSet.has(node.text)) {
        recordMatch(node.text, node.startPosition.row + 1);
      }
    }

    if (node.type === "call_expression") {
      const funcNode = node.childForFieldName("function");
      if (funcNode) {
        if (funcNode.type === "identifier") {
          if (identifierSet.has(funcNode.text)) {
            recordMatch(funcNode.text, node.startPosition.row + 1);
          }
        } else if (funcNode.type === "member_expression") {
          matchesAsMemberExpression(funcNode.text, node.startPosition.row + 1);
        }
      }
    }

    if (node.type === "throw_statement") {
      const thrown = node.childForFieldName("value");
      if (thrown) {
        if (thrown.type === "new_expression") {
          const constructorNode = thrown.childForFieldName("constructor");
          if (constructorNode && constructorNode.type === "identifier") {
            if (identifierSet.has(constructorNode.text)) {
              recordMatch(constructorNode.text, node.startPosition.row + 1);
            }
          }
        } else if (thrown.type === "identifier") {
          if (identifierSet.has(thrown.text)) {
            recordMatch(thrown.text, node.startPosition.row + 1);
          }
        }
      }
    }

    Array.from(node.children).forEach((child) => {
      walk(child);
    });
  }

  walk(tree.rootNode);
  return { matchedLines, confirmedIdentifiers };
}

function buildHotPathExcerpt(
  lines: string[],
  matchedLines: Set<number>,
  contextLines: number,
  maxLines: number,
  maxTokens: number,
): {
  excerpt: string;
  matchedIdentifiers: string[];
  matchedLineNumbers: number[];
  truncated: boolean;
  actualRange: Range;
} {
  if (matchedLines.size === 0) {
    const allExcerpt = lines.slice(0, Math.min(maxLines, lines.length));
    const resultLines: string[] = [];
    let remainingTokens = maxTokens;
    for (const line of allExcerpt) {
      const lineTokens = estimateTokenCount(line);
      if (lineTokens > remainingTokens) break;
      resultLines.push(line);
      remainingTokens -= lineTokens;
    }
    const excerpt = resultLines.join("\n");
    return {
      excerpt,
      matchedIdentifiers: [],
      matchedLineNumbers: [],
      truncated: resultLines.length < lines.length,
      actualRange: {
        startLine: 1,
        startCol: 0,
        endLine: resultLines.length,
        endCol: resultLines[resultLines.length - 1]?.length ?? 0,
      },
    };
  }

  const matchedLineNumbers = Array.from(matchedLines).sort((a, b) => a - b);
  const excerptLineSet = new Set<number>();

  matchedLineNumbers.forEach((lineNum) => {
    const start = Math.max(0, lineNum - 1 - contextLines);
    const end = Math.min(lines.length, lineNum + contextLines);
    for (let i = start; i < end; i++) {
      excerptLineSet.add(i);
    }
  });

  const excerptLineNumbers = Array.from(excerptLineSet).sort((a, b) => a - b);
  const excerptLines = excerptLineNumbers.map((i) => lines[i]);

  const resultLines: string[] = [];
  let remainingTokens = maxTokens;

  for (const line of excerptLines) {
    const lineTokens = estimateTokenCount(line);
    if (lineTokens > remainingTokens) {
      break;
    }
    resultLines.push(line);
    remainingTokens -= lineTokens;
    if (resultLines.length >= maxLines) {
      break;
    }
  }

  const excerpt = resultLines.join("\n");
  const truncated = resultLines.length < excerptLines.length;

  const startLine = resultLines.length > 0 ? excerptLineNumbers[0] + 1 : 1;
  const lastIndex = Math.min(
    resultLines.length - 1,
    excerptLineNumbers.length - 1,
  );
  const endLine =
    resultLines.length > 0 ? excerptLineNumbers[lastIndex] + 1 : startLine;

  const actualRange: Range = {
    startLine,
    startCol: 0,
    endLine,
    endCol: resultLines[resultLines.length - 1]?.length ?? 0,
  };

  return {
    excerpt,
    matchedIdentifiers: [],
    matchedLineNumbers,
    truncated,
    actualRange,
  };
}

export async function extractHotPath(
  repoId: RepoId,
  symbolId: SymbolId,
  identifiersToFind: string[],
  options: HotPathOptions = {},
): Promise<HotPathResult | null> {
  const conn = await getKuzuConn();

  const symbol = await kuzuDb.getSymbol(conn, symbolId);
  if (!symbol) return null;

  if (symbol.repoId !== repoId) return null;

  const files = await kuzuDb.getFilesByIds(conn, [symbol.fileId]);
  const file = files.get(symbol.fileId);
  if (!file) return null;

  const repo = await kuzuDb.getRepo(conn, repoId);
  if (!repo) return null;

  const filePath = getAbsolutePathFromRepoRoot(repo.rootPath, file.relPath);
  const extension = file.relPath.split(".").pop() || "";

  let content: string;
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      logger.warn("File exceeds size limit for hot path extraction", {
        filePath: file.relPath,
        fileSize: fileStat.size,
        maxFileBytes: MAX_FILE_BYTES,
      });
      return null;
    }
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    logger.warn("Failed to read file for hot path extraction", {
      filePath: file.relPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const tree = parseFile(content, `.${extension}`);

  if (!tree) {
    return null;
  }

  // Wrap tree-sitter node traversal in try/catch. The walk() function
  // recursively visits every node which can throw if the native addon
  // encounters a corrupted tree or unexpected node structure.
  try {
    const lines = content.split("\n");

    const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES_HOTPATH;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS_HOTPATH;

    const { matchedLines, confirmedIdentifiers } = findLinesMatchingIdentifiers(
      tree,
      identifiersToFind,
    );

    const { excerpt, matchedLineNumbers, truncated, actualRange } =
      buildHotPathExcerpt(
        lines,
        matchedLines,
        contextLines,
        maxLines,
        maxTokens,
      );

    return {
      excerpt,
      actualRange,
      estimatedTokens: estimateTokenCount(excerpt),
      matchedIdentifiers: Array.from(confirmedIdentifiers),
      matchedLineNumbers,
      truncated,
    };
  } catch (error) {
    logger.error("Tree-sitter traversal failed during hot-path extraction", {
      symbolId,
      file: file.relPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
