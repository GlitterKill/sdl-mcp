import { parseScipSymbol } from "../../scip/kind-mapping.js";
import type { ScipRange } from "../../scip/types.js";
import type { CallProofUnavailableReasonCode } from "./types.js";

export interface SourceLine {
  lineNumber: number;
  text: string;
}

export interface CppCallProofInput {
  providerSymbolId: string;
  expectedNames: readonly string[];
  lineWindow: readonly SourceLine[];
  range: ScipRange;
}

export type CppCallProofResult =
  | { matched: true; line: string; invocationEndLine: number }
  | {
      matched: false;
      reason: CallProofUnavailableReasonCode;
      actualText?: string;
      callCandidate?: boolean;
    };

interface WindowText {
  text: string;
  lineStarts: ReadonlyMap<number, number>;
  linesByNumber: ReadonlyMap<number, string>;
}

interface CallableSpan {
  chainStart: number;
  tokenStart: number;
  tokenEnd: number;
  proofEnd: number;
  invocationStart: number;
  invocationEndLine: number;
  tokenText: string;
}

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;
const CPP_NON_CALLABLE_KEYWORDS = new Set([
  "alignof",
  "catch",
  "decltype",
  "for",
  "if",
  "noexcept",
  "requires",
  "sizeof",
  "switch",
  "while",
]);

export function proveCppSourceOccurrenceCall(
  input: CppCallProofInput,
): CppCallProofResult {
  if (input.expectedNames.length === 0) {
    return { matched: false, reason: "missingExpectedSymbolName" };
  }

  const windowText = buildWindowText(input.lineWindow);
  const rangeStart = sourceOffsetForRangePosition(windowText, {
    line: input.range.startLine,
    col: input.range.startCol,
  });
  const rangeEnd = sourceOffsetForRangePosition(windowText, {
    line: input.range.endLine,
    col: input.range.endCol,
  });
  if (rangeStart === undefined || rangeEnd === undefined) {
    return { matched: false, reason: "missingSourceLine" };
  }

  const expected = new Set(input.expectedNames);
  let sawInvocationCandidate = false;
  for (const span of findCallableSpans(windowText)) {
    if (!rangesIntersect(rangeStart, rangeEnd, span.chainStart, span.proofEnd)) {
      continue;
    }
    if (
      matchesExpectedCallable(
        span.tokenText,
        expected,
        input.providerSymbolId,
      )
    ) {
      return {
        matched: true,
        line: windowText.linesByNumber.get(input.range.startLine) ?? "",
        invocationEndLine: span.invocationEndLine,
      };
    }
    // Qualifiers and template arguments are part of the syntactic call span,
    // but they are not themselves invoked. Treat mismatches there as neutral
    // occurrence data instead of incomplete call proof.
    if (!rangesIntersect(rangeStart, rangeEnd, span.tokenStart, span.tokenEnd)) {
      continue;
    }
    const constructorType = readConstructorTypeBeforeDeclarator(
      windowText.text,
      span.tokenStart,
    );
    const constructorName = constructorType
      ? matchExpectedConstructorName(constructorType, expected)
      : undefined;
    if (
      constructorName &&
      isExpectedConstructorForProvider(
        input.providerSymbolId,
        constructorName,
        expected,
      )
    ) {
      return {
        matched: true,
        line: windowText.linesByNumber.get(input.range.startLine) ?? "",
        invocationEndLine: span.invocationEndLine,
      };
    }
    const memberInitializerConstructorName =
      readMemberInitializerConstructorName(
        windowText.text,
        span.tokenText,
        span.tokenStart,
        expected,
      );
    if (
      memberInitializerConstructorName &&
      isExpectedConstructorForProvider(
        input.providerSymbolId,
        memberInitializerConstructorName,
        expected,
      )
    ) {
      return {
        matched: true,
        line: windowText.linesByNumber.get(input.range.startLine) ?? "",
        invocationEndLine: span.invocationEndLine,
      };
    }
    if (isMacroLikeCallableToken(span.tokenText)) {
      continue;
    }
    sawInvocationCandidate = true;
    return {
      matched: false,
      reason: "symbolTextMismatch",
      actualText: span.tokenText,
      callCandidate: true,
    };
  }

  return {
    matched: false,
    reason: "symbolTextMismatch",
    callCandidate: sawInvocationCandidate,
  };
}

function buildWindowText(lines: readonly SourceLine[]): WindowText {
  const sorted = [...lines].sort((a, b) => a.lineNumber - b.lineNumber);
  const lineStarts = new Map<number, number>();
  const linesByNumber = new Map<number, string>();
  let text = "";
  for (const line of sorted) {
    lineStarts.set(line.lineNumber, text.length);
    linesByNumber.set(line.lineNumber, line.text);
    text += line.text;
    text += "\n";
  }
  return { text, lineStarts, linesByNumber };
}

function sourceOffsetForRangePosition(
  windowText: WindowText,
  position: { line: number; col: number },
): number | undefined {
  const lineStart = windowText.lineStarts.get(position.line);
  const line = windowText.linesByNumber.get(position.line);
  if (lineStart === undefined || line === undefined) return undefined;
  if (position.col > line.length) return undefined;
  return lineStart + position.col;
}

function findCallableSpans(windowText: WindowText): CallableSpan[] {
  const spans: CallableSpan[] = [];
  const text = windowText.text;
  const ignoredOffsets = ignoredCppOffsets(text);
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "(") continue;
    if (ignoredOffsets[index]) continue;
    const templateArgEnd = skipBackwardWhitespace(text, index);
    const callableEnd = skipBackwardWhitespaceAndTemplateArgs(text, index);
    const token = readCallableTokenBefore(text, callableEnd);
    if (!token) continue;
    if (isCppNonCallableKeyword(token.text)) continue;
    const chainStart = readCallableChainStart(text, token.start);
    spans.push({
      chainStart,
      tokenStart: token.start,
      tokenEnd: token.end,
      proofEnd: templateArgEnd > token.end ? templateArgEnd : token.end,
      invocationStart: index,
      invocationEndLine: lineForOffset(windowText, index),
      tokenText: token.text,
    });
  }
  return spans;
}

function ignoredCppOffsets(text: string): readonly boolean[] {
  const ignored = new Array<boolean>(text.length).fill(false);
  let index = 0;
  while (index < text.length) {
    const rawStringEnd = readRawStringLiteralEnd(text, index);
    if (rawStringEnd !== undefined) {
      markIgnoredRange(ignored, index, rawStringEnd);
      index = rawStringEnd;
      continue;
    }

    if (text[index] === "/" && text[index + 1] === "/") {
      const start = index;
      index += 2;
      while (index < text.length && text[index] !== "\n") index++;
      markIgnoredRange(ignored, start, index);
      continue;
    }

    if (text[index] === "/" && text[index + 1] === "*") {
      const start = index;
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        index++;
      }
      index = Math.min(index + 2, text.length);
      markIgnoredRange(ignored, start, index);
      continue;
    }

    if (text[index] === '"' || text[index] === "'") {
      const quote = text[index];
      const start = index;
      index++;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index++;
          break;
        }
        index++;
      }
      markIgnoredRange(ignored, start, index);
      continue;
    }

    index++;
  }
  return ignored;
}

function readRawStringLiteralEnd(
  text: string,
  start: number,
): number | undefined {
  if (text[start] !== "R" || text[start + 1] !== '"') return undefined;
  let delimiterEnd = start + 2;
  while (
    delimiterEnd < text.length &&
    text[delimiterEnd] !== "(" &&
    text[delimiterEnd] !== "\n"
  ) {
    delimiterEnd++;
  }
  if (text[delimiterEnd] !== "(") return undefined;
  const delimiter = text.slice(start + 2, delimiterEnd);
  const terminator = `)${delimiter}"`;
  const end = text.indexOf(terminator, delimiterEnd + 1);
  return end === -1 ? text.length : end + terminator.length;
}

function markIgnoredRange(
  ignored: boolean[],
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index++) {
    ignored[index] = true;
  }
}

function skipBackwardWhitespaceAndTemplateArgs(text: string, offset: number): number {
  let current = skipBackwardWhitespace(text, offset);
  if (text[current - 1] !== ">") return current;

  let depth = 0;
  for (let index = current - 1; index >= 0; index--) {
    const char = text[index] ?? "";
    if (char === ">") {
      depth++;
    } else if (char === "<") {
      depth--;
      if (depth === 0) {
        return skipBackwardWhitespace(text, index);
      }
    }
  }
  return current;
}

function skipBackwardWhitespace(text: string, offset: number): number {
  let current = offset;
  while (current > 0 && /\s/.test(text[current - 1] ?? "")) current--;
  return current;
}

function readCallableTokenBefore(
  text: string,
  tokenEnd: number,
): { start: number; end: number; text: string } | undefined {
  let start = tokenEnd;
  while (start > 0 && IDENTIFIER_PART.test(text[start - 1] ?? "")) start--;
  if (start === tokenEnd) return undefined;

  if (text.slice(start, tokenEnd) === "operator") {
    return { start, end: tokenEnd, text: "operator" };
  }

  const operatorStart = readOperatorStart(text, start);
  if (operatorStart !== undefined) {
    return {
      start: operatorStart,
      end: tokenEnd,
      text: text.slice(operatorStart, tokenEnd).replace(/\s+/g, " ").trim(),
    };
  }

  if (start > 0 && text[start - 1] === "~") {
    start--;
  }
  return { start, end: tokenEnd, text: text.slice(start, tokenEnd) };
}

function readOperatorStart(text: string, tokenStart: number): number | undefined {
  const beforeToken = skipBackwardWhitespace(text, tokenStart);
  let operatorStart = beforeToken;
  while (
    operatorStart > 0 &&
    IDENTIFIER_PART.test(text[operatorStart - 1] ?? "")
  ) {
    operatorStart--;
  }
  return text.slice(operatorStart, beforeToken) === "operator"
    ? operatorStart
    : undefined;
}

function readCallableChainStart(text: string, tokenStart: number): number {
  let current = skipBackwardWhitespace(text, tokenStart);
  while (current > 0) {
    const separator = readMemberSeparatorBefore(text, current);
    if (!separator) break;
    current = skipBackwardWhitespace(text, separator.start);
    current = skipBackwardTemplateArgs(text, current);
    const nameStart = readIdentifierStartBefore(text, current);
    if (nameStart === undefined) break;
    current = nameStart;
  }
  return current;
}

function readMemberSeparatorBefore(
  text: string,
  offset: number,
): { start: number } | undefined {
  const current = skipBackwardWhitespace(text, offset);
  if (text.slice(current - 2, current) === "::") return { start: current - 2 };
  if (text.slice(current - 2, current) === "->") return { start: current - 2 };
  if (text.slice(current - 3, current) === "->*") return { start: current - 3 };
  if (text[current - 1] === ".") return { start: current - 1 };
  return undefined;
}

function skipBackwardTemplateArgs(text: string, offset: number): number {
  let current = skipBackwardWhitespace(text, offset);
  if (text[current - 1] !== ">") return current;
  return skipBackwardWhitespaceAndTemplateArgs(text, current);
}

function readIdentifierStartBefore(
  text: string,
  offset: number,
): number | undefined {
  let start = skipBackwardWhitespace(text, offset);
  const end = start;
  while (start > 0 && IDENTIFIER_PART.test(text[start - 1] ?? "")) start--;
  if (start === end || !IDENTIFIER_START.test(text[start] ?? "")) {
    return undefined;
  }
  return start;
}

function readConstructorTypeBeforeDeclarator(
  text: string,
  tokenStart: number,
): string | undefined {
  return (
    readImmediateConstructorTypeBeforeDeclarator(text, tokenStart) ??
    readSharedConstructorTypeBeforeDeclarator(text, tokenStart) ??
    readTrailingClassDefinitionTypeBeforeDeclarator(text, tokenStart)
  );
}

function readImmediateConstructorTypeBeforeDeclarator(
  text: string,
  tokenStart: number,
): string | undefined {
  const typeEnd = skipBackwardWhitespace(text, tokenStart);
  if (typeEnd === tokenStart) return undefined;
  let current = skipBackwardTemplateArgs(text, typeEnd);
  current = skipBackwardWhitespace(text, current);
  const typeStart = readIdentifierStartBefore(text, current);
  if (typeStart === undefined) return undefined;
  return text.slice(typeStart, current);
}

function readSharedConstructorTypeBeforeDeclarator(
  text: string,
  tokenStart: number,
): string | undefined {
  const statementStart = statementStartBefore(text, tokenStart);
  const prefix = text.slice(statementStart, tokenStart);
  const commaIndex = prefix.lastIndexOf(",");
  if (commaIndex === -1) return undefined;

  const firstInvocationIndex = prefix.indexOf("(");
  if (firstInvocationIndex === -1 || firstInvocationIndex > commaIndex) {
    return undefined;
  }
  const firstDeclaratorTokenEnd = skipBackwardWhitespaceAndTemplateArgs(
    prefix,
    firstInvocationIndex,
  );
  const firstDeclarator = readCallableTokenBefore(prefix, firstDeclaratorTokenEnd);
  if (!firstDeclarator || firstDeclarator.start > commaIndex) return undefined;

  return readImmediateConstructorTypeBeforeDeclarator(
    prefix,
    firstDeclarator.start,
  );
}

function readTrailingClassDefinitionTypeBeforeDeclarator(
  text: string,
  tokenStart: number,
): string | undefined {
  const classEnd = skipBackwardWhitespace(text, tokenStart);
  if (text[classEnd - 1] !== "}") return undefined;
  const classStart = findMatchingOpenBrace(text, classEnd - 1);
  if (classStart === undefined) return undefined;

  // Local class definitions can declare an object immediately after the closing
  // brace: `struct RestorePath { ... } restore_path(path);`.
  const nameEnd = skipBackwardWhitespace(text, classStart);
  const nameStart = readIdentifierStartBefore(text, nameEnd);
  if (nameStart === undefined) return undefined;
  const keywordEnd = skipBackwardWhitespace(text, nameStart);
  const keywordStart = readIdentifierStartBefore(text, keywordEnd);
  if (keywordStart === undefined) return undefined;

  const keyword = text.slice(keywordStart, keywordEnd);
  if (keyword !== "class" && keyword !== "struct" && keyword !== "union") {
    return undefined;
  }
  return text.slice(nameStart, nameEnd);
}

function findMatchingOpenBrace(
  text: string,
  closeBraceOffset: number,
): number | undefined {
  let depth = 0;
  for (let index = closeBraceOffset; index >= 0; index--) {
    const char = text[index];
    if (char === "}") {
      depth++;
      continue;
    }
    if (char === "{") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function statementStartBefore(text: string, tokenStart: number): number {
  let start = 0;
  for (const boundary of [";", "{", "}"]) {
    const index = text.lastIndexOf(boundary, tokenStart);
    if (index !== -1) start = Math.max(start, index + 1);
  }
  return start;
}

function readMemberInitializerConstructorName(
  text: string,
  memberName: string,
  tokenStart: number,
  expected: ReadonlySet<string>,
): string | undefined {
  if (!isLikelyMemberInitializer(text, tokenStart)) return undefined;

  const namePattern = new RegExp(`\\b${escapeRegExp(memberName)}\\b`, "g");
  let match: RegExpExecArray | null;
  let matchedConstructorName: string | undefined;
  const prefix = text.slice(0, tokenStart);
  while ((match = namePattern.exec(prefix)) !== null) {
    const typeToken = readConstructorTypeBeforeDeclarator(prefix, match.index);
    if (!typeToken) continue;
    matchedConstructorName =
      matchExpectedConstructorName(typeToken, expected) ??
      matchedConstructorName;
  }
  return matchedConstructorName;
}

function isLikelyMemberInitializer(text: string, tokenStart: number): boolean {
  const searchStart = Math.max(0, tokenStart - 500);
  const prefix = text.slice(searchStart, tokenStart);
  const initializerColon = lastStandaloneColon(prefix);
  if (initializerColon === undefined) return false;

  const lastTerminator = Math.max(
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf("{"),
    prefix.lastIndexOf("}"),
  );
  if (initializerColon <= lastTerminator) return false;

  const declaratorPrefix = prefix.slice(lastTerminator + 1, initializerColon);
  return declaratorPrefix.includes(")") && !declaratorPrefix.includes("?");
}

function lastStandaloneColon(text: string): number | undefined {
  for (let index = text.length - 1; index >= 0; index--) {
    if (text[index] !== ":") continue;
    if (text[index - 1] === ":" || text[index + 1] === ":") continue;
    return index;
  }
  return undefined;
}

function matchExpectedConstructorName(
  sourceTypeName: string,
  expected: ReadonlySet<string>,
): string | undefined {
  if (expected.has(sourceTypeName)) return sourceTypeName;
  if (sourceTypeName === "string" && expected.has("basic_string")) {
    return "basic_string";
  }
  return undefined;
}

function isConstructorProviderSymbol(
  providerSymbolId: string,
  constructorName: string,
): boolean {
  const parsed = parseScipSymbol(providerSymbolId);
  return parsed.descriptors.includes(`#${constructorName}(`);
}

function isExpectedConstructorForProvider(
  providerSymbolId: string,
  sourceConstructorName: string,
  expected: ReadonlySet<string>,
): boolean {
  if (isConstructorProviderSymbol(providerSymbolId, sourceConstructorName)) {
    return true;
  }
  if (!expected.has(sourceConstructorName)) return false;
  return [...expected].some((expectedName) =>
    isConstructorProviderSymbol(providerSymbolId, expectedName),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesExpectedCallable(
  tokenText: string,
  expected: ReadonlySet<string>,
  providerSymbolId: string,
): boolean {
  if (expected.has(tokenText)) return true;
  // `~callable<T>(...)` is a unary operator applied to a real call, while
  // `~Type()` is a destructor spelling. Keep destructor symbols exact, but let
  // ordinary callable symbols prove through the bare token after the unary `~`.
  if (
    tokenText.startsWith("~") &&
    expected.has(tokenText.slice(1)) &&
    !isDestructorProviderSymbol(providerSymbolId)
  ) {
    return true;
  }
  return false;
}

function isDestructorProviderSymbol(providerSymbolId: string): boolean {
  const parsed = parseScipSymbol(providerSymbolId);
  return /(?:^|[#/.])`?~/.test(parsed.descriptors);
}

function isMacroLikeCallableToken(tokenText: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(tokenText) && tokenText.includes("_");
}

function isCppNonCallableKeyword(tokenText: string): boolean {
  return CPP_NON_CALLABLE_KEYWORDS.has(tokenText);
}

function rangesIntersect(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function lineForOffset(windowText: WindowText, offset: number): number {
  let line = 0;
  for (const [lineNumber, lineStart] of windowText.lineStarts.entries()) {
    if (lineStart <= offset) line = lineNumber;
  }
  return line;
}
