import { readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import type { RepoId, SymbolId } from "../db/schema.js";
import type { Range, SkeletonOp, SkeletonIR } from "../mcp/types.js";
import { getSymbol, getFile, getRepo } from "../db/queries.js";
import { getAbsolutePathFromRepoRoot } from "../util/paths.js";
import { estimateTokens as estimateTokenCount } from "../util/tokenize.js";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import {
  DEFAULT_MAX_LINES_SKELETON,
  DEFAULT_MAX_TOKENS_SKELETON,
  DEFAULT_MAX_LINES_SKELETON_DETAILED,
  DEFAULT_MAX_TOKENS_SKELETON_DETAILED,
  MAX_FILE_BYTES,
} from "../config/constants.js";

const tsParser = new Parser();
const tsxParser = new Parser();

tsParser.setLanguage(TypeScript.typescript);
tsxParser.setLanguage(TypeScript.tsx);

export interface SkeletonResult {
  skeleton: string;
  actualRange: Range;
  estimatedTokens: number;
  originalLines: number;
  truncated: boolean;
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
}

function shouldIncludeIdentifier(
  identifier: string,
  includeIdentifiers: string[] = [],
): boolean {
  if (includeIdentifiers.length === 0) return false;
  return includeIdentifiers.includes(identifier);
}

export function extractSkeletonFromNode(
  node: Parser.SyntaxNode,
  content: string,
  includeIdentifiers: string[],
  depth: number = 0,
  exportedOnly: boolean = false,
): string {
  const nodeType = node.type;

  if (nodeType === "source_file" || nodeType === "program") {
    let result = "";
    for (const child of node.children) {
      if (
        child.type === "import_statement" ||
        child.type === "export_statement"
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
    if (!exportedOnly) {
      for (const child of node.children) {
        if (
          child.type !== "import_statement" &&
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

  if (
    nodeType === "import_statement" ||
    nodeType === "interface_declaration" ||
    nodeType === "type_alias_declaration" ||
    nodeType === "enum_declaration"
  ) {
    return node.text + "\n";
  }

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

  if (
    nodeType === "function_declaration" ||
    nodeType === "class_declaration" ||
    nodeType === "method_definition"
  ) {
    const lines = node.text.split("\n");
    const signature = lines[0] || "";

    const hasBody = node.children.some((c) => c.type === "statement_block");
    if (!hasBody) {
      return node.text + "\n";
    }

    const bodyNode = node.children.find((c) => c.type === "statement_block");
    if (!bodyNode) {
      return node.text + "\n";
    }

    const bodySkeleton = extractSkeletonFromBody(
      bodyNode,
      content,
      includeIdentifiers,
    );

    const result = signature + " {\n" + bodySkeleton + "}\n";
    return result;
  }

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

  if (nodeType === "statement_block") {
    return extractSkeletonFromBody(node, content, includeIdentifiers);
  }

  return node.text;
}

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

    if (childType === "lexical_declaration") {
      const hasImportantIdentifier = includeIdentifiers.some((id) =>
        childText.includes(id),
      );

      if (hasImportantIdentifier) {
        result += child.text.trim() + "\n";
        processedStatements++;
      }
    } else if (childType === "expression_statement") {
      const isReturn = child.children.some(
        (c) => c.type === "return_statement",
      );
      const isThrow = child.children.some((c) => c.type === "throw_statement");

      const hasImportantIdentifier =
        includeIdentifiers.some((id) => childText.includes(id)) ||
        shouldIncludeIdentifier(childText, includeIdentifiers);

      if (isReturn || isThrow || hasImportantIdentifier) {
        result += child.text.trim() + "\n";
        processedStatements++;
      }
    } else if (childType === "if_statement") {
      const condition = child.children.find(
        (c) => c.type === "parenthesized_expression",
      );
      const conditionText = condition ? condition.text : "";
      const thenBlock = child.children.find(
        (c) => c.type === "statement_block",
      );
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
        const elseChild = elseBlock.children.find(
          (c) => c.type === "statement_block",
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
    } else if (
      childType === "for_statement" ||
      childType === "for_in_statement" ||
      childType === "while_statement"
    ) {
      const condition = child.children.find(
        (c) => c.type === "parenthesized_expression",
      );
      const conditionText = condition ? condition.text : "";
      const body = child.children.find((c) => c.type === "statement_block");

      const loopKeyword = childType
        .replace("_statement", "")
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
    } else if (
      childType === "try_statement" ||
      childType === "catch_clause" ||
      childType === "finally_clause"
    ) {
      result += child.text.trim() + "\n";
      processedStatements++;
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
): { code: string; truncated: boolean } {
  const lines = skeleton.split("\n");
  const tokenCount = estimateTokenCount(skeleton);

  if (lines.length <= maxLines && tokenCount <= maxTokens) {
    return { code: skeleton, truncated: false };
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
  return { code: result.join("\n"), truncated };
}

export function parseFile(
  content: string,
  extension: string,
): Parser.Tree | null {
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
      `[sdl-mcp] Failed to parse file (extension: ${extension}): ${error instanceof Error ? error.message : String(error)}\n`,
    );
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

export function generateSymbolSkeleton(
  repoId: RepoId,
  symbolId: SymbolId,
  options: SkeletonOptions = {},
): SkeletonResult | null {
  const symbol = getSymbol(symbolId);
  if (!symbol) return null;

  if (symbol.repo_id !== repoId) return null;

  const file = getFile(symbol.file_id);
  if (!file) return null;

  const repo = getRepo(repoId);
  if (!repo) return null;

  const filePath = getAbsolutePathFromRepoRoot(repo.root_path, file.rel_path);
  const extension = file.rel_path.split(".").pop() || "";

  try {
    const fileStat = statSync(filePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      return null;
    }
  } catch {
    return null;
  }

  const content = readFileSync(filePath, "utf-8");
  const tree = parseFile(content, `.${extension}`);

  if (!tree) {
    return null;
  }

  const symbolRange = {
    startLine: symbol.range_start_line,
    endLine: symbol.range_end_line,
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

  const { code, truncated } = trimSkeletonToBounds(
    skeletonText,
    maxLines,
    maxTokens,
  );
  const skeletonLines = code.split("\n");

  const actualRange: Range = {
    startLine: symbol.range_start_line,
    startCol: symbol.range_start_col,
    endLine: Math.max(symbol.range_start_line, symbol.range_start_line + skeletonLines.length - 1),
    endCol: truncated ? 0 : symbol.range_end_col,
  };

  return {
    skeleton: code,
    actualRange,
    estimatedTokens: estimateTokenCount(code),
    originalLines: symbol.range_end_line - symbol.range_start_line + 1,
    truncated,
  };
}

export function generateFileSkeleton(
  repoId: RepoId,
  filePath: string,
  exportedOnly: boolean = false,
  options: SkeletonOptions = {},
): SkeletonResult | null {
  const repo = getRepo(repoId);
  if (!repo) return null;

  const absPath = getAbsolutePathFromRepoRoot(repo.root_path, filePath);
  const extension = filePath.split(".").pop() || "";

  try {
    const fileStat = statSync(absPath);
    if (fileStat.size > MAX_FILE_BYTES) {
      return null;
    }
  } catch {
    return null;
  }

  const content = readFileSync(absPath, "utf-8");
  const tree = parseFile(content, `.${extension}`);

  if (!tree) {
    return null;
  }

  const skeletonText = extractSkeletonFromNode(
    tree.rootNode,
    content,
    options.includeIdentifiers ?? [],
    0,
    exportedOnly,
  );

  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES_SKELETON_DETAILED;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS_SKELETON_DETAILED;

  const { code, truncated } = trimSkeletonToBounds(
    skeletonText,
    maxLines,
    maxTokens,
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
  };
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

export function generateSkeletonIR(
  repoId: RepoId,
  symbolId: SymbolId,
  options: SkeletonOptions = {},
): SkeletonIRResult | null {
  const symbol = getSymbol(symbolId);
  if (!symbol) return null;

  if (symbol.repo_id !== repoId) return null;

  const file = getFile(symbol.file_id);
  if (!file) return null;

  const repo = getRepo(repoId);
  if (!repo) return null;

  const filePath = getAbsolutePathFromRepoRoot(repo.root_path, file.rel_path);
  const extension = file.rel_path.split(".").pop() || "";

  try {
    const fileStat = statSync(filePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      return null;
    }
  } catch {
    return null;
  }

  const content = readFileSync(filePath, "utf-8");
  const tree = parseFile(content, `.${extension}`);

  if (!tree) {
    return null;
  }

  const symbolRange = {
    startLine: symbol.range_start_line,
    endLine: symbol.range_end_line,
  };

  const rootNode = tree.rootNode;
  const symbolNode = findNodeByRange(rootNode, symbolRange);

  if (!symbolNode) {
    return null;
  }

  const ops = generateIROpsFromNode(symbolNode, content);

  const hash = computeIRHash(ops);

  const totalLines = symbol.range_end_line - symbol.range_start_line + 1;

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
    startLine: symbol.range_start_line,
    startCol: symbol.range_start_col,
    endLine: symbol.range_start_line + skeletonLines.length - 1,
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
}
