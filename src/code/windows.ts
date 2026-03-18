import { readFile, stat } from "fs/promises";

import type { RepoId, SymbolId } from "../db/schema.js";
import type { CodeWindowResponse, Range } from "../domain/types.js";
import {
  MAX_FILE_BYTES,
  REGEX_CACHE_MAX_SIZE,
  REGEX_CACHE_EVICT_COUNT,
} from "../config/constants.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";
import { normalizePath, getAbsolutePathFromRepoRoot } from "../util/paths.js";
import { estimateTokens as estimateTokenCount } from "../util/tokenize.js";

export async function extractCodeWindow(
  repoId: RepoId,
  symbolId: SymbolId,
): Promise<CodeWindowResponse | null> {
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

// Validate cache eviction constants (M4)
if (REGEX_CACHE_EVICT_COUNT < 1) {
  throw new Error(
    `REGEX_CACHE_EVICT_COUNT must be >= 1, got ${REGEX_CACHE_EVICT_COUNT}`,
  );
}
if (REGEX_CACHE_MAX_SIZE < REGEX_CACHE_EVICT_COUNT) {
  throw new Error(
    `REGEX_CACHE_MAX_SIZE (${REGEX_CACHE_MAX_SIZE}) must be >= REGEX_CACHE_EVICT_COUNT (${REGEX_CACHE_EVICT_COUNT})`,
  );
}

const identifierRegexCache = new Map<string, RegExp>();

export function identifiersExistInWindow(
  code: string,
  identifiers: string[],
): boolean {
  if (identifiers.length === 0) return false;

  const cacheKey = identifiers.slice().sort().join("|");
  let regex = identifierRegexCache.get(cacheKey);
  if (regex) {
    // Refresh LRU position
    identifierRegexCache.delete(cacheKey);
    identifierRegexCache.set(cacheKey, regex);
  } else {
    const escapedIdentifiers = identifiers.map((id) =>
      id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    regex = new RegExp(
      `(?<![_\\w$])(${escapedIdentifiers.join("|")})(?![_\\w$])`,
      "g",
    );
    identifierRegexCache.set(cacheKey, regex);
    if (identifierRegexCache.size > REGEX_CACHE_MAX_SIZE) {
      const keysToDelete = Array.from(identifierRegexCache.keys()).slice(
        0,
        REGEX_CACHE_EVICT_COUNT,
      );
      for (const key of keysToDelete) {
        identifierRegexCache.delete(key);
      }
    }
  }

  // Reset lastIndex for global regex reuse
  regex.lastIndex = 0;
  const matches = code.match(regex);

  if (!matches) return false;

  const found = new Set(matches);
  return identifiers.every((id) => found.has(id));
}

export type EmptyReason = "file-too-large" | "io-error" | "token-budget-exceeded";

export interface ExtractWindowResult {
  code: string;
  actualRange: Range;
  estimatedTokens: number;
  originalLines: number;
  originalTokens: number;
  truncated: boolean;
  emptyReason?: EmptyReason;
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
        actualRange: {
          startLine: range.startLine,
          startCol: 0,
          endLine: range.startLine,
          endCol: 0,
        },
        estimatedTokens: 0,
        originalLines: 0,
        originalTokens: 0,
        truncated: true,
        emptyReason: "file-too-large",
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
      actualRange: {
        startLine: range.startLine,
        startCol: 0,
        endLine: range.startLine,
        endCol: 0,
      },
      estimatedTokens: 0,
      originalLines: 0,
      originalTokens: 0,
      truncated: true,
      emptyReason: "io-error",
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
    emptyReason: boundedCode === "" && originalLines > 0 ? "token-budget-exceeded" : undefined,
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

/**
 * Count braces in a line while skipping those inside string literals,
 * template literal bodies, block comments, and line comments.
 *
 * Template literal interpolations (${...}) are handled: braces that form
 * the interpolation syntax are not counted, but real braces inside the
 * interpolation expression ARE counted.
 *
 * Block comment state (`inBlockComment`) is accepted and returned so the
 * caller can track multi-line block-comment spans across consecutive lines.
 * (Line-level single-line block comments are also handled within a single call.)
 */
function countBracesOutsideStrings(
  line: string,
  inBlockComment = false,
): { open: number; close: number; inBlockComment: boolean } {
  let open = 0;
  let close = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  // Depth of nested ${...} interpolations inside template literals.
  // 0 = not in any interpolation. Each ${ pushes +1, matching } pops -1.
  let interpDepth = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (inLineComment) break; // rest of line is comment

    // ---- Block comment state ----
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++; // skip the /
      }
      continue;
    }

    // ---- Escape sequences inside strings ----
    if ((inSingle || inDouble || inTemplate) && ch === "\\") {
      i++; // skip escaped character
      continue;
    }

    // ---- Template literal interpolation: ${...} enters code mode ----
    if (inTemplate && ch === "$" && next === "{") {
      interpDepth++;
      inTemplate = false;
      i++; // skip the { (it is interpolation syntax, not a real brace)
      continue;
    }

    // ---- String state transitions ----
    if (!inDouble && !inTemplate && ch === "'" && !inSingle) {
      inSingle = true;
      continue;
    }
    if (inSingle && ch === "'") {
      inSingle = false;
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"' && !inDouble) {
      inDouble = true;
      continue;
    }
    if (inDouble && ch === '"') {
      inDouble = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "`" && !inTemplate) {
      inTemplate = true;
      continue;
    }
    if (inTemplate && ch === "`") {
      inTemplate = false;
      continue;
    }

    // Skip content inside string bodies
    if (inSingle || inDouble || inTemplate) continue;

    // ---- Line comment detection ----
    if (ch === "/" && next === "/") {
      inLineComment = true;
      continue;
    }

    // ---- Block comment detection ----
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++; // skip the *
      continue;
    }

    // ---- Brace counting (code mode) ----
    if (ch === "{") {
      if (interpDepth > 0) {
        // Nested brace inside a template interpolation — track depth
        // so we know which } closes the interpolation vs. an inner block.
        interpDepth++;
      }
      open++;
    } else if (ch === "}") {
      if (interpDepth > 0) {
        interpDepth--;
        if (interpDepth === 0) {
          // This } closes the ${...} interpolation — return to template mode.
          // Do not count it as a real brace.
          inTemplate = true;
          continue;
        }
      }
      close++;
    }
  }

  return { open, close, inBlockComment };
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

  // Backward scan: walk upward looking for the opening brace of the
  // enclosing block. braceCount tracks net balance: each `{` increments
  // (we found a block opener) and each `}` decrements (we entered a
  // nested block going upward). When braceCount returns to 0 after
  // having been positive, we've found the balanced block boundary.
  // Note: inBlockComment state is not chained across lines during backward
  // traversal because we'd need to scan from file start to know the true
  // state. Single-line /* ... */ within each line IS still handled.
  for (let i = startLine - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const { open, close } = countBracesOutsideStrings(lines[i]);

    if (open > 0) {
      braceCount += open;
      inBlock = true;
    }
    if (close > 0) {
      braceCount -= close;
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

  // Forward scan chains inBlockComment state across lines so multi-line
  // /* ... */ comments are correctly skipped.
  let fwdBlockComment = false;
  for (let i = endLine - 1; i < lines.length; i++) {
    const result = countBracesOutsideStrings(lines[i], fwdBlockComment);
    fwdBlockComment = result.inBlockComment;
    const { open, close } = result;

    if (open > 0) {
      braceCount += open;
      inBlock = true;
    }
    if (close > 0) {
      braceCount -= close;
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
