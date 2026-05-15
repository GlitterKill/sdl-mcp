import { ValidationError } from "../../../domain/errors.js";
import type { Range } from "../../../domain/types.js";
import { getTsParser, getTsxParser } from "../../../code/ts-parsers.js";
import type { SymbolEditOperation } from "../../tools.js";
import type Parser from "tree-sitter";

export interface SymbolEditSymbolSnapshot {
  symbolId: string;
  name: string;
  kind: string;
  language: string;
  range: Range;
  astFingerprint: string;
}

export interface SymbolEditAstPlan {
  newContent: string;
  editMode: SymbolEditOperation["kind"];
  changedRange: Range;
  validation: {
    parseBefore: boolean;
    parseAfter: boolean;
    targetSymbolResolved: boolean;
    warnings?: string[];
  };
}

interface OffsetRange {
  start: number;
  end: number;
}

interface DeclarationIdentity {
  name: string;
  kind: string;
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const BODY_NODE_TYPES = new Set(["statement_block", "class_body"]);
const NESTED_SCOPE_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "class_declaration",
  "class",
]);

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetAt(content: string, rangePoint: { line: number; col: number }): number {
  const starts = lineStarts(content);
  const lineIndex = rangePoint.line - 1;
  if (lineIndex < 0 || lineIndex >= starts.length) {
    throw new ValidationError(`Range line ${rangePoint.line} is outside file content`);
  }
  return Math.min(starts[lineIndex] + rangePoint.col, content.length);
}

function offsetsForRange(content: string, range: Range): OffsetRange {
  const start = offsetAt(content, {
    line: range.startLine,
    col: range.startCol,
  });
  const end = offsetAt(content, {
    line: range.endLine,
    col: range.endCol,
  });
  if (end < start) {
    throw new ValidationError("Symbol range end precedes start");
  }
  return { start, end };
}

function offsetsForNode(node: Parser.SyntaxNode): OffsetRange {
  return {
    start: node.startIndex,
    end: node.endIndex,
  };
}

function rangeForOffsets(content: string, offsets: OffsetRange): Range {
  const starts = lineStarts(content);
  const pointForOffset = (offset: number): { line: number; col: number } => {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (starts[mid] <= offset) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const lineIndex = Math.max(0, high);
    return {
      line: lineIndex + 1,
      col: offset - starts[lineIndex],
    };
  };
  const start = pointForOffset(offsets.start);
  const end = pointForOffset(offsets.end);
  return {
    startLine: start.line,
    startCol: start.col,
    endLine: end.line,
    endCol: end.col,
  };
}

function rangesEqual(a: Range, b: Range): boolean {
  return (
    a.startLine === b.startLine &&
    a.startCol === b.startCol &&
    a.endLine === b.endLine &&
    a.endCol === b.endCol
  );
}

function rangeForNode(node: Parser.SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

function parseTree(content: string, filePath: string): Parser.Tree {
  const parser =
    filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
      ? getTsxParser()
      : getTsParser();
  return parser.parse(content);
}

function findNodeByRange(
  node: Parser.SyntaxNode,
  range: Range,
): Parser.SyntaxNode | null {
  if (rangesEqual(rangeForNode(node), range)) {
    return node;
  }
  for (const child of node.children) {
    const found = findNodeByRange(child, range);
    if (found) return found;
  }
  return null;
}

function replaceRange(content: string, offsets: OffsetRange, replacement: string): string {
  return content.slice(0, offsets.start) + replacement + content.slice(offsets.end);
}

function normalizeAdjacentInsert(content: string, insertOffset: number, raw: string): string {
  if (raw.length === 0) return raw;
  const previous = insertOffset > 0 ? content[insertOffset - 1] : "";
  const next = insertOffset < content.length ? content[insertOffset] : "";
  let text = raw;
  if (previous && previous !== "\n" && previous !== "\r" && !text.startsWith("\n")) {
    text = "\n" + text;
  }
  if (next && next !== "\n" && next !== "\r" && !text.endsWith("\n")) {
    text += "\n";
  }
  return text;
}

function skipFollowingNewline(content: string, offset: number): number {
  if (content[offset] === "\r" && content[offset + 1] === "\n") return offset + 2;
  if (content[offset] === "\n") return offset + 1;
  return offset;
}

function findDescendantByType(
  node: Parser.SyntaxNode,
  types: ReadonlySet<string>,
): Parser.SyntaxNode | null {
  for (const child of node.children) {
    if (types.has(child.type)) {
      return child;
    }
    const found = findDescendantByType(child, types);
    if (found) return found;
  }
  return null;
}

function countChildrenByType(node: Parser.SyntaxNode, type: string): number {
  return node.children.filter((child) => child.type === type).length;
}

function declarationBoundaryNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let boundary = node;
  const parent = boundary.parent;
  if (
    parent &&
    (parent.type === "lexical_declaration" || parent.type === "variable_declaration") &&
    countChildrenByType(parent, "variable_declarator") === 1
  ) {
    boundary = parent;
  }
  if (boundary.parent?.type === "export_statement") {
    boundary = boundary.parent;
  }
  return boundary;
}

function locateAstNode(
  tree: Parser.Tree,
  symbol: SymbolEditSymbolSnapshot,
): Parser.SyntaxNode {
  const found = findNodeByRange(tree.rootNode, symbol.range);
  if (!found) {
    throw new ValidationError(
      "Cannot locate AST node for selected symbol range; re-index or re-run symbol search.",
    );
  }
  return found;
}

function locateBody(symbolNode: Parser.SyntaxNode): OffsetRange {
  const body = findDescendantByType(symbolNode, BODY_NODE_TYPES);
  if (!body) {
    throw new ValidationError("Cannot locate body range for selected symbol");
  }
  if (body.endIndex <= body.startIndex + 1) {
    throw new ValidationError("Cannot locate body range for selected symbol");
  }
  return {
    start: body.startIndex + 1,
    end: body.endIndex - 1,
  };
}

function normalizeBodyContent(content: string, bodyRange: OffsetRange, replacement: string): string {
  const hadLeadingNewline = content[bodyRange.start] === "\n";
  const hadTrailingNewline = bodyRange.end > 0 && content[bodyRange.end - 1] === "\n";
  let text = replacement;
  if (hadLeadingNewline && !text.startsWith("\n")) {
    text = "\n" + text;
  }
  if (hadTrailingNewline && !text.endsWith("\n")) {
    text += "\n";
  }
  return text;
}

function locateSignature(content: string, symbolNode: Parser.SyntaxNode): OffsetRange {
  const body = findDescendantByType(symbolNode, BODY_NODE_TYPES);
  if (!body) {
    throw new ValidationError("Cannot locate signature range for selected symbol");
  }
  let end = body.startIndex;
  while (end > symbolNode.startIndex && /\s/.test(content[end - 1] ?? "")) {
    end--;
  }
  return {
    start: symbolNode.startIndex,
    end,
  };
}

function normalizeSignatureContent(content: string, signatureRange: OffsetRange, replacement: string): string {
  const next = content[signatureRange.end];
  if (next === "{") {
    return replacement.endsWith(" ") ? replacement : replacement + " ";
  }
  return replacement;
}

function collectIdentifierOffsets(
  node: Parser.SyntaxNode,
  name: string,
  ranges: OffsetRange[],
): void {
  if (
    (node.type === "shorthand_property_identifier" ||
      node.type === "shorthand_property_identifier_pattern") &&
    node.text === name
  ) {
    throw new ValidationError(
      `renameLocal for ${name} cannot safely rewrite shorthand object or destructuring syntax in v1.`,
    );
  }
  if (node.type === "identifier" && node.text === name) {
    ranges.push(offsetsForNode(node));
    return;
  }
  for (const child of node.children) {
    collectIdentifierOffsets(child, name, ranges);
  }
}

function nodeContainsIdentifier(node: Parser.SyntaxNode, name: string): boolean {
  if (
    (node.type === "identifier" ||
      node.type === "shorthand_property_identifier_pattern") &&
    node.text === name
  ) {
    return true;
  }
  return node.children.some((child) => nodeContainsIdentifier(child, name));
}

function assertNoNestedScopeRename(
  root: Parser.SyntaxNode,
  node: Parser.SyntaxNode,
  name: string,
): void {
  if (node !== root && NESTED_SCOPE_TYPES.has(node.type) && nodeContainsIdentifier(node, name)) {
    throw new ValidationError(
      `renameLocal for ${name} crosses a nested scope; use a narrower symbol or a future LSP rename.`,
    );
  }
  for (const child of node.children) {
    assertNoNestedScopeRename(root, child, name);
  }
}

function isDeclarationIdentifier(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    parent.type === "required_parameter" ||
    parent.type === "optional_parameter" ||
    parent.type === "rest_parameter" ||
    parent.type === "catch_clause" ||
    parent.type === "variable_declarator"
  ) {
    return parent.childForFieldName("name") === node;
  }
  if (parent.type === "shorthand_property_identifier_pattern") {
    return true;
  }
  return false;
}

function countDeclarationIdentifiers(
  node: Parser.SyntaxNode,
  name: string,
): number {
  let count = 0;
  if (node.type === "identifier" && node.text === name && isDeclarationIdentifier(node)) {
    count++;
  }
  if (node.type === "shorthand_property_identifier_pattern" && node.text === name) {
    count++;
  }
  for (const child of node.children) {
    count += countDeclarationIdentifiers(child, name);
  }
  return count;
}

function replaceLocalIdentifiers(
  content: string,
  symbolNode: Parser.SyntaxNode,
  name: string,
  replacement: string,
): string {
  if (!IDENTIFIER_RE.test(name) || !IDENTIFIER_RE.test(replacement)) {
    throw new ValidationError("renameLocal names must be valid TypeScript identifiers");
  }
  const renameRoot =
    symbolNode.type === "export_statement"
      ? (symbolNode.children.find((child) => child.type !== "export") ?? symbolNode)
      : symbolNode;
  assertNoNestedScopeRename(renameRoot, renameRoot, name);
  const declarations = countDeclarationIdentifiers(renameRoot, name);
  if (declarations === 0) {
    throw new ValidationError(
      `renameLocal for ${name} did not find a local declaration inside the selected symbol.`,
    );
  }
  if (declarations > 1) {
    throw new ValidationError(
      `renameLocal for ${name} is ambiguous because multiple declarations exist inside the selected symbol.`,
    );
  }
  const ranges: OffsetRange[] = [];
  collectIdentifierOffsets(renameRoot, name, ranges);
  if (ranges.length === 0) {
    throw new ValidationError(`Identifier ${name} was not found inside selected symbol`);
  }
  let next = content;
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    next = replaceRange(next, range, replacement);
  }
  return next;
}

function assertTsLanguage(symbol: SymbolEditSymbolSnapshot): void {
  const language = symbol.language.toLowerCase();
  if (
    language !== "typescript" &&
    language !== "tsx" &&
    language !== "javascript" &&
    language !== "jsx"
  ) {
    throw new ValidationError(
      `Operation requires TypeScript/JavaScript-family symbol support; ${symbol.language} is not supported for this operation`,
    );
  }
}

function declarationName(node: Parser.SyntaxNode): string | null {
  const name = node.childForFieldName("name");
  if (!name) return null;
  if (
    name.type === "object_pattern" ||
    name.type === "array_pattern" ||
    name.type === "formal_parameters"
  ) {
    return null;
  }
  return name.text;
}

function directDeclarationIdentity(node: Parser.SyntaxNode): DeclarationIdentity | null {
  switch (node.type) {
    case "export_statement":
      for (const child of node.children) {
        const identity = directDeclarationIdentity(child);
        if (identity) return identity;
      }
      return null;
    case "function_declaration":
    case "generator_function_declaration": {
      const name = declarationName(node);
      return name ? { name, kind: "function" } : null;
    }
    case "method_definition": {
      const name = declarationName(node);
      if (!name) return null;
      return { name, kind: name === "constructor" ? "constructor" : "method" };
    }
    case "class_declaration": {
      const name = declarationName(node);
      return name ? { name, kind: "class" } : null;
    }
    case "interface_declaration": {
      const name = declarationName(node);
      return name ? { name, kind: "interface" } : null;
    }
    case "type_alias_declaration": {
      const name = declarationName(node);
      return name ? { name, kind: "type" } : null;
    }
    case "module": {
      const name = declarationName(node);
      return name ? { name, kind: "module" } : null;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      const declarators = node.children.filter(
        (child) => child.type === "variable_declarator",
      );
      if (declarators.length !== 1) return null;
      return directDeclarationIdentity(declarators[0]);
    }
    case "variable_declarator": {
      const name = declarationName(node);
      return name ? { name, kind: "variable" } : null;
    }
    case "assignment_expression": {
      const left = node.children[0];
      if (left?.type !== "identifier") return null;
      const right = node.children[2];
      if (right?.type !== "arrow_function" && right?.type !== "function_expression") {
        return null;
      }
      return { name: left.text, kind: "function" };
    }
    default:
      return null;
  }
}

function targetSymbolResolves(
  tree: Parser.Tree,
  content: string,
  symbol: SymbolEditSymbolSnapshot,
  expectedOffsets: OffsetRange,
): boolean {
  const expectedRange = rangeForOffsets(content, expectedOffsets);
  const node = findNodeByRange(tree.rootNode, expectedRange);
  if (!node) return false;
  const identity = directDeclarationIdentity(node);
  return identity?.name === symbol.name && identity.kind === symbol.kind;
}

function operationRequiresTargetResolution(
  operation: SymbolEditOperation,
): boolean {
  return operation.kind !== "replaceSymbol";
}

export function planTypeScriptSymbolEdit(input: {
  content: string;
  filePath: string;
  symbol: SymbolEditSymbolSnapshot;
  operation: SymbolEditOperation;
}): SymbolEditAstPlan {
  assertTsLanguage(input.symbol);
  offsetsForRange(input.content, input.symbol.range);
  const beforeTree = parseTree(input.content, input.filePath);
  if (beforeTree.rootNode.hasError) {
    throw new ValidationError("Parse-before validation failed for selected file");
  }
  const symbolNode = locateAstNode(beforeTree, input.symbol);
  const boundaryNode = declarationBoundaryNode(symbolNode);
  const symbolOffsets = offsetsForNode(symbolNode);
  const boundaryOffsets = offsetsForNode(boundaryNode);

  let newContent: string;
  let changedOffsets: OffsetRange;
  let expectedTargetOffsets: OffsetRange;
  switch (input.operation.kind) {
    case "replaceSymbol":
      changedOffsets = boundaryOffsets;
      newContent = replaceRange(input.content, changedOffsets, input.operation.content);
      expectedTargetOffsets = {
        start: boundaryOffsets.start,
        end: boundaryOffsets.start + input.operation.content.length,
      };
      break;
    case "insertBefore": {
      const insert = normalizeAdjacentInsert(
        input.content,
        boundaryOffsets.start,
        input.operation.content,
      );
      changedOffsets = {
        start: boundaryOffsets.start,
        end: boundaryOffsets.start + insert.length,
      };
      newContent = replaceRange(input.content, {
        start: boundaryOffsets.start,
        end: boundaryOffsets.start,
      }, insert);
      expectedTargetOffsets = {
        start: boundaryOffsets.start + insert.length,
        end: boundaryOffsets.end + insert.length,
      };
      break;
    }
    case "insertAfter": {
      const insertOffset = skipFollowingNewline(input.content, boundaryOffsets.end);
      const insert = normalizeAdjacentInsert(input.content, insertOffset, input.operation.content);
      changedOffsets = {
        start: insertOffset,
        end: insertOffset + insert.length,
      };
      newContent = replaceRange(input.content, {
        start: insertOffset,
        end: insertOffset,
      }, insert);
      expectedTargetOffsets = boundaryOffsets;
      break;
    }
    case "replaceBody": {
      const bodyRange = locateBody(symbolNode);
      const replacement = normalizeBodyContent(
        input.content,
        bodyRange,
        input.operation.content,
      );
      changedOffsets = {
        start: bodyRange.start,
        end: bodyRange.start + replacement.length,
      };
      newContent = replaceRange(input.content, bodyRange, replacement);
      expectedTargetOffsets = {
        start: boundaryOffsets.start,
        end: boundaryOffsets.end + replacement.length - (bodyRange.end - bodyRange.start),
      };
      break;
    }
    case "replaceSignature": {
      const signatureRange = locateSignature(input.content, boundaryNode);
      const replacement = normalizeSignatureContent(
        input.content,
        signatureRange,
        input.operation.content,
      );
      changedOffsets = {
        start: signatureRange.start,
        end: signatureRange.start + replacement.length,
      };
      newContent = replaceRange(input.content, signatureRange, replacement);
      expectedTargetOffsets = {
        start: boundaryOffsets.start,
        end: boundaryOffsets.end + replacement.length - (signatureRange.end - signatureRange.start),
      };
      break;
    }
    case "renameLocal":
      changedOffsets = symbolOffsets;
      newContent = replaceLocalIdentifiers(
        input.content,
        symbolNode,
        input.operation.name,
        input.operation.replacement,
      );
      expectedTargetOffsets = {
        start: boundaryOffsets.start,
        end: boundaryOffsets.end + newContent.length - input.content.length,
      };
      break;
  }

  const afterTree = parseTree(newContent, input.filePath);
  if (afterTree.rootNode.hasError) {
    throw new ValidationError("Parse-after validation failed for symbol edit result");
  }
  const targetSymbolResolved = targetSymbolResolves(
    afterTree,
    newContent,
    input.symbol,
    expectedTargetOffsets,
  );
  if (
    operationRequiresTargetResolution(input.operation) &&
    !targetSymbolResolved
  ) {
    throw new ValidationError(
      "Target symbol did not resolve after symbol edit; use replaceSymbol for intentional symbol identity changes.",
    );
  }

  return {
    newContent,
    editMode: input.operation.kind,
    changedRange: rangeForOffsets(newContent, changedOffsets),
    validation: {
      parseBefore: true,
      parseAfter: true,
      targetSymbolResolved,
      ...(targetSymbolResolved
        ? {}
        : { warnings: ["replaceSymbol changed or removed the original symbol identity"] }),
    },
  };
}
