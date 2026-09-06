import { normalizePath } from "../../util/paths.js";
import {
  expandIdentifierText,
  hasInvocationCandidateAfterMismatch,
  isIdentifierContinue,
  isProvenClangLocationOnlyMacroReference,
  truncateCallProofSampleText,
} from "./source-call-proof.js";
import {
  importAliasSourceTextCandidates,
  sourceTextCandidatesForScipSymbol,
  type SourceLinesByPath,
} from "./scip-normalizer.js";
import type {
  CallProofUnavailableReasonCode,
  CallProofUnavailableReasonSampleFact,
  CallProofUnavailableSampleFact,
} from "./types.js";

export const CALL_PROOF_SUMMARY_SAMPLE_LIMIT = 5;

/** Collect bounded source mismatches for provider coverage diagnostics. */
export function collectCallProofMismatchSamples(params: {
  occurrences: Iterable<{
    relPath: string;
    role: string;
    symbolId?: string;
    providerSymbolId: string;
    range: {
      startLine: number;
      startCol: number;
      endLine: number;
      endCol: number;
    };
  }>;
  symbols: Iterable<{
    providerSymbolId: string;
    name?: string;
  }>;
  sourceLinesByPath?: SourceLinesByPath;
}): Map<CallProofUnavailableReasonCode, CallProofUnavailableSampleFact[]> {
  if (!params.sourceLinesByPath) return new Map();

  const occurrences = [...params.occurrences];
  const sourceTextCandidatesBySymbol = new Map(
    Array.from(params.symbols, (symbol) => [
      symbol.providerSymbolId,
      symbol.name
        ? sourceTextCandidatesForScipSymbol(
            symbol.providerSymbolId,
            symbol.name,
          )
        : [],
    ]),
  );
  const localSourceTextCandidates = collectLocalImportAliasCandidates({
    occurrences,
    sourceLinesByPath: params.sourceLinesByPath,
    sourceTextCandidatesBySymbol,
  });
  const samplesByReason = new Map<
    CallProofUnavailableReasonCode,
    CallProofUnavailableSampleFact[]
  >();

  for (const occurrence of occurrences) {
    if (occurrence.role !== "reference" || !occurrence.symbolId) continue;
    const expectedNames = mergeSourceTextCandidates(
      sourceTextCandidatesBySymbol.get(occurrence.providerSymbolId),
      localSourceTextCandidates
        .get(occurrence.relPath)
        ?.get(occurrence.providerSymbolId),
    );
    if (expectedNames.length === 0) continue;
    const primaryExpectedName = expectedNames[0] ?? "";
    if (occurrence.range.startLine !== occurrence.range.endLine) {
      const samplesForReason = samplesByReason.get("multiLineRange") ?? [];
      if (samplesForReason.length >= CALL_PROOF_SUMMARY_SAMPLE_LIMIT) {
        continue;
      }
      const actualText = multiLineRangeSampleText(
        params.sourceLinesByPath.get(occurrence.relPath),
        occurrence.range,
      );
      if (!actualText) continue;
      samplesForReason.push({
        relPath: occurrence.relPath,
        range: occurrence.range,
        expectedText: truncateCallProofSampleText(primaryExpectedName),
        actualText,
      });
      samplesByReason.set("multiLineRange", samplesForReason);
      continue;
    }
    const sourceLine = params.sourceLinesByPath
      .get(occurrence.relPath)
      ?.get(occurrence.range.startLine - 1);
    if (sourceLine === undefined) continue;
    if (occurrence.range.endCol > sourceLine.length) continue;

    const occurrenceText = sourceLine.slice(
      occurrence.range.startCol,
      occurrence.range.endCol,
    );
    if (
      isProvenClangLocationOnlyMacroReference(
        occurrence.providerSymbolId,
        occurrenceText,
        sourceLine,
        occurrence.range.endCol,
      )
    ) {
      continue;
    }
    const matchedName = expectedNames.find((name) => name === occurrenceText);
    const continuedIdentifier =
      occurrence.range.endCol < sourceLine.length &&
      isIdentifierContinue(sourceLine[occurrence.range.endCol] ?? "");
    const actualText =
      matchedName && continuedIdentifier
        ? expandIdentifierText(sourceLine, occurrence.range.startCol)
        : occurrenceText;
    const textMatches = Boolean(matchedName && !continuedIdentifier);
    const callCandidate = hasInvocationCandidateAfterMismatch(
      sourceLine,
      occurrence.range.endCol,
    );
    if (textMatches || !callCandidate) {
      continue;
    }

    const reason = "symbolTextMismatch" as const;
    const samplesForReason = samplesByReason.get(reason) ?? [];
    if (samplesForReason.length >= CALL_PROOF_SUMMARY_SAMPLE_LIMIT) {
      continue;
    }
    samplesForReason.push({
      relPath: occurrence.relPath,
      range: occurrence.range,
      expectedText: truncateCallProofSampleText(
        matchedName ?? primaryExpectedName,
      ),
      actualText: truncateCallProofSampleText(actualText),
    });
    samplesByReason.set(reason, samplesForReason);
  }

  return samplesByReason;
}

export function collectCallProofCoverageSamples(
  coverageEntries: readonly {
    callProofUnavailableSamples?: readonly CallProofUnavailableReasonSampleFact[];
  }[],
): Map<CallProofUnavailableReasonCode, CallProofUnavailableSampleFact[]> {
  const samplesByReason = new Map<
    CallProofUnavailableReasonCode,
    CallProofUnavailableSampleFact[]
  >();
  for (const coverage of coverageEntries) {
    for (const sample of coverage.callProofUnavailableSamples ?? []) {
      const samples = samplesByReason.get(sample.code) ?? [];
      if (samples.length >= CALL_PROOF_SUMMARY_SAMPLE_LIMIT) continue;
      samples.push({
        relPath: sample.relPath,
        range: sample.range,
        expectedText: sample.expectedText,
        actualText: sample.actualText,
      });
      samplesByReason.set(sample.code, samples);
    }
  }
  return samplesByReason;
}

export function mergeCallProofSamples(
  left: ReadonlyMap<
    CallProofUnavailableReasonCode,
    readonly CallProofUnavailableSampleFact[]
  >,
  right: ReadonlyMap<
    CallProofUnavailableReasonCode,
    readonly CallProofUnavailableSampleFact[]
  >,
): Map<CallProofUnavailableReasonCode, CallProofUnavailableSampleFact[]> {
  const merged = new Map<
    CallProofUnavailableReasonCode,
    CallProofUnavailableSampleFact[]
  >();
  for (const [reason, samples] of [...left.entries(), ...right.entries()]) {
    const existing = merged.get(reason) ?? [];
    const existingKeys = new Set(existing.map(callProofSampleKey));
    for (const sample of samples) {
      if (existing.length >= CALL_PROOF_SUMMARY_SAMPLE_LIMIT) break;
      const key = callProofSampleKey(sample);
      if (existingKeys.has(key)) continue;
      existing.push(sample);
      existingKeys.add(key);
    }
    if (existing.length > 0) merged.set(reason, existing);
  }
  return merged;
}

function callProofSampleKey(sample: CallProofUnavailableSampleFact): string {
  return [
    normalizePath(sample.relPath),
    sample.range.startLine,
    sample.range.startCol,
    sample.range.endLine,
    sample.range.endCol,
    sample.expectedText,
    sample.actualText,
  ].join("\u0000");
}

function multiLineRangeSampleText(
  sourceLines: ReadonlyMap<number, string> | undefined,
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
): string | undefined {
  if (!sourceLines) return undefined;
  const fragments: string[] = [];
  for (
    let lineNumber = range.startLine;
    lineNumber <= range.endLine;
    lineNumber++
  ) {
    const sourceLine = sourceLines.get(lineNumber - 1);
    if (sourceLine === undefined) return undefined;
    if (lineNumber === range.startLine) {
      if (range.startCol > sourceLine.length) return undefined;
      fragments.push(sourceLine.slice(range.startCol));
      continue;
    }
    if (lineNumber === range.endLine) {
      if (range.endCol > sourceLine.length) return undefined;
      fragments.push(sourceLine.slice(0, range.endCol));
      continue;
    }
    fragments.push(sourceLine);
  }
  return truncateCallProofSampleText(fragments.join("\\n"));
}

function collectLocalImportAliasCandidates(params: {
  occurrences: readonly {
    relPath: string;
    symbolId?: string;
    providerSymbolId: string;
    range: {
      startLine: number;
      startCol: number;
      endLine: number;
      endCol: number;
    };
  }[];
  sourceLinesByPath: SourceLinesByPath;
  sourceTextCandidatesBySymbol: ReadonlyMap<string, readonly string[]>;
}): Map<string, Map<string, string[]>> {
  const candidatesByPathAndSymbol = new Map<string, Map<string, string[]>>();

  for (const occurrence of params.occurrences) {
    if (!occurrence.symbolId) continue;
    if (occurrence.range.startLine !== occurrence.range.endLine) continue;
    const sourceLines = params.sourceLinesByPath.get(occurrence.relPath);
    if (!sourceLines) continue;
    const sourceLine = sourceLines.get(occurrence.range.startLine - 1);
    if (!sourceLine || !sourceLine.includes(" as ")) continue;
    if (occurrence.range.endCol > sourceLine.length) continue;

    const sourceText = sourceLine.slice(
      occurrence.range.startCol,
      occurrence.range.endCol,
    );
    const globalCandidates =
      params.sourceTextCandidatesBySymbol.get(occurrence.providerSymbolId) ??
      [];

    const candidatesBySymbol =
      candidatesByPathAndSymbol.get(occurrence.relPath) ?? new Map();
    const candidates =
      candidatesBySymbol.get(occurrence.providerSymbolId) ?? [];
    for (const candidate of importAliasSourceTextCandidates(
      sourceLines,
      occurrence.range.startLine - 1,
      sourceText,
    )) {
      if (globalCandidates.includes(candidate)) continue;
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
    if (candidates.length === 0) continue;
    candidatesBySymbol.set(occurrence.providerSymbolId, candidates);
    candidatesByPathAndSymbol.set(occurrence.relPath, candidatesBySymbol);
  }

  return candidatesByPathAndSymbol;
}

function mergeSourceTextCandidates(
  globalCandidates: readonly string[] | undefined,
  localCandidates: readonly string[] | undefined,
): readonly string[] {
  const merged: string[] = [];
  for (const candidate of [
    ...(globalCandidates ?? []),
    ...(localCandidates ?? []),
  ]) {
    if (candidate.length === 0 || merged.includes(candidate)) continue;
    merged.push(candidate);
  }
  return merged;
}
