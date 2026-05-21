import { extname } from "path";

import type { QueryCapture, SyntaxNode } from "tree-sitter";

import {
  parseFile,
  queryTreeForExtensionOrThrow,
} from "../../../indexer/treesitter/tsTreesitter.js";
import { ValidationError } from "../../../domain/errors.js";

export interface StructuralQueryInput {
  language?: "typescript";
  treeSitterQuery: string;
  capture?: string;
  requiredCaptures?: Record<string, string>;
  replacement?: string;
}

export interface StructuralRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface StructuralCapture {
  name: string;
  text: string;
  nodeType: string;
  startByte: number;
  endByte: number;
  start: number;
  end: number;
  range: StructuralRange;
}

export interface StructuralSourceEdit {
  start: number;
  end: number;
  replacement: string;
  captures: StructuralCapture[];
}

export interface IdentifierEditInput {
  content: string;
  relPath: string;
  literal: string;
  replacement: string;
  global?: boolean;
  maxMatches?: number;
}

export interface StructuralEditInput {
  content: string;
  relPath: string;
  structural: StructuralQueryInput;
  replacement?: string;
  global?: boolean;
  maxMatches?: number;
}

const STRUCTURAL_QUERY_TIMEOUT_MICROS = 250_000;
const DEFAULT_TARGET_CAPTURE = "target";
const IDENTIFIER_NODE_TYPES = new Set([
  "identifier",
  "property_identifier",
  "private_property_identifier",
  "shorthand_property_identifier",
  "type_identifier",
  "jsx_identifier",
]);

function extensionForPath(relPath: string): string {
  return extname(relPath).toLowerCase();
}

function assertSupportedExtension(relPath: string): string {
  const extension = extensionForPath(relPath);
  if (![".ts", ".tsx", ".js", ".jsx"].includes(extension)) {
    throw new ValidationError(
      `structural targeting currently supports TypeScript/JavaScript files only (${relPath})`,
    );
  }
  return extension;
}

function buildByteOffsetConverter(
  content: string,
): (byteOffset: number) => number {
  const boundaries = new Map<number, number>();
  let byteOffset = 0;
  for (let index = 0; index < content.length; ) {
    boundaries.set(byteOffset, index);
    const codePoint = content.codePointAt(index);
    if (codePoint === undefined) break;
    const value = String.fromCodePoint(codePoint);
    byteOffset += Buffer.byteLength(value, "utf-8");
    index += value.length;
  }
  boundaries.set(byteOffset, content.length);

  return (targetByteOffset: number): number => {
    const exact = boundaries.get(targetByteOffset);
    if (exact !== undefined) return exact;
    throw new ValidationError(
      `tree-sitter returned a non-boundary byte offset: ${targetByteOffset}`,
    );
  };
}

function captureFromNode(
  name: string,
  node: SyntaxNode,
  byteToStringIndex: (byteOffset: number) => number,
): StructuralCapture {
  return {
    name,
    text: node.text,
    nodeType: node.type,
    startByte: node.startIndex,
    endByte: node.endIndex,
    start: byteToStringIndex(node.startIndex),
    end: byteToStringIndex(node.endIndex),
    range: {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column,
    },
  };
}

function dedupeCaptures(captures: StructuralCapture[]): StructuralCapture[] {
  const seen = new Set<string>();
  const deduped: StructuralCapture[] = [];
  for (const capture of captures) {
    const key = `${capture.name}:${capture.startByte}:${capture.endByte}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(capture);
  }
  return deduped;
}

function replacementWithCaptures(
  replacement: string,
  captures: StructuralCapture[],
): string {
  const byName = new Map<string, StructuralCapture>();
  for (const capture of captures) {
    byName.set(capture.name, capture);
  }
  return replacement.replace(
    /\$(\{([A-Za-z_][A-Za-z0-9_-]*)\}|[A-Za-z_][A-Za-z0-9_-]*)/g,
    (token, marker: string, bracedName?: string) => {
      const name = bracedName ?? marker;
      return byName.get(name)?.text ?? token;
    },
  );
}

function structuralReplacement(
  query: StructuralQueryInput,
  fallbackReplacement: string | undefined,
): string {
  const replacement = query.replacement ?? fallbackReplacement;
  if (replacement === undefined) {
    throw new ValidationError(
      "structural targeting requires query.replacement or query.structural.replacement",
    );
  }
  return replacement;
}

function pushIdentifierEdits(
  node: SyntaxNode,
  byteToStringIndex: (byteOffset: number) => number,
  literal: string,
  replacement: string,
  edits: StructuralSourceEdit[],
  maxMatches: number,
): void {
  if (edits.length >= maxMatches) return;
  if (IDENTIFIER_NODE_TYPES.has(node.type) && node.text === literal) {
    const capture = captureFromNode("target", node, byteToStringIndex);
    edits.push({
      start: capture.start,
      end: capture.end,
      replacement,
      captures: [capture],
    });
    if (edits.length >= maxMatches) return;
  }

  for (const child of node.namedChildren) {
    pushIdentifierEdits(
      child,
      byteToStringIndex,
      literal,
      replacement,
      edits,
      maxMatches,
    );
    if (edits.length >= maxMatches) return;
  }
}

export function collectIdentifierSourceEdits(
  input: IdentifierEditInput,
): StructuralSourceEdit[] {
  const extension = assertSupportedExtension(input.relPath);
  const parseResult = parseFile(input.content, extension);
  if (!parseResult) {
    return [];
  }

  const byteToStringIndex = buildByteOffsetConverter(input.content);
  const maxMatches =
    input.global === false ? 1 : (input.maxMatches ?? Number.MAX_SAFE_INTEGER);
  const edits: StructuralSourceEdit[] = [];
  pushIdentifierEdits(
    parseResult.tree.rootNode,
    byteToStringIndex,
    input.literal,
    input.replacement,
    edits,
    maxMatches,
  );
  return edits;
}

function capturesByName(
  captures: StructuralCapture[],
): Map<string, StructuralCapture[]> {
  const grouped = new Map<string, StructuralCapture[]>();
  for (const capture of captures) {
    const group = grouped.get(capture.name) ?? [];
    group.push(capture);
    grouped.set(capture.name, group);
  }
  return grouped;
}

function requiredCapturesMatch(
  captures: StructuralCapture[],
  requiredCaptures: Record<string, string> | undefined,
): boolean {
  if (!requiredCaptures) return true;
  const grouped = capturesByName(captures);
  for (const [name, expectedText] of Object.entries(requiredCaptures)) {
    const candidates = grouped.get(name) ?? [];
    if (!candidates.some((capture) => capture.text === expectedText)) {
      return false;
    }
  }
  return true;
}

function captureName(capture: QueryCapture): string {
  return capture.name.replace(/^@/, "");
}

export function collectStructuralSourceEdits(
  input: StructuralEditInput,
): StructuralSourceEdit[] {
  const extension = assertSupportedExtension(input.relPath);
  if (
    input.structural.language !== undefined &&
    input.structural.language !== "typescript"
  ) {
    throw new ValidationError(
      `Unsupported structural language: ${input.structural.language}`,
    );
  }

  const parseResult = parseFile(input.content, extension);
  if (!parseResult) {
    return [];
  }

  const replacement = structuralReplacement(
    input.structural,
    input.replacement,
  );
  const targetCapture = input.structural.capture ?? DEFAULT_TARGET_CAPTURE;
  const matches = (() => {
    try {
      return queryTreeForExtensionOrThrow(
        parseResult.tree,
        extension,
        input.structural.treeSitterQuery,
        { timeoutMicros: STRUCTURAL_QUERY_TIMEOUT_MICROS },
      );
    } catch (error) {
      throw new ValidationError(
        `Invalid structural tree-sitter query for ${input.relPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  })();
  const byteToStringIndex = buildByteOffsetConverter(input.content);
  const maxMatches =
    input.global === false ? 1 : (input.maxMatches ?? Number.MAX_SAFE_INTEGER);
  const edits: StructuralSourceEdit[] = [];
  const seenTargets = new Set<string>();

  for (const match of matches) {
    const captures = dedupeCaptures(
      match.captures.map((capture) =>
        captureFromNode(captureName(capture), capture.node, byteToStringIndex),
      ),
    );
    if (!requiredCapturesMatch(captures, input.structural.requiredCaptures)) {
      continue;
    }
    const target = captures.find((capture) => capture.name === targetCapture);
    if (!target) continue;
    const targetKey = `${target.startByte}:${target.endByte}`;
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);
    edits.push({
      start: target.start,
      end: target.end,
      replacement: replacementWithCaptures(replacement, captures),
      captures,
    });
    if (edits.length >= maxMatches) break;
  }

  return edits;
}
