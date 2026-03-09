import { readFile, stat } from "fs/promises";
import { REGEX_CACHE_MAX_SIZE, REGEX_CACHE_EVICT_COUNT } from "../config/constants.js";
import { join } from "path";
import type { RepoId, SymbolId } from "../db/schema.js";
import type { CodeWindowResponse, Range } from "../domain/types.js";
import { normalizePath } from "../util/paths.js";
import { estimateTokens as estimateTokenCount } from "../util/tokenize.js";
import { MAX_FILE_BYTES } from "../config/constants.js";
import { logger } from "../util/logger.js";
import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";

export async function extractCodeWindow(
  repoId: RepoId,
  symbolId: SymbolId,
): Promise<CodeWindowResponse | null> {
  const conn = await getKuzuConn();

  const symbol = await kuzuDb.getSymbol(conn, symbolId);
  if (!symbol) return null;
  if (symbol.repoId !== repoId) return null;

  const files = await kuzuDb.getFilesByIds(conn, [symbol.fileId]);
  const file = files.get(symbol.fileId);
  if (!file) return null;

  const repo = await kuzuDb.getRepo(conn, repoId);
  if (!repo) return null;

  const filePath = join(repo.rootPath, file.relPath);

  let fileContent: string;
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      logger.warn("File exceeds size limit for code window", {
        filePath: file.relPath,
        fileSize: fileStat.size,
        maxFileBytes: MAX_FILE_BYTES,
      });
      return null;
    }
    fileContent = await readFile(filePath, "utf-8");
  } catch (error) {
    logger.warn("Failed to read file for code window", {
      filePath: file.relPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const lines = fileContent.split("\n");

  const startLine = symbol.rangeStartLine;
  const endLine = symbol.rangeEndLine;

  if (startLine < 1 || endLine > lines.length || startLine > endLine) {
    return null;
  }

  const codeLines = lines.slice(startLine - 1, endLine);
  const code = codeLines.join("\n");

  const range: Range = {
    startLine,
    startCol: symbol.rangeStartCol,
    endLine,
    endCol: symbol.rangeEndCol,
  };

  const estimatedTokens = Math.ceil(code.length / 4);

  return {
    approved: true,
    repoId,
    symbolId,
    file: file.relPath,
    range,
    code,
    whyApproved: [],
    estimatedTokens,
  };
}

const identifierRegexCache = new Map<string, RegExp>();

export function identifiersExistInWindow(
  code: string,
  identifiers: string[],
): boolean {
  if (identifiers.length === 0) return false;

  const cacheKey = identifiers.slice().sort().join("|");
  let regex = identifierRegexCache.get(cacheKey);
  if (!regex) {
    const escapedIdentifiers = identifiers.map((id) =>
      id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    regex = new RegExp(
      `(?<![_\\w$])(${escapedIdentifiers.join("|")})(?![_\\w$])`,
      "g",
    );
    identifierRegexCache.set(cacheKey, regex);
    if (identifierRegexCache.size > REGEX_CACHE_MAX_SIZE) {
      const keysToDelete = Array.from(identifierRegexCache.keys()).slice(0, REGEX_CACHE_EVICT_COUNT);
      for (const key of keysToDelete) {
        identifierRegexCache.delete(key);
      }
    }
  }

  // Reset lastIndex for global regex reuse
  regex.lastIndex = 0;
  const matches = code.match(regex);

  if (!matches) return false;

  const found = new Set(matches.map((m) => m.toLowerCase()));
  return identifiers.every((id) => found.has(id.toLowerCase()));
}

export interface ExtractWindowResult {
  code: string;
  actualRange: Range;
  estimatedTokens: number;
  originalLines: number;
  originalTokens: number;
  truncated: boolean;
}

export async function extractWindow(
  filePath: string,
  range: Range,
  granularity: "symbol" | "block" | "fileWindow",
  maxLines: number,
  maxTokens: number,
): Promise<ExtractWindowResult> {
  const resolvedPath = normalizePath(filePath);

  let content: string;
  try {
    const fileStat = await stat(resolvedPath);
    if (fileStat.size > MAX_FILE_BYTES) {
      return {
        code: "",
        actualRange: { startLine: range.startLine, startCol: 0, endLine: range.startLine, endCol: 0 },
        estimatedTokens: 0,
        originalLines: 0,
        originalTokens: 0,
        truncated: true,
      };
    }
    content = await readFile(resolvedPath, "utf-8");
  } catch (error) {
    logger.warn("Failed to read file for extract window", {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      code: "",
      actualRange: { startLine: range.startLine, startCol: 0, endLine: range.startLine, endCol: 0 },
      estimatedTokens: 0,
      originalLines: 0,
      originalTokens: 0,
      truncated: true,
    };
  }

  const normalizedContent = normalizeLineEndings(content);
  const lines = splitLines(normalizedContent);

  let startLine = range.startLine;
  let endLine = range.endLine;

  if (granularity === "block") {
    const expanded = expandToBlock(lines, range);
    startLine = expanded.startLine;
    endLine = expanded.endLine;
  } else if (granularity === "fileWindow") {
    const windowSize = maxLines;
    const centered = centerOnSymbol(normalizedContent, range, windowSize);
    const boundedCode = applyBounds(centered.code, maxLines, maxTokens);
    const boundedLines = splitLines(boundedCode);
    const estimatedTokens = estimateTokenCount(boundedCode);
    const boundedLength = boundedLines.length;
    const endLine =
      boundedLength > 0
        ? centered.actualRange.startLine + boundedLength - 1
        : centered.actualRange.startLine;
    const truncated =
      centered.originalLines > maxLines ||
      centered.originalTokens > maxTokens ||
      boundedLength < centered.originalLines ||
      estimatedTokens < centered.originalTokens;

    return {
      code: boundedCode,
      actualRange: {
        startLine: centered.actualRange.startLine,
        startCol: 0,
        endLine,
        endCol: boundedLines[boundedLines.length - 1]?.length ?? 0,
      },
      estimatedTokens,
      originalLines: centered.originalLines,
      originalTokens: centered.originalTokens,
      truncated,
    };
  }

  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length, endLine);
  const selectedLines = lines.slice(startIndex, endIndex);
  const originalCode = selectedLines.join("\n");
  const originalTokens = estimateTokenCount(originalCode);

  const boundedCode = applyBounds(
    selectedLines.join("\n"),
    maxLines,
    maxTokens,
  );
  const boundedLines = splitLines(boundedCode);
  const finalEndLine = startIndex + boundedLines.length;

  const estimatedTokens = estimateTokenCount(boundedCode);
  const originalLines = selectedLines.length;
  const truncated = originalLines > maxLines || originalTokens > maxTokens;

  return {
    code: boundedCode,
    actualRange: {
      startLine: startIndex + 1,
      startCol: 0,
      endLine: finalEndLine,
      endCol: boundedLines[boundedLines.length - 1]?.length ?? 0,
    },
    estimatedTokens,
    originalLines,
    originalTokens,
    truncated,
  };
}

export function applyBounds(
  code: string,
  maxLines: number,
  maxTokens: number,
): string {
  const lines = splitLines(code);
  const tokenCount = estimateTokenCount(code);

  if (tokenCount <= maxTokens && lines.length <= maxLines) {
    return code;
  }

  let remainingTokens = maxTokens;
  const result: string[] = [];

  for (const line of lines) {
    const lineTokens = estimateTokenCount(line);
    if (lineTokens > remainingTokens) {
      break;
    }
    result.push(line);
    remainingTokens -= lineTokens;
    if (result.length >= maxLines) {
      break;
    }
  }

  return result.join("\n");
}

export function centerOnSymbol(
  fileContent: string,
  symbolRange: Range,
  windowSize: number,
): ExtractWindowResult {
  const lines = splitLines(fileContent);
  const centerLine = Math.floor(
    (symbolRange.startLine + symbolRange.endLine) / 2,
  );
  const halfWindow = Math.floor(windowSize / 2);

  const startLine = Math.max(0, centerLine - halfWindow);
  const endLine = Math.min(lines.length, centerLine + halfWindow);

  const selectedLines = lines.slice(startLine, endLine);
  const code = selectedLines.join("\n");
  const estimatedTokens = estimateTokenCount(code);
  const originalTokens = estimatedTokens;
  const originalLines = selectedLines.length;

  return {
    code,
    actualRange: {
      startLine: startLine + 1,
      startCol: 0,
      endLine: startLine + selectedLines.length,
      endCol: selectedLines[selectedLines.length - 1]?.length ?? 0,
    },
    estimatedTokens,
    originalLines,
    originalTokens,
    truncated: false,
  };
}

export function estimateTokens(code: string): number {
  return estimateTokenCount(code);
}

export function expandToBlock(lines: string[], range: Range): Range {
  let startLine = range.startLine;
  let endLine = range.endLine;

  const blockKeywords = [
    "function",
    "class",
    "interface",
    "type",
    "enum",
    "const",
    "let",
    "var",
    "if",
    "for",
    "while",
    "switch",
    "try",
  ];

  let braceCount = 0;
  let inBlock = false;

  for (let i = startLine - 1; i >= 0; i--) {
    const line = lines[i].trim();

    if (line.includes("{")) {
      braceCount++;
      inBlock = true;
    }
    if (line.includes("}")) {
      braceCount--;
    }

    if (braceCount === 0 && inBlock) {
      startLine = i + 1;
      break;
    }

    if (braceCount === 0 && blockKeywords.some((kw) => line.startsWith(kw))) {
      startLine = i + 1;
      break;
    }
  }

  braceCount = 0;
  inBlock = false;

  for (let i = endLine - 1; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.includes("{")) {
      braceCount++;
      inBlock = true;
    }
    if (line.includes("}")) {
      braceCount--;
    }

    if (braceCount === 0 && inBlock) {
      endLine = i + 1;
      break;
    }
  }

  return {
    startLine,
    startCol: 0,
    endLine,
    endCol: lines[endLine - 1]?.length ?? 0,
  };
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function splitLines(content: string): string[] {
  return content.split("\n");
}
