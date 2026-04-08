import { readFile, stat } from "fs/promises";

import type Parser from "tree-sitter";

import type { RepoId, SymbolId } from "../domain/types.js";
import type { Range } from "../domain/types.js";
import {
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_LINES_HOTPATH,
  DEFAULT_MAX_TOKENS_HOTPATH,
  MAX_FILE_BYTES,
} from "../config/constants.js";
import { logger } from "../util/logger.js";
import { getAbsolutePathFromRepoRoot } from "../util/paths.js";
import { estimateTokens as estimateTokenCount } from "../util/tokenize.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { parseFile } from "./skeleton.js";

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
    if (node.type === "identifier" || node.type === "property_identifier") {
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

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(tree.rootNode);
  return { matchedLines, confirmedIdentifiers };
}

export function buildHotPathExcerpt(
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

  const resultLines: string[] = [];
  let remainingTokens = maxTokens;
  let prevLineIdx: number | null = null;
  let consumedLines = 0;
  let truncated = false;
  let lastCodeLineLength = 0;

  for (const lineIdx of excerptLineNumbers) {
    // Insert a gap marker between non-contiguous excerpt windows so the
    // consumer can see lines were skipped instead of treating merged
    // windows as one continuous block.
    if (prevLineIdx !== null && lineIdx > prevLineIdx + 1) {
      const gap = lineIdx - prevLineIdx - 1;
      const sep = `  // ... (${gap} line${gap === 1 ? "" : "s"} skipped)`;
      const sepTokens = estimateTokenCount(sep);
      if (sepTokens <= remainingTokens) {
        resultLines.push(sep);
        remainingTokens -= sepTokens;
      }
    }
    const line = lines[lineIdx];
    const lineTokens = estimateTokenCount(line);
    if (lineTokens > remainingTokens) {
      truncated = true;
      break;
    }
    resultLines.push(line);
    remainingTokens -= lineTokens;
    lastCodeLineLength = line.length;
    prevLineIdx = lineIdx;
    consumedLines++;
    if (consumedLines >= maxLines) {
      if (consumedLines < excerptLineNumbers.length) truncated = true;
      break;
    }
  }

  const excerpt = resultLines.join("\n");

  const startLine = consumedLines > 0 ? excerptLineNumbers[0] + 1 : 1;
  const lastConsumedIdx = consumedLines - 1;
  const endLine =
    consumedLines > 0 ? excerptLineNumbers[lastConsumedIdx] + 1 : startLine;

  const actualRange: Range = {
    startLine,
    startCol: 0,
    endLine,
    endCol: lastCodeLineLength,
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
  const conn = await getLadybugConn();

  const symbol = await ladybugDb.getSymbol(conn, symbolId);
  if (!symbol) return null;

  if (symbol.repoId !== repoId) return null;

  const files = await ladybugDb.getFilesByIds(conn, [symbol.fileId]);
  const file = files.get(symbol.fileId);
  if (!file) return null;

  const repo = await ladybugDb.getRepo(conn, repoId);
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
    content = (await readFile(filePath, "utf-8")).replace(/\r\n/g, "\n");
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

    // Filter matched lines to symbol range so we don't return unrelated code
    const symStart = symbol.rangeStartLine ?? 1;
    const symEnd = symbol.rangeEndLine ?? lines.length;
    const rangeFilteredLines = new Set<number>();
    matchedLines.forEach((line) => {
      if (line >= symStart && line <= symEnd) {
        rangeFilteredLines.add(line);
      }
    });

    // If no identifiers matched within symbol range, use symbol start as anchor
    // so the excerpt centers on the symbol body instead of the file start
    const effectiveMatchedLines = rangeFilteredLines.size > 0
      ? rangeFilteredLines
      : new Set<number>([symStart]);

    const { excerpt, matchedLineNumbers, truncated, actualRange } =
      buildHotPathExcerpt(
        lines,
        effectiveMatchedLines,
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
