import type { Range } from "../../domain/types.js";
import {
  isClangStyleSymbolScheme,
  parseScipSymbol,
} from "../../scip/kind-mapping.js";
import type { ScipRange } from "../../scip/types.js";
import {
  type SourceLine,
  proveCppSourceOccurrenceCall,
} from "./cpp-call-proof.js";
import type {
  CallProofUnavailableReasonCode,
  CallProofUnavailableSampleFact,
} from "./types.js";

export const CALL_PROOF_SAMPLE_TEXT_LIMIT = 120;
const CPP_CALL_PROOF_LINE_WINDOW_RADIUS = 2;

export interface SourceCallProofParams {
  providerSymbolId: string;
  relPath: string;
  range: ScipRange;
  expectedNames: readonly string[];
  sourceLines: ReadonlyMap<number, string> | undefined;
  sourceUnavailableReason?: CallProofUnavailableReasonCode;
}

interface SourceColumnRange {
  startCol: number;
  endCol: number;
}

export type SourceCallProofResult =
  | { matched: true; line: string; invocationEndLine: number }
  | {
      matched: false;
      reason: CallProofUnavailableReasonCode;
      sample?: CallProofUnavailableSampleFact;
      callCandidate?: boolean;
      skipFallback?: boolean;
    };

export function proveSourceOccurrenceCall(
  params: SourceCallProofParams,
): SourceCallProofResult {
  const exactResult = proveExactSourceOccurrenceCall(params);
  if (exactResult.matched) return exactResult;
  if (exactResult.reason === "multiLineRange") {
    const rustOperatorResult = proveRustPartialEqOperatorComparison(params);
    if (rustOperatorResult) return rustOperatorResult;
  }
  if (
    exactResult.reason === "symbolTextMismatch" &&
    exactResult.skipFallback === true
  ) {
    return exactResult;
  }
  const parsedSymbol = parseScipSymbol(params.providerSymbolId);
  if (
    exactResult.reason === "multiLineRange" &&
    isClangStyleSymbolScheme(parsedSymbol.scheme) &&
    isExpectedConstructorDescriptor(parsedSymbol.descriptors, params.expectedNames) &&
    isCxxStringLiteralRange(params)
  ) {
    return { ...exactResult, callCandidate: false };
  }
  if (
    !shouldTryCppCallProofFallback(
      exactResult.reason,
      parsedSymbol.scheme,
      params.sourceLines,
    )
  ) {
    if (exactResult.reason === "multiLineRange") {
      return { ...exactResult, sample: multiLineRangeSample(params) };
    }
    return exactResult;
  }

  const cppResult = proveCppSourceOccurrenceCall({
    providerSymbolId: params.providerSymbolId,
    expectedNames: params.expectedNames,
    lineWindow: sourceLineWindow(params.sourceLines, params.range),
    range: params.range,
  });
  if (cppResult.matched) return cppResult;
  if (cppResult.callCandidate === false) {
    return { ...exactResult, callCandidate: false };
  }
  if (cppResult.actualText) {
    return {
      matched: false,
      reason: cppResult.reason,
      callCandidate: cppResult.callCandidate,
      sample: {
        relPath: params.relPath,
        range: scipRangeToRange(params.range),
        expectedText: truncateCallProofSampleText(params.expectedNames[0] ?? ""),
        actualText: truncateCallProofSampleText(cppResult.actualText),
      },
    };
  }
  if (exactResult.reason === "multiLineRange") {
    return {
      ...exactResult,
      callCandidate: cppResult.callCandidate,
      sample: multiLineRangeSample(params),
    };
  }
  return { ...exactResult, callCandidate: cppResult.callCandidate };
}

function shouldTryCppCallProofFallback(
  reason: CallProofUnavailableReasonCode,
  scheme: string,
  sourceLines: ReadonlyMap<number, string> | undefined,
): boolean {
  if (!isClangStyleSymbolScheme(scheme)) return false;
  if (reason === "symbolTextMismatch") return true;
  // clang/cxx providers sometimes attach a reference to a multi-line template
  // or member invocation span. The bounded C++ proof window can still verify
  // the invoked token, but only when repo source lines were actually retained.
  return reason === "multiLineRange" && sourceLines !== undefined;
}

function proveRustPartialEqOperatorComparison(
  params: SourceCallProofParams,
): SourceCallProofResult | undefined {
  if (!params.sourceLines || !params.expectedNames.includes("eq")) {
    return undefined;
  }
  const parsed = parseScipSymbol(params.providerSymbolId);
  if (
    parsed.scheme !== "rust-analyzer" ||
    !parsed.descriptors.endsWith("eq().") ||
    !parsed.descriptors.includes("PartialEq<")
  ) {
    return undefined;
  }

  const endLine = params.sourceLines.get(params.range.endLine);
  if (!endLine) return undefined;
  // Rust Analyzer can attach PartialEq::eq to the whitespace before `==` when
  // a comparison is split across lines. The operator token at the range end is
  // enough source proof that this reference is the comparison call.
  return endLine.slice(params.range.endCol).trimStart().startsWith("==")
    ? { matched: true, line: endLine, invocationEndLine: params.range.endLine }
    : undefined;
}

function proveExactSourceOccurrenceCall(
  params: SourceCallProofParams,
): SourceCallProofResult {
  const canProveLocationOnlyMacro = isClangLocationOnlyMacroSymbol(
    params.providerSymbolId,
  );
  if (params.expectedNames.length === 0 && !canProveLocationOnlyMacro) {
    return { matched: false, reason: "missingExpectedSymbolName" };
  }
  if (params.range.startLine !== params.range.endLine) {
    return { matched: false, reason: "multiLineRange" };
  }
  if (!params.sourceLines) {
    return {
      matched: false,
      reason: params.sourceUnavailableReason ?? "sourceUnavailable",
    };
  }

  const line = params.sourceLines.get(params.range.startLine);
  if (line === undefined) {
    return { matched: false, reason: "missingSourceLine" };
  }
  const sourceRange = resolveSourceColumnRange(
    line,
    params.range,
    params.expectedNames,
  );
  if (!sourceRange) {
    if (isNeutralJvmOutOfBoundsReference(params, line)) {
      return {
        matched: false,
        reason: "rangeOutOfBounds",
        callCandidate: false,
      };
    }
    return { matched: false, reason: "rangeOutOfBounds" };
  }

  const occurrenceText = line.slice(sourceRange.startCol, sourceRange.endCol);
  if (
    canProveLocationOnlyMacro &&
    isProvenClangLocationOnlyMacroReference(
      params.providerSymbolId,
      occurrenceText,
      line,
      sourceRange.endCol,
    )
  ) {
    return { matched: true, line, invocationEndLine: params.range.endLine };
  }
  if (
    isProvenCxxOperatorTokenReference(
      params.providerSymbolId,
      occurrenceText,
    )
  ) {
    return { matched: true, line, invocationEndLine: params.range.endLine };
  }
  if (
    isProvenCxxCallableOperatorTokenReference(
      params.providerSymbolId,
      occurrenceText,
    )
  ) {
    return { matched: true, line, invocationEndLine: params.range.endLine };
  }
  if (params.expectedNames.length === 0) {
    return { matched: false, reason: "missingExpectedSymbolName" };
  }
  if (isCxxStringLiteralConstructorText(params, occurrenceText)) {
    return {
      matched: false,
      reason: "symbolTextMismatch",
      callCandidate: false,
      skipFallback: true,
    };
  }
  if (
    isPythonModuleQualifierMemberInvocation(
      params,
      occurrenceText,
      line,
      sourceRange,
    )
  ) {
    return {
      matched: false,
      reason: "symbolTextMismatch",
      callCandidate: false,
      skipFallback: true,
    };
  }
  if (
    isCxxOperatorDeclarationReference(
      params,
      occurrenceText,
      line,
      sourceRange,
    )
  ) {
    return {
      matched: false,
      reason: "symbolTextMismatch",
      callCandidate: false,
      skipFallback: true,
    };
  }

  const primaryExpectedName = params.expectedNames[0] ?? "";
  const matchedName = params.expectedNames.find((name) => name === occurrenceText);
  if (
    isProvenCxxTrailingLocalClassConstructor(
      params,
      sourceRange,
      occurrenceText,
      line,
    )
  ) {
    return { matched: true, line, invocationEndLine: params.range.endLine };
  }
  if (
    isQualifiedSourceInvocationForExpectedName(
      params.providerSymbolId,
      params.expectedNames,
      occurrenceText,
      line,
      sourceRange.endCol,
    )
  ) {
    return { matched: true, line, invocationEndLine: params.range.endLine };
  }
  if (
    isJvmConstructorSelfOrSuperInvocation(
      params.providerSymbolId,
      occurrenceText,
      line,
      sourceRange.endCol,
    )
  ) {
    return { matched: true, line, invocationEndLine: params.range.endLine };
  }
  const continuedIdentifier =
    sourceRange.endCol < line.length &&
    isIdentifierContinue(line[sourceRange.endCol] ?? "");
  if (matchedName && continuedIdentifier) {
    return {
      matched: false,
      reason: "symbolTextMismatch",
      callCandidate: hasInvocationCandidateAfterMismatch(line, params.range.endCol),
      sample: {
        relPath: params.relPath,
        range: scipRangeToRange(params.range),
        expectedText: truncateCallProofSampleText(matchedName),
        actualText: truncateCallProofSampleText(
          expandIdentifierText(line, sourceRange.startCol),
        ),
      },
    };
  }

  const callCandidate = hasInvocationCandidateAfterMismatch(
    line,
    sourceRange.endCol,
  );
  if (!matchedName) {
    return {
      matched: false,
      reason: "symbolTextMismatch",
      callCandidate,
      sample: {
        relPath: params.relPath,
        range: scipRangeToRange(params.range),
        expectedText: truncateCallProofSampleText(primaryExpectedName),
        actualText: truncateCallProofSampleText(occurrenceText),
      },
    };
  }
  return hasInvocationSuffix(line, sourceRange.endCol)
    ? { matched: true, line, invocationEndLine: params.range.endLine }
    : { matched: false, reason: "symbolTextMismatch", callCandidate: false };
}

function resolveSourceColumnRange(
  line: string,
  range: ScipRange,
  expectedNames: readonly string[],
): SourceColumnRange | undefined {
  const byteStartCol = utf8ByteColumnToUtf16Index(line, range.startCol);
  const byteEndCol = utf8ByteColumnToUtf16Index(line, range.endCol);
  const utf8Range =
    byteStartCol === undefined ||
    byteEndCol === undefined ||
    byteStartCol > byteEndCol
      ? undefined
      : { startCol: byteStartCol, endCol: byteEndCol };
  const utf16Range =
    range.startCol <= line.length &&
    range.endCol <= line.length &&
    range.startCol <= range.endCol
      ? { startCol: range.startCol, endCol: range.endCol }
      : undefined;
  if (!utf8Range) return utf16Range;
  if (
    !utf16Range ||
    (utf8Range.startCol === utf16Range.startCol &&
      utf8Range.endCol === utf16Range.endCol)
  ) {
    return utf8Range;
  }

  const score = (candidate: SourceColumnRange): number => {
    const occurrenceText = line.slice(candidate.startCol, candidate.endCol);
    const expectedMatch = expectedNames.some(
      (name) =>
        occurrenceText === name ||
        occurrenceText.startsWith(name + ".") ||
        occurrenceText.endsWith("." + name),
    );
    return (expectedMatch ? 2 : 0) +
      (hasInvocationSuffix(line, candidate.endCol) ? 1 : 0);
  };

  return score(utf16Range) > score(utf8Range) ? utf16Range : utf8Range;
}

function utf8ByteColumnToUtf16Index(
  line: string,
  byteColumn: number,
): number | undefined {
  let bytes = 0;
  let utf16Index = 0;
  for (const char of line) {
    if (bytes === byteColumn) return utf16Index;
    bytes += Buffer.byteLength(char, "utf8");
    utf16Index += char.length;
    if (bytes > byteColumn) return undefined;
  }
  return bytes === byteColumn ? utf16Index : undefined;
}

function isPythonModuleQualifierMemberInvocation(
  params: SourceCallProofParams,
  occurrenceText: string,
  line: string,
  sourceRange: SourceColumnRange,
): boolean {
  const parsed = parseScipSymbol(params.providerSymbolId);
  if (
    parsed.scheme !== "scip-python" ||
    !parsed.descriptors.endsWith("/__init__:")
  ) {
    return false;
  }
  if (!hasInvocationSuffix(line, sourceRange.endCol)) return false;

  for (const expectedName of params.expectedNames) {
    if (
      expectedName.length > 0 &&
      occurrenceText.startsWith(`${expectedName}.`) &&
      isPythonQualifiedName(occurrenceText.slice(expectedName.length + 1))
    ) {
      return true;
    }
  }
  return false;
}

function isPythonQualifiedName(value: string): boolean {
  if (value.length === 0) return false;
  return value.split(".").every((part) => isIdentifierText(part));
}

function isQualifiedSourceInvocationForExpectedName(
  providerSymbolId: string,
  expectedNames: readonly string[],
  occurrenceText: string,
  line: string,
  endCol: number,
): boolean {
  if (!isJvmSymbolScheme(providerSymbolId)) return false;
  if (!hasInvocationSuffix(line, endCol)) return false;
  const parts = occurrenceText.split(".");
  if (parts.length < 2 || !parts.every((part) => isIdentifierText(part))) {
    return false;
  }
  const terminalName = parts[parts.length - 1] ?? "";
  return expectedNames.includes(terminalName);
}

function isJvmConstructorSelfOrSuperInvocation(
  providerSymbolId: string,
  occurrenceText: string,
  line: string,
  endCol: number,
): boolean {
  return (
    isJvmConstructorDelegationTargetSymbol(providerSymbolId) &&
    (occurrenceText === "this" || occurrenceText === "super") &&
    hasInvocationSuffix(line, endCol)
  );
}

function isJvmSymbolScheme(providerSymbolId: string): boolean {
  const { scheme } = parseScipSymbol(providerSymbolId);
  return isJvmScheme(scheme);
}

function isJvmConstructorDelegationTargetSymbol(providerSymbolId: string): boolean {
  const parsed = parseScipSymbol(providerSymbolId);
  if (!isJvmScheme(parsed.scheme)) return false;
  // scip-java may attach this(...)/super(...) references to either the
  // constructor descriptor or the owning class/superclass descriptor.
  return (
    /#`?<init>`?\([^)]*\)\.$/.test(parsed.descriptors) ||
    parsed.descriptors.endsWith("#")
  );
}

function isNeutralJvmOutOfBoundsReference(
  params: SourceCallProofParams,
  line: string,
): boolean {
  const parsed = parseScipSymbol(params.providerSymbolId);
  if (!isJvmScheme(parsed.scheme)) return false;
  if (params.range.startCol > line.length || params.range.endCol <= line.length) {
    return false;
  }
  if (parsed.descriptors.endsWith("#")) return true;

  const propertyName = jvmAccessorPropertyName(parsed.descriptors);
  for (const expectedName of [...params.expectedNames, propertyName]) {
    if (expectedName && isJvmPropertyDeclarationLine(line, expectedName)) {
      return true;
    }
  }
  return false;
}

function jvmAccessorPropertyName(descriptors: string): string {
  const descriptorName = descriptorLeafName(descriptors);
  const match = /^(?:get|set|is)([A-Z].*)$/.exec(descriptorName);
  if (!match?.[1]) return "";
  return `${match[1][0]?.toLowerCase() ?? ""}${match[1].slice(1)}`;
}

function descriptorLeafName(descriptors: string): string {
  const stripped = descriptors.replace(/\([^)]*\)\.$/, "").replace(/[.#]$/, "");
  const separatorIndex = Math.max(stripped.lastIndexOf("#"), stripped.lastIndexOf("/"));
  return stripped.slice(separatorIndex + 1).replace(/`/g, "");
}

function isJvmPropertyDeclarationLine(line: string, propertyName: string): boolean {
  return new RegExp(
    `\\b(?:val|var)\\s+${escapeRegExp(propertyName)}\\b`,
  ).test(line);
}

function isJvmScheme(scheme: string): boolean {
  return (
    scheme === "semanticdb" ||
    scheme === "scip-java" ||
    scheme === "scip-kotlin"
  );
}

function isCxxOperatorDeclarationReference(
  params: SourceCallProofParams,
  occurrenceText: string,
  line: string,
  sourceRange: SourceColumnRange,
): boolean {
  const parsed = parseScipSymbol(params.providerSymbolId);
  if (!isClangStyleSymbolScheme(parsed.scheme)) return false;
  if (!hasCxxOperatorDeclarationPrefix(line, sourceRange.startCol)) {
    return false;
  }
  if (
    params.expectedNames.includes(occurrenceText) &&
    hasCxxConversionOperatorTypePrefix(line, sourceRange.startCol)
  ) {
    return hasCxxConversionOperatorDeclarationSuffix(line, sourceRange.endCol);
  }
  if (occurrenceText === "operator") {
    return (
      (params.expectedNames.includes("operator()") &&
        line.slice(sourceRange.endCol).trimStart().startsWith("()")) ||
      hasCxxSymbolicOperatorDeclarationSuffix(
        line,
        sourceRange.endCol,
        params.expectedNames,
      )
    );
  }
  if (!occurrenceText.startsWith("operator ")) return false;

  const conversionName = occurrenceText.slice("operator ".length).trim();
  return (
    params.expectedNames.includes(conversionName) &&
    hasCxxConversionOperatorDeclarationSuffix(line, sourceRange.endCol)
  );
}

function hasCxxSymbolicOperatorDeclarationSuffix(
  line: string,
  endCol: number,
  expectedNames: readonly string[],
): boolean {
  const suffix = line.slice(endCol).trimStart();
  return expectedNames.some((expectedName) => {
    const operatorSpelling = cxxSymbolicOperatorSpelling(expectedName);
    if (!operatorSpelling || !suffix.startsWith(operatorSpelling)) {
      return false;
    }
    return suffix.slice(operatorSpelling.length).trimStart().startsWith("(");
  });
}

function cxxSymbolicOperatorSpelling(expectedName: string): string | undefined {
  const name = stripBalancedBacktickName(expectedName) || expectedName;
  if (!name.startsWith("operator")) return undefined;
  const spelling = name.slice("operator".length).trim();
  if (spelling.length === 0 || /^[A-Za-z_]/.test(spelling)) return undefined;
  return spelling;
}

function stripBalancedBacktickName(name: string): string {
  if (!name.startsWith("`") || !name.endsWith("`")) return "";
  if (name.slice(1, -1).includes("`")) return "";
  return name.slice(1, -1);
}

function hasCxxConversionOperatorTypePrefix(
  line: string,
  startCol: number,
): boolean {
  const prefix = line.slice(0, startCol).trimEnd();
  if (!prefix.endsWith("operator")) return false;
  return hasCxxOperatorDeclarationPrefix(
    line,
    prefix.length - "operator".length,
  );
}

function hasCxxOperatorDeclarationPrefix(line: string, startCol: number): boolean {
  const prefix = line.slice(0, startCol).trimEnd();
  return (
    !prefix.endsWith(".") &&
    !prefix.endsWith("->") &&
    !prefix.endsWith("->*")
  );
}

function hasCxxConversionOperatorDeclarationSuffix(
  line: string,
  endCol: number,
): boolean {
  const suffix = line.slice(endCol).trimStart();
  if (suffix.startsWith("(")) return true;
  if (!suffix.startsWith("<")) return false;

  let depth = 0;
  for (let index = 0; index < suffix.length; index++) {
    const char = suffix[index] ?? "";
    if (char === "<") {
      depth++;
      continue;
    }
    if (char === ">") {
      depth--;
      if (depth === 0) {
        return suffix.slice(index + 1).trimStart().startsWith("(");
      }
    }
  }
  return false;
}

function multiLineRangeSample(
  params: SourceCallProofParams,
): CallProofUnavailableSampleFact | undefined {
  if (!params.sourceLines) return undefined;
  const fragments: string[] = [];
  for (
    let lineNumber = params.range.startLine;
    lineNumber <= params.range.endLine;
    lineNumber++
  ) {
    const sourceLine = params.sourceLines.get(lineNumber);
    if (sourceLine === undefined) return undefined;
    if (lineNumber === params.range.startLine) {
      if (params.range.startCol > sourceLine.length) return undefined;
      fragments.push(sourceLine.slice(params.range.startCol));
      continue;
    }
    if (lineNumber === params.range.endLine) {
      if (params.range.endCol > sourceLine.length) return undefined;
      fragments.push(sourceLine.slice(0, params.range.endCol));
      continue;
    }
    fragments.push(sourceLine);
  }
  return {
    relPath: params.relPath,
    range: scipRangeToRange(params.range),
    expectedText: truncateCallProofSampleText(params.expectedNames[0] ?? ""),
    actualText: truncateCallProofSampleText(fragments.join("\\n")),
  };
}

function isCxxStringLiteralRange(params: SourceCallProofParams): boolean {
  if (params.range.startLine === params.range.endLine || !params.sourceLines) {
    return false;
  }
  const firstLine = params.sourceLines.get(params.range.startLine);
  if (firstLine === undefined || params.range.startCol > firstLine.length) {
    return false;
  }
  // clang can report an implicit constructor over an entire string literal;
  // this is not a source-proven callable invocation that should gate readiness.
  return /^(?:u8|u|U|L)?(?:R"[^()\s\\]*\(|")/.test(
    firstLine.slice(params.range.startCol),
  );
}

function isCxxStringLiteralConstructorText(
  params: SourceCallProofParams,
  occurrenceText: string,
): boolean {
  const parsed = parseScipSymbol(params.providerSymbolId);
  return (
    isClangStyleSymbolScheme(parsed.scheme) &&
    isExpectedConstructorDescriptor(parsed.descriptors, params.expectedNames) &&
    isCxxStringLiteralStart(occurrenceText)
  );
}

function isCxxStringLiteralStart(value: string): boolean {
  return /^(?:u8|u|U|L)?(?:R"[^()\s\\]*\(|")/.test(value);
}

function isExpectedConstructorDescriptor(
  descriptors: string,
  expectedNames: readonly string[],
): boolean {
  return expectedNames.some((name) => descriptors.includes(`#${name}(`));
}

function isProvenCxxTrailingLocalClassConstructor(
  params: SourceCallProofParams,
  sourceRange: SourceColumnRange,
  occurrenceText: string,
  line: string,
): boolean {
  if (!isIdentifierText(occurrenceText)) return false;
  if (!hasInvocationSuffix(line, sourceRange.endCol)) return false;
  if (!line.slice(0, sourceRange.startCol).trimEnd().endsWith("}")) {
    return false;
  }

  const parsed = parseScipSymbol(params.providerSymbolId);
  if (!isClangStyleSymbolScheme(parsed.scheme)) return false;
  const constructorName = params.expectedNames.find(
    (name) => isIdentifierText(name) && parsed.descriptors.includes(`#${name}(`),
  );
  if (!constructorName || !params.sourceLines) return false;

  const declarationPattern = new RegExp(
    `\\b(?:class|struct|union)\\s+${escapeRegExp(constructorName)}\\b`,
  );
  const startLine = Math.max(0, params.range.startLine - 8);
  for (let lineNumber = params.range.startLine - 1; lineNumber >= startLine; lineNumber--) {
    const sourceLine = params.sourceLines.get(lineNumber);
    if (sourceLine === undefined) continue;
    if (declarationPattern.test(sourceLine)) return true;
  }
  return false;
}

export function hasInvocationSuffix(line: string, endCol: number): boolean {
  return isInvocationSuffix(line.slice(endCol).trimStart());
}

export function hasInvocationCandidateAfterMismatch(
  line: string,
  endCol: number,
): boolean {
  if (hasInvocationSuffix(line, endCol)) return true;
  let tokenEndCol = endCol;
  while (
    tokenEndCol < line.length &&
    isIdentifierContinue(line[tokenEndCol] ?? "")
  ) {
    tokenEndCol++;
  }
  return (
    tokenEndCol > endCol &&
    isInvocationSuffix(line.slice(tokenEndCol).trimStart())
  );
}

function isInvocationSuffix(suffix: string): boolean {
  return (
    suffix.startsWith("(") ||
    suffix.startsWith("?.(") ||
    (suffix.startsWith("!") && suffix.slice(1).trimStart().startsWith("("))
  );
}

function isProvenCxxOperatorTokenReference(
  providerSymbolId: string,
  occurrenceText: string,
): boolean {
  if (!/^[~!%^&*+\-=|<>\/?]+$/.test(occurrenceText)) return false;
  const parsed = parseScipSymbol(providerSymbolId);
  return (
    isClangStyleSymbolScheme(parsed.scheme) &&
    parsed.descriptors.includes(`\`operator${occurrenceText}\``)
  );
}

function isProvenCxxCallableOperatorTokenReference(
  providerSymbolId: string,
  occurrenceText: string,
): boolean {
  if (occurrenceText !== "(") return false;
  const parsed = parseScipSymbol(providerSymbolId);
  return (
    isClangStyleSymbolScheme(parsed.scheme) &&
    parsed.descriptors.includes("`operator()`")
  );
}

export function isIdentifierContinue(value: string): boolean {
  return /^[A-Za-z0-9_$]$/.test(value);
}

export function isIdentifierText(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

export function expandIdentifierText(line: string, startCol: number): string {
  let endCol = startCol;
  while (endCol < line.length && isIdentifierContinue(line[endCol] ?? "")) {
    endCol++;
  }
  return line.slice(startCol, endCol);
}

export function truncateCallProofSampleText(value: string): string {
  return value.length <= CALL_PROOF_SAMPLE_TEXT_LIMIT
    ? value
    : `${value.slice(0, CALL_PROOF_SAMPLE_TEXT_LIMIT - 3)}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isProvenClangLocationOnlyMacroReference(
  providerSymbolId: string,
  occurrenceText: string,
  line: string,
  endCol: number,
): boolean {
  return (
    isClangLocationOnlyMacroSymbol(providerSymbolId) &&
    isIdentifierText(occurrenceText) &&
    hasInvocationSuffix(line, endCol)
  );
}

function isClangLocationOnlyMacroSymbol(providerSymbolId: string): boolean {
  const parsed = parseScipSymbol(providerSymbolId);
  if (!isClangStyleSymbolScheme(parsed.scheme)) return false;
  return /^`.+:\d+:\d+`!$/.test(parsed.descriptors);
}

function sourceLineWindow(
  sourceLines: ReadonlyMap<number, string> | undefined,
  range: ScipRange,
): readonly SourceLine[] {
  if (!sourceLines) return [];
  const startLine = Math.max(
    0,
    range.startLine - CPP_CALL_PROOF_LINE_WINDOW_RADIUS,
  );
  const endLine = range.endLine + CPP_CALL_PROOF_LINE_WINDOW_RADIUS;

  const lines: SourceLine[] = [];
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const text = sourceLines.get(lineNumber);
    if (text === undefined) break;
    lines.push({ lineNumber, text });
  }
  return lines;
}

function scipRangeToRange(range: ScipRange): Range {
  return {
    startLine: range.startLine + 1,
    startCol: range.startCol,
    endLine: range.endLine + 1,
    endCol: range.endCol,
  };
}
