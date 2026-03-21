import { createHash } from "crypto";
import { readFile, stat } from "fs/promises";

import Parser from "tree-sitter";

import type { RepoId, SymbolId } from "../db/schema.js";
import type { Range, SkeletonOp, SkeletonIR } from "../domain/types.js";
import {
  DEFAULT_MAX_LINES_SKELETON,
  DEFAULT_MAX_TOKENS_SKELETON,
  DEFAULT_MAX_LINES_SKELETON_DETAILED,
  DEFAULT_MAX_TOKENS_SKELETON_DETAILED,
  MAX_FILE_BYTES,
  MAX_TREESITTER_PARSE_BYTES,
} from "../config/constants.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { getParser as getGrammarParser } from "../indexer/treesitter/grammarLoader.js";
import { logger } from "../util/logger.js";
import { getAbsolutePathFromRepoRoot } from "../util/paths.js";
import { estimateTokens as estimateTokenCount } from "../util/tokenize.js";
import { tsParser, tsxParser } from "./ts-parsers.js";

export interface SkeletonResult {
  skeleton: string;
  actualRange: Range;
  estimatedTokens: number;
  originalLines: number;
  truncated: boolean;
  skeletonLinesConsumed?: number;
}

export interface SkeletonIRResult {
  ir: SkeletonIR;
  skeletonText: string;
  actualRange: Range;
  estimatedTokens: number;
  originalLines: number;
}

export interface SkeletonOptions {
  maxLines?: number;
  maxTokens?: number;
  includeIdentifiers?: string[];
  skeletonOffset?: number;
}

/**
 * Node types that represent top-level containers (file/module root).
 * These get their children recursively processed.
 */
const ROOT_CONTAINER_TYPES = new Set([
  // JS/TS
  "source_file",
  "program",
  // Python
  "module",
  // Go, Rust, C/C++
  "translation_unit",
]);

/**
 * Node types that are rendered verbatim (imports, type declarations).
 */
const VERBATIM_TYPES = new Set([
  // JS/TS
  "import_statement",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  // Python
  "import_from_statement",
  // Go
  "import_declaration",
  // Rust
  "use_declaration",
  // Java/Kotlin/C#
  "import_declaration",
  // C/C++
  "preproc_include",
  "preproc_def",
]);

/**
 * Node types for functions/classes/methods that have a body to elide.
 */
const FUNCTION_LIKE_TYPES = new Set([
  // JS/TS
  "function_declaration",
  "class_declaration",
  "method_definition",
  // Python
  "function_definition",
  "class_definition",
  // Go
  "function_declaration",
  "method_declaration",
  // Rust
  "function_item",
  "impl_item",
  "struct_item",
  // Java/Kotlin/C#
  "method_declaration",
  "constructor_declaration",
  // C/C++
  "function_definition",
]);

/**
 * Node types that represent function/class bodies across languages.
 */
const BODY_TYPES = new Set([
  // JS/TS
  "statement_block",
  // Python
  "block",
  // Go, Rust, Java, C#, C/C++
  "block",
  "compound_statement",
  "declaration_list",
  "field_declaration_list",
  "class_body",
]);

export function extractSkeletonFromNode(
  node: Parser.SyntaxNode,
  content: string,
  includeIdentifiers: string[],
  depth: number = 0,
  exportedOnly: boolean = false,
): string {
  const nodeType = node.type;

  // Root containers: process children
  if (ROOT_CONTAINER_TYPES.has(nodeType)) {
    let result = "";
    // First pass: imports
    for (const child of node.children) {
      if (VERBATIM_TYPES.has(child.type) || child.type === "export_statement") {
        result += extractSkeletonFromNode(
          child,
          content,
          includeIdentifiers,
          depth,
          exportedOnly,
        );
      }
    }
    // Second pass: non-imports
    if (!exportedOnly) {
      for (const child of node.children) {
        if (
          !VERBATIM_TYPES.has(child.type) &&
          child.type !== "export_statement"
        ) {
          result += extractSkeletonFromNode(
            child,
            content,
            includeIdentifiers,
            depth,
            exportedOnly,
          );
        }
      }
    }
    return result;
  }

  // Verbatim types: render as-is
  if (VERBATIM_TYPES.has(nodeType)) {
    return node.text + "\n";
  }

  // Python: import_statement (different from JS import_statement handled above)
  if (nodeType === "import_statement" && !node.text.startsWith("import {")) {
    return node.text + "\n";
  }

  // Export statement (JS/TS)
  if (nodeType === "export_statement") {
    let result = "export ";
    for (const child of node.children) {
      if (child.type !== "export") {
        result += extractSkeletonFromNode(
          child,
          content,
          includeIdentifiers,
          depth,
        );
      }
    }
    return result;
  }

  // Variable declaration (JS/TS)
  if (nodeType === "variable_declaration") {
    const isExported = node.children.some(
      (c) => c.type === "export_clause" || c.text === "export",
    );
    if (isExported) {
      const lines = node.text.split("\n");
      const firstLine = lines[0] || "";
      if (lines.length > 3) {
        return firstLine + "\n// …\n";
      }
      return node.text + "\n";
    }
    return "";
  }

  // Python: decorated_definition — unwrap and process the inner definition
  if (nodeType === "decorated_definition") {
    let result = "";
    for (const child of node.children) {
      if (child.type === "decorator") {
        result += child.text + "\n";
      } else {
        result += extractSkeletonFromNode(
          child,
          content,
          includeIdentifiers,
          depth,
          exportedOnly,
        );
      }
    }
    return result;
  }

  // Rust: type declarations rendered verbatim
  if (
    nodeType === "struct_item" ||
    nodeType === "enum_item" ||
    nodeType === "trait_item" ||
    nodeType === "type_item"
  ) {
    const lines = node.text.split("\n");
    if (lines.length > 5) {
      const firstLine = lines[0] || "";
      return firstLine + "\n// …\n";
    }
    return node.text + "\n";
  }

  // Go: type_declaration rendered verbatim
  if (nodeType === "type_declaration") {
    const lines = node.text.split("\n");
    if (lines.length > 5) {
      const firstLine = lines[0] || "";
      return firstLine + "\n// …\n";
    }
    return node.text + "\n";
  }

  // Function/class/method-like types: extract signature + elide body
  if (FUNCTION_LIKE_TYPES.has(nodeType)) {
    const lines = node.text.split("\n");
    const signature = lines[0] || "";

    // Find the body node using the language-agnostic body type set
    const bodyNode = node.children.find((c) => BODY_TYPES.has(c.type));
    if (!bodyNode) {
      // No body (e.g., abstract method, forward declaration)
      return node.text + "\n";
    }

    const bodySkeleton = extractSkeletonFromBody(
      bodyNode,
      content,
      includeIdentifiers,
    );

    // Python uses indentation, not braces
    if (nodeType === "function_definition" || nodeType === "class_definition") {
      return signature + "\n" + bodySkeleton;
    }

    const result = signature + " {\n" + bodySkeleton + "}\n";
    return result;
  }

  // Arrow function (JS/TS)
  if (nodeType === "arrow_function") {
    const lines = node.text.split("\n");
    const signature = lines[0] || "";

    const hasBody = node.children.some((c) => c.type === "statement_block");
    if (!hasBody) {
      return node.text;
    }

    const bodyNode = node.children.find((c) => c.type === "statement_block");
    if (!bodyNode) {
      return node.text;
    }

    const bodySkeleton = extractSkeletonFromBody(
      bodyNode,
      content,
      includeIdentifiers,
    );

    return signature + " {\n" + bodySkeleton + "}";
  }

  // Body blocks: delegate to body extraction
  if (BODY_TYPES.has(nodeType)) {
    return extractSkeletonFromBody(node, content, includeIdentifiers);
  }

  return node.text;
}

/**
 * Node types that represent return/throw/raise across languages.
 */
const RETURN_LIKE_TYPES = new Set([
  "return_statement",
  "throw_statement",
  // Python
  "return_statement",
  "raise_statement",
  // Go
  "return_statement",
  // Rust
  "return_expression",
]);

function extractSkeletonFromBody(
  bodyNode: Parser.SyntaxNode,
  content: string,
  includeIdentifiers: string[],
): string {
  let result = "";
  const lines = bodyNode.text.split("\n");

  if (lines.length <= 5) {
    return bodyNode.text;
  }

  let processedStatements = 0;

  for (const child of bodyNode.children) {
    const childType = child.type;
    const childText = child.text.trim();

    // Skip whitespace/comment-only nodes
    if (
      !childText ||
      childType === "comment" ||
      childType === "line_comment" ||
      childType === "block_comment"
    ) {
      continue;
    }

    // Lexical declarations (JS/TS: const/let/var)
    if (childType === "lexical_declaration") {
      const hasImportantIdentifier = includeIdentifiers.some((id) =>
        childText.includes(id),
      );

      if (hasImportantIdentifier) {
        result += child.text.trim() + "\n";
        processedStatements++;
      }
    }
    // Expression statements (common across languages)
    else if (childType === "expression_statement") {
      const isReturn = child.children.some((c) =>
        RETURN_LIKE_TYPES.has(c.type),
      );
      const isThrow = child.children.some((c) => c.type === "throw_statement");

      const hasImportantIdentifier =
        includeIdentifiers.some((id) => childText.includes(id));

      if (isReturn || isThrow || hasImportantIdentifier) {
        result += child.text.trim() + "\n";
        processedStatements++;
      }
    }
    // Return/raise/throw statements (when they appear directly, not inside expression_statement)
    else if (RETURN_LIKE_TYPES.has(childType)) {
      result += child.text.trim() + "\n";
      processedStatements++;
    }
    // If statements (language-agnostic)
    else if (childType === "if_statement" || childType === "if_expression") {
      const condition = child.children.find(
        (c) =>
          c.type === "parenthesized_expression" ||
          c.type === "condition_clause",
      );
      const conditionText = condition ? condition.text : "";
      const thenBlock = child.children.find((c) => BODY_TYPES.has(c.type));
      const elseBlock = child.children.find((c) => c.text.startsWith("else"));

      let ifLine = "if " + conditionText;
      if (thenBlock) {
        const thenSkeleton = extractSkeletonFromBody(
          thenBlock,
          content,
          includeIdentifiers,
        );
        ifLine += " {\n" + thenSkeleton + "}";
      }

      if (elseBlock) {
        const elseChild = elseBlock.children.find((c) =>
          BODY_TYPES.has(c.type),
        );
        if (elseChild) {
          const elseSkeleton = extractSkeletonFromBody(
            elseChild,
            content,
            includeIdentifiers,
          );
          ifLine += " else {\n" + elseSkeleton + "}";
        }
      }

      result += ifLine + "\n";
      processedStatements++;
    }
    // Loop statements (language-agnostic)
    else if (
      childType === "for_statement" ||
      childType === "for_in_statement" ||
      childType === "while_statement" ||
      childType === "for_expression" ||
      childType === "while_expression"
    ) {
      const condition = child.children.find(
        (c) => c.type === "parenthesized_expression",
      );
      const conditionText = condition ? condition.text : "";
      const body = child.children.find((c) => BODY_TYPES.has(c.type));

      const loopKeyword = childType
        .replace("_statement", "")
        .replace("_expression", "")
        .replace("_in", "");
      let loopLine = loopKeyword + " " + conditionText;
      if (body) {
        const bodySkeleton = extractSkeletonFromBody(
          body,
          content,
          includeIdentifiers,
        );
        loopLine += " {\n" + bodySkeleton + "}";
      }

      result += loopLine + "\n";
      processedStatements++;
    }
    // Try/catch/finally (language-agnostic)
    else if (
      childType === "try_statement" ||
      childType === "catch_clause" ||
      childType === "except_clause" ||
      childType === "finally_clause"
    ) {
      result += child.text.trim() + "\n";
      processedStatements++;
    }
    // Nested function/class definitions (Python, Go, Rust)
    else if (
      FUNCTION_LIKE_TYPES.has(childType) ||
      childType === "decorated_definition"
    ) {
      result +=
        extractSkeletonFromNode(child, content, includeIdentifiers, 1) + "\n";
      processedStatements++;
    }
    // Assignment (Python)
    else if (
      childType === "assignment" ||
      childType === "short_var_declaration"
    ) {
      const hasImportantIdentifier = includeIdentifiers.some((id) =>
        childText.includes(id),
      );
      if (hasImportantIdentifier) {
        result += child.text.trim() + "\n";
        processedStatements++;
      }
    }
  }

  if (processedStatements === 0 && lines.length > 3) {
    return "// …\n";
  }

  if (processedStatements > 0 && processedStatements < lines.length - 1) {
    const insertElision = result.lastIndexOf("\n");
    if (insertElision > 0) {
      result =
        result.slice(0, insertElision) +
        "  // …\n" +
        result.slice(insertElision + 1);
    }
  }

  return result;
}

export function trimSkeletonToBounds(
  skeleton: string,
  maxLines: number,
  maxTokens: number,
  skipLines: number = 0,
): { code: string; truncated: boolean; skeletonLinesConsumed: number } {
  const allLines = skeleton.split("\n");
  const lines = skipLines > 0 ? allLines.slice(skipLines) : allLines;

  if (skipLines === 0) {
    const tokenCount = estimateTokenCount(skeleton);
    if (lines.length <= maxLines && tokenCount <= maxTokens) {
      return { code: skeleton, truncated: false, skeletonLinesConsumed: allLines.length };
    }
  }

  const result: string[] = [];
  let remainingTokens = maxTokens;

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

  const truncated = result.length < lines.length;
  return {
    code: result.join("\n"),
    truncated,
    skeletonLinesConsumed: skipLines + result.length,
  };
}

/**
 * Maps file extensions to grammarLoader language IDs for non-JS/TS languages.
 * JS/TS uses the dedicated tsParser/tsxParser (which handle JSX/TSX correctly).
 */
export const EXTENSION_TO_LANGUAGE: Record<
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

export function parseFile(
  content: string,
  extension: string,
): Parser.Tree | null {
  try {
    // Guard: reject content exceeding the tree-sitter safety limit.
    // Buffer.byteLength is more accurate than .length for multi-byte chars.
    const byteLength = Buffer.byteLength(content, "utf-8");
    if (byteLength > MAX_TREESITTER_PARSE_BYTES) {
      logger.warn("File content exceeds tree-sitter parse limit, skipping", {
        extension,
        byteLength,
        maxBytes: MAX_TREESITTER_PARSE_BYTES,
      });
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
        logger.debug("No grammar available for skeleton generation", {
          extension,
        });
        return null;
      }
      parser = getGrammarParser(language);
      if (!parser) {
        logger.debug("Grammar parser not loaded for skeleton generation", {
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

    if (!tree) {
      return null;
    }
    // Allow partial ASTs from error recovery when the root has children
    if (tree.rootNode.hasError && tree.rootNode.childCount === 0) {
      return null;
    }

    return tree;
  } catch (error) {
    logger.warn("Failed to parse file", {
      extension,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function findNodeByRange(
  node: Parser.SyntaxNode,
  range: { startLine: number; endLine: number },
): Parser.SyntaxNode | null {
  const targetStart = range.startLine - 1; // Convert to 0-based
  const targetEnd = range.endLine - 1;

  // Check if this node SPANS (contains) the target range
  const nodeContainsRange =
    node.startPosition.row <= targetStart && node.endPosition.row >= targetEnd;

  if (!nodeContainsRange) {
    return null;
  }

  // This node contains the target range. Try to find a more specific child.
  for (const child of node.children) {
    const found = findNodeByRange(child, range);
    if (found) {
      return found;
    }
  }

  // No child contains the full target range. Return this node.
  return node;
}

export async function generateSymbolSkeleton(
  repoId: RepoId,
  symbolId: SymbolId,
  options: SkeletonOptions = {},
): Promise<SkeletonResult | null> {
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

  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      return null;
    }
  } catch (error) {
    logger.debug("Failed to stat file during symbol skeleton generation", {
      file: file.relPath,
      symbolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const content = (await readFile(filePath, "utf-8")).replace(/\r\n/g, "\n");
  const tree = parseFile(content, `.${extension}`);

  if (!tree) {
    return null;
  }

  // Wrap tree-sitter node traversal in try/catch. Native addon crashes
  // (e.g. segfaults on malformed ASTs) cannot be caught, but JS-level
  // errors thrown by the tree-sitter bindings can, and returning null
  // here prevents the error from propagating up and crashing the server.
  try {
    const symbolRange = {
      startLine: symbol.rangeStartLine,
      endLine: symbol.rangeEndLine,
    };

    const rootNode = tree.rootNode;
    const symbolNode = findNodeByRange(rootNode, symbolRange);

    if (!symbolNode) {
      return null;
    }

    const skeletonText = extractSkeletonFromNode(
      symbolNode,
      content,
      options.includeIdentifiers ?? [],
    );

    const maxLines = options.maxLines ?? 100;
    const maxTokens = options.maxTokens ?? 2000;

    const { code, truncated, skeletonLinesConsumed } = trimSkeletonToBounds(
      skeletonText,
      maxLines,
      maxTokens,
      options.skeletonOffset,
    );
    const skeletonLines = code.split("\n");

    const actualRange: Range = {
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: Math.max(
        symbol.rangeStartLine,
        symbol.rangeStartLine + skeletonLines.length - 1,
      ),
      endCol: truncated ? 0 : symbol.rangeEndCol,
    };

    return {
      skeleton: code,
      actualRange,
      estimatedTokens: estimateTokenCount(code),
      originalLines: symbol.rangeEndLine - symbol.rangeStartLine + 1,
      truncated,
      skeletonLinesConsumed,
    };
  } catch (error) {
    logger.error(
      "Tree-sitter traversal failed during symbol skeleton generation",
      {
        symbolId,
        file: file.relPath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}

export async function generateFileSkeleton(
  repoId: RepoId,
  filePath: string,
  exportedOnly: boolean = false,
  options: SkeletonOptions = {},
): Promise<SkeletonResult | null> {
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) return null;

  const absPath = getAbsolutePathFromRepoRoot(repo.rootPath, filePath);
  const extension = filePath.split(".").pop() || "";

  try {
    const fileStat = await stat(absPath);
    if (fileStat.size > MAX_FILE_BYTES) {
      return null;
    }
  } catch (error) {
    logger.debug("Failed to stat file during file skeleton generation", {
      file: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const content = (await readFile(absPath, "utf-8")).replace(/\r\n/g, "\n");
  const tree = parseFile(content, `.${extension}`);

  if (!tree) {
    return null;
  }

  try {
    const skeletonText = extractSkeletonFromNode(
      tree.rootNode,
      content,
      options.includeIdentifiers ?? [],
      0,
      exportedOnly,
    );

    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES_SKELETON_DETAILED;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS_SKELETON_DETAILED;

    const { code, truncated, skeletonLinesConsumed } = trimSkeletonToBounds(
      skeletonText,
      maxLines,
      maxTokens,
      options.skeletonOffset,
    );
    const skeletonLines = code.split("\n");

    const actualRange: Range = {
      startLine: 1,
      startCol: 0,
      endLine: skeletonLines.length,
      endCol: skeletonLines[skeletonLines.length - 1]?.length ?? 0,
    };

    return {
      skeleton: code,
      actualRange,
      estimatedTokens: estimateTokenCount(code),
      originalLines: content.split("\n").length,
      truncated,
      skeletonLinesConsumed,
    };
  } catch (error) {
    logger.error(
      "Tree-sitter traversal failed during file skeleton generation",
      {
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}

function computeIRHash(ops: SkeletonOp[]): string {
  const json = JSON.stringify(ops);
  return createHash("sha256").update(json).digest("hex");
}

function detectSideEffectType(
  node: Parser.SyntaxNode,
): "network" | "fs" | "env" | "process" | "global" | "unknown" | null {
  const text = node.text;

  const networkPatterns = [
    /fetch\s*\(/,
    /axios\./,
    /http\.request\s*\(/,
    /http\.get\s*\(/,
    /http\.post\s*\(/,
    /XMLHttpRequest/,
  ];

  const filesystemPatterns = [
    /fs\.readFile/,
    /fs\.writeFile/,
    /fs\.appendFile/,
    /fs\.unlink/,
    /fs\.mkdir/,
    /fs\.rmdir/,
    /fs\.existsSync/,
    /fs\.readFileSync/,
    /fs\.writeFileSync/,
    /readFileSync/,
    /writeFileSync/,
  ];

  const envPatterns = [/process\.env/, /process\.cwd/, /import\.meta\.env/];

  const processPatterns = [
    /process\.exit/,
    /process\.kill/,
    /process\.send/,
    /child_process\./,
  ];

  const globalPatterns = [
    /globalThis\./,
    /window\./,
    /document\./,
    /localStorage\./,
    /sessionStorage\./,
  ];

  for (const pattern of networkPatterns) {
    if (pattern.test(text)) return "network";
  }

  for (const pattern of filesystemPatterns) {
    if (pattern.test(text)) return "fs";
  }

  for (const pattern of envPatterns) {
    if (pattern.test(text)) return "env";
  }

  for (const pattern of processPatterns) {
    if (pattern.test(text)) return "process";
  }

  for (const pattern of globalPatterns) {
    if (pattern.test(text)) return "global";
  }

  return null;
}

function extractCallsFromNode(
  node: Parser.SyntaxNode,
): Array<{ target: string; line: number }> {
  const calls: Array<{ target: string; line: number }> = [];

  function walk(n: Parser.SyntaxNode) {
    if (n.type === "call_expression") {
      const funcNode = n.childForFieldName("function");
      if (funcNode) {
        const target =
          funcNode.type === "identifier"
            ? funcNode.text
            : funcNode.type === "member_expression"
              ? funcNode.text
              : "";
        if (target) {
          calls.push({
            target,
            line: n.startPosition.row + 1,
          });
        }
      }
    }

    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return calls;
}

function generateIROpsFromNode(
  node: Parser.SyntaxNode,
  content: string,
  depth: number = 0,
): SkeletonOp[] {
  const ops: SkeletonOp[] = [];
  const nodeType = node.type;

  if (nodeType === "source_file") {
    for (const child of node.children) {
      ops.push(...generateIROpsFromNode(child, content, depth));
    }
    return ops;
  }

  if (
    nodeType === "function_declaration" ||
    nodeType === "class_declaration" ||
    nodeType === "method_definition" ||
    nodeType === "arrow_function"
  ) {
    const bodyNode = node.childForFieldName("body");
    if (bodyNode && bodyNode.type === "statement_block") {
      ops.push(...generateIROpsFromNode(bodyNode, content, depth));
    }
    return ops;
  }

  if (nodeType === "statement_block") {
    const lines = node.text.split("\n");

    if (lines.length > 5) {
      let processedStatements = 0;

      for (const child of node.children) {
        const childType = child.type;

        if (childType === "expression_statement") {
          const sideEffectType = detectSideEffectType(child);
          if (sideEffectType) {
            ops.push({
              op: "sideEffect",
              type: sideEffectType,
              line: child.startPosition.row + 1,
            });
            processedStatements++;
          } else {
            const calls = extractCallsFromNode(child);
            for (const call of calls) {
              ops.push({
                op: "call",
                target: call.target,
                line: call.line,
              });
              processedStatements++;
            }
          }
        } else if (childType === "if_statement") {
          ops.push({
            op: "if",
            line: child.startPosition.row + 1,
          });

          const thenBlock = child.childForFieldName("consequence");
          if (thenBlock) {
            ops.push(...generateIROpsFromNode(thenBlock, content, depth + 1));
          }

          const elseBlock = child.childForFieldName("alternative");
          if (elseBlock) {
            ops.push(...generateIROpsFromNode(elseBlock, content, depth + 1));
          }

          processedStatements++;
        } else if (childType === "try_statement") {
          ops.push({
            op: "try",
            line: child.startPosition.row + 1,
          });

          const bodyBlock = child.childForFieldName("body");
          if (bodyBlock) {
            ops.push(...generateIROpsFromNode(bodyBlock, content, depth + 1));
          }

          const handlerBlock = child.childForFieldName("handler");
          if (handlerBlock) {
            ops.push(
              ...generateIROpsFromNode(handlerBlock, content, depth + 1),
            );
          }

          const finalizerBlock = child.childForFieldName("finalizer");
          if (finalizerBlock) {
            ops.push(
              ...generateIROpsFromNode(finalizerBlock, content, depth + 1),
            );
          }

          processedStatements++;
        } else if (childType === "return_statement") {
          ops.push({
            op: "return",
            line: child.startPosition.row + 1,
          });
          processedStatements++;
        } else if (childType === "throw_statement") {
          ops.push({
            op: "throw",
            line: child.startPosition.row + 1,
          });
          processedStatements++;
        }
      }

      if (processedStatements > 0 && processedStatements < lines.length - 1) {
        ops.push({
          op: "elision",
          reason: "block",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          estimatedLines: lines.length - processedStatements,
        });
      } else if (processedStatements === 0 && lines.length > 3) {
        ops.push({
          op: "elision",
          reason: "too-long",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          estimatedLines: lines.length,
        });
      }
    }

    return ops;
  }

  for (const child of node.children) {
    ops.push(...generateIROpsFromNode(child, content, depth));
  }

  return ops;
}

export async function generateSkeletonIR(
  repoId: RepoId,
  symbolId: SymbolId,
  options: SkeletonOptions = {},
): Promise<SkeletonIRResult | null> {
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

  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      return null;
    }
  } catch (error) {
    logger.debug("Failed to stat file during skeleton IR generation", {
      file: file.relPath,
      symbolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const content = (await readFile(filePath, "utf-8")).replace(/\r\n/g, "\n");
  const tree = parseFile(content, `.${extension}`);

  if (!tree) {
    return null;
  }

  try {
    const symbolRange = {
      startLine: symbol.rangeStartLine,
      endLine: symbol.rangeEndLine,
    };

    const rootNode = tree.rootNode;
    const symbolNode = findNodeByRange(rootNode, symbolRange);

    if (!symbolNode) {
      return null;
    }

    const ops = generateIROpsFromNode(symbolNode, content);

    const hash = computeIRHash(ops);

    const totalLines = symbol.rangeEndLine - symbol.rangeStartLine + 1;

    let elidedLines = 0;
    for (const op of ops) {
      if (op.op === "elision") {
        elidedLines += op.estimatedLines;
      }
    }

    const skeletonText = extractSkeletonFromNode(
      symbolNode,
      content,
      options.includeIdentifiers ?? [],
    );

    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES_SKELETON;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS_SKELETON;

    const { code } = trimSkeletonToBounds(skeletonText, maxLines, maxTokens);
    const skeletonLines = code.split("\n");

    const actualRange: Range = {
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeStartLine + skeletonLines.length - 1,
      endCol: skeletonLines[skeletonLines.length - 1]?.length ?? 0,
    };

    return {
      ir: {
        symbolId,
        ops,
        hash,
        totalLines,
        elidedLines,
      },
      skeletonText: code,
      actualRange,
      estimatedTokens: estimateTokenCount(code),
      originalLines: totalLines,
    };
  } catch (error) {
    logger.error("Tree-sitter traversal failed during skeleton IR generation", {
      symbolId,
      file: file.relPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
