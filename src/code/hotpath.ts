import { readFileSync } from "fs";
import type { RepoId, SymbolId } from "../db/schema.js";
import type { Range } from "../mcp/types.js";
import { getSymbol, getFile, getRepo } from "../db/queries.js";
import { getAbsolutePathFromRepoRoot } from "../util/paths.js";
import { estimateTokens as estimateTokenCount } from "../util/tokenize.js";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import {
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_LINES_HOTPATH,
  DEFAULT_MAX_TOKENS_HOTPATH,
} from "../config/constants.js";

const tsParser = new Parser();
const tsxParser = new Parser();

tsParser.setLanguage(TypeScript.typescript);
tsxParser.setLanguage(TypeScript.tsx);

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
    const isTS = extension === ".ts";
    const isTSX = extension === ".tsx";
    const isJS = extension === ".js";
    const isJSX = extension === ".jsx";

    if (!isTS && !isTSX && !isJS && !isJSX) {
      return null;
    }

    const parser = isTS ? tsParser : tsxParser;
    // Use 1MB buffer to handle files >32KB (tree-sitter default limit)
    const tree = parser.parse(content, undefined, {
      bufferSize: 1024 * 1024,
    });

    if (!tree || tree.rootNode.hasError) {
      return null;
    }

    return tree;
  } catch (error) {
    process.stderr.write(
      `[sdl-mcp] Failed to parse file for hot path (extension: ${extension}): ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return null;
  }
}

function findLinesMatchingIdentifiers(
  tree: Parser.Tree,
  identifiersToFind: string[],
): Set<number> {
  const matchedLines = new Set<number>();

  if (identifiersToFind.length === 0) {
    return matchedLines;
  }

  const identifierSet = new Set<string>(identifiersToFind);

  function matchesExactIdentifier(text: string): boolean {
    if (identifierSet.has(text)) {
      return true;
    }
    return false;
  }

  function matchesAsMemberExpression(text: string): boolean {
    const parts = text.split(".");
    return parts.some((part) => identifierSet.has(part));
  }

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "identifier") {
      if (matchesExactIdentifier(node.text)) {
        matchedLines.add(node.startPosition.row + 1);
      }
    }

    if (node.type === "call_expression") {
      const funcNode = node.childForFieldName("function");
      if (funcNode) {
        if (funcNode.type === "identifier") {
          if (matchesExactIdentifier(funcNode.text)) {
            matchedLines.add(node.startPosition.row + 1);
          }
        } else if (funcNode.type === "member_expression") {
          if (matchesAsMemberExpression(funcNode.text)) {
            matchedLines.add(node.startPosition.row + 1);
          }
        }
      }
    }

    if (node.type === "throw_statement") {
      const thrown = node.childForFieldName("value");
      if (thrown) {
        if (thrown.type === "new_expression") {
          const constructorNode = thrown.childForFieldName("constructor");
          if (constructorNode && constructorNode.type === "identifier") {
            if (matchesExactIdentifier(constructorNode.text)) {
              matchedLines.add(node.startPosition.row + 1);
            }
          }
        } else if (thrown.type === "identifier") {
          if (matchesExactIdentifier(thrown.text)) {
            matchedLines.add(node.startPosition.row + 1);
          }
        }
      }
    }

    Array.from(node.children).forEach((child) => {
      walk(child);
    });
  }

  walk(tree.rootNode);
  return matchedLines;
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
    const excerptLines = lines.slice(0, Math.min(maxLines, lines.length));
    const excerpt = excerptLines.join("\n");
    return {
      excerpt,
      matchedIdentifiers: [],
      matchedLineNumbers: [],
      truncated: excerptLines.length < lines.length,
      actualRange: {
        startLine: 1,
        startCol: 0,
        endLine: excerptLines.length,
        endCol: excerptLines[excerptLines.length - 1]?.length ?? 0,
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
  const endLine =
    resultLines.length > 0
      ? excerptLineNumbers[resultLines.length - 1] + 1
      : startLine;

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

export function extractHotPath(
  repoId: RepoId,
  symbolId: SymbolId,
  identifiersToFind: string[],
  options: HotPathOptions = {},
): HotPathResult | null {
  const symbol = getSymbol(symbolId);
  if (!symbol) return null;

  const file = getFile(symbol.file_id);
  if (!file) return null;

  const repo = getRepo(repoId);
  if (!repo) return null;

  const filePath = getAbsolutePathFromRepoRoot(repo.root_path, file.rel_path);
  const extension = file.rel_path.split(".").pop() || "";

  const content = readFileSync(filePath, "utf-8");
  const tree = parseFile(content, `.${extension}`);

  if (!tree) {
    return null;
  }

  const lines = content.split("\n");

  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES_HOTPATH;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS_HOTPATH;

  const matchedLines = findLinesMatchingIdentifiers(tree, identifiersToFind);

  const { excerpt, matchedLineNumbers, truncated, actualRange } =
    buildHotPathExcerpt(lines, matchedLines, contextLines, maxLines, maxTokens);

  return {
    excerpt,
    actualRange,
    estimatedTokens: estimateTokenCount(excerpt),
    matchedIdentifiers: identifiersToFind,
    matchedLineNumbers,
    truncated,
  };
}
