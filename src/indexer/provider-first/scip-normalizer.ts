import type { EdgeType, Range, RepoId, SymbolKind } from "../../domain/types.js";
import {
  extractNameFromDescriptors,
  extractPackageInfo,
  isClangStyleSymbolScheme,
  mapScipKind,
  normalizeDescriptorsForScipScheme,
  parseScipSymbol,
} from "../../scip/kind-mapping.js";
import {
  SCIP_ROLE_DEFINITION,
  SCIP_ROLE_IMPORT,
} from "../../scip/symbol-matcher.js";
import type {
  ScipDiagnostic,
  ScipDocument,
  ScipExternalSymbol,
  ScipOccurrence,
  ScipRange,
  ScipRelationship,
  ScipSymbolInfo,
} from "../../scip/types.js";
import { generateFileId } from "../../util/hashing.js";
import { normalizePath } from "../../util/paths.js";
import type {
  IndexProgress,
  IndexProgressSubstage,
} from "../indexer-init.js";
import {
  createProviderEdgeDedupeKey,
  createProviderOccurrenceId,
  createProviderSymbolId,
} from "./ids.js";
import {
  hasInvocationSuffix,
  isIdentifierText,
  isProvenClangLocationOnlyMacroReference,
  proveSourceOccurrenceCall,
} from "./source-call-proof.js";
import type {
  CallProofUnavailableReasonSampleFact,
  CallProofUnavailableReasonCode,
  CoverageLevel,
  DiagnosticFact,
  EdgeFact,
  ExternalSymbolFact,
  FileFact,
  OccurrenceFact,
  ProviderFactBase,
  ProviderFactSet,
  ProviderRunFact,
  SymbolFact,
} from "./types.js";

const IMPORT_ALIAS_BLOCK_SCAN_LIMIT = 80;
const CONTAINMENT_LINE_BUCKET_ENTRY_LIMIT = 200_000;
const CONTAINMENT_LINE_BLOCK_SIZE = 256;
const NORMALIZE_PROGRESS_INTERVAL = 250;
const NORMALIZE_PROGRESS_HEARTBEAT_MS = 2_000;
export const PROVIDER_FIRST_OCCURRENCE_FACT_RETENTION_LIMIT = 100_000;

export interface NormalizeScipProviderFactsOptions {
  repoId: RepoId;
  generationId: string;
  providerId: string;
  providerVersion?: string;
  documents: readonly ScipDocument[];
  externalSymbols?: readonly ScipExternalSymbol[];
  sourceLinesByPath?: SourceLinesByPath;
  sourceLineUnavailableReasonByPath?: SourceLineUnavailableReasonByPath;
  sourceTextByPath?: ReadonlyMap<string, string>;
  sourceIndexPath?: string;
  confidence?: number;
  emittedAt?: string;
  recordPhaseTiming?: (phaseName: string, durationMs: number) => void;
  retainOccurrenceFacts?: boolean;
  onProgress?: (progress: {
    stage: IndexProgress["stage"];
    current: number;
    total: number;
    substage?: IndexProgressSubstage;
    stageCurrent?: number;
    stageTotal?: number;
    message?: string;
  }) => void;
}

export type SourceLinesByPath = ReadonlyMap<
  string,
  ReadonlyMap<number, string>
>;
export type SourceLineUnavailableReasonByPath = ReadonlyMap<
  string,
  CallProofUnavailableReasonCode
>;
type SourceTextCandidateMap = ReadonlyMap<string, readonly string[]>;
type NeutralCallProofOccurrenceIndexes = ReadonlySet<number>;
interface CoverageOccurrence {
  role: OccurrenceFact["role"];
  symbolId?: string;
}

interface NormalizedScipContext {
  base: ProviderFactBase;
  confidence: number;
  sourceIndexPath?: string;
  symbolInfoRelPathsByProviderId: Map<string, ReadonlySet<string>>;
  symbolDefinitionRelPathsByProviderId: Map<string, ReadonlySet<string>>;
  symbolIdsByProviderId: Map<string, string>;
  unresolvedSymbolProviderIds: Set<string>;
  symbolSourceTextCandidatesByProviderId: Map<string, readonly string[]>;
  sourceLinesByPath: SourceLinesByPath;
  sourceLineUnavailableReasonByPath: SourceLineUnavailableReasonByPath;
}

interface ContainmentSymbol {
  providerSymbolId: string;
  symbolId: string;
  range: ScipRange;
  span: number;
}

interface ContainmentLookup {
  symbols: ContainmentSymbol[];
  symbolIdByRangeKey: ReadonlyMap<string, string>;
  symbolsByLine: ReadonlyMap<number, readonly ContainmentSymbol[]>;
  lineBucketsComplete: boolean;
  symbolsByBlock: ReadonlyMap<number, readonly ContainmentSymbol[]>;
  blockBucketsComplete: boolean;
}

export function normalizeScipProviderFacts(
  options: NormalizeScipProviderFactsOptions,
): ProviderFactSet {
  emitNormalizeProgress(options, 0, options.documents.length, "starting");
  const documents = measureNormalizePhase(options, "coalesce", () =>
    coalesceScipDocumentsByRelPath(options.documents),
  );
  emitNormalizeProgress(
    options,
    0,
    documents.length,
    `coalesced ${documents.length} document(s)`,
  );
  const emittedAt = options.emittedAt ?? new Date().toISOString();
  const base: ProviderFactBase = {
    repoId: options.repoId,
    generationId: options.generationId,
    providerType: "scip",
    providerId: options.providerId,
    providerVersion: options.providerVersion,
    emittedAt,
  };
  const context: NormalizedScipContext = {
    base,
    confidence: options.confidence ?? 0.95,
    ...(options.sourceIndexPath
      ? { sourceIndexPath: normalizePath(options.sourceIndexPath) }
      : {}),
    symbolInfoRelPathsByProviderId: measureNormalizePhase(
      options,
      "symbolInfoRelPaths",
      () => collectSymbolInfoRelPathsByProviderId(documents),
    ),
    symbolDefinitionRelPathsByProviderId: measureNormalizePhase(
      options,
      "symbolDefinitionRelPaths",
      () => collectSymbolDefinitionRelPathsByProviderId(documents),
    ),
    symbolIdsByProviderId: new Map(),
    unresolvedSymbolProviderIds: new Set(),
    symbolSourceTextCandidatesByProviderId: new Map(),
    sourceLinesByPath: normalizeSourceLinesByPath(options),
    sourceLineUnavailableReasonByPath:
      normalizeSourceLineUnavailableReasonByPath(options),
  };
  const facts: ProviderFactSet = {
    files: [],
    symbols: [],
    occurrences: [],
    edges: [],
    externalSymbols: [],
    diagnostics: [],
    coverage: [],
    providerRuns: [],
    sourceLinesByPath: context.sourceLinesByPath,
  };
  const emittedSymbolsByProviderId = new Map<string, SymbolFact>();
  const retainOccurrenceFacts = options.retainOccurrenceFacts ?? true;

  measureNormalizePhase(options, "symbols", () => {
    for (const document of documents) {
      const relPath = normalizePath(document.relativePath);
      const definitionOccurrencesBySymbol =
        collectDefinitionOccurrencesBySymbol(document);
      facts.files.push(fileFact(context, document, relPath));

      for (const info of document.symbols) {
        const symbolFact = symbolInfoToFact(
          context,
          info,
          relPath,
          definitionOccurrencesBySymbol,
        );
        if (!symbolFact) continue;
        const existingSymbol = emittedSymbolsByProviderId.get(
          symbolFact.providerSymbolId,
        );
        if (
          existingSymbol &&
          canCoalesceProviderSymbolFacts(existingSymbol, symbolFact)
        ) {
          context.symbolIdsByProviderId.set(
            info.symbol,
            existingSymbol.symbolId,
          );
          continue;
        }
        context.symbolIdsByProviderId.set(info.symbol, symbolFact.symbolId);
        if (symbolFact.symbolStatus === "unresolved") {
          context.unresolvedSymbolProviderIds.add(info.symbol);
        }
        context.symbolSourceTextCandidatesByProviderId.set(
          info.symbol,
          sourceTextCandidatesForScipSymbol(info.symbol, symbolFact.name),
        );
        emittedSymbolsByProviderId.set(symbolFact.providerSymbolId, symbolFact);
        facts.symbols.push(symbolFact);
      }
    }
  });

  measureNormalizePhase(options, "externalSymbols", () => {
    for (const externalSymbol of options.externalSymbols ?? []) {
      const externalFact = externalSymbolToFact(context, externalSymbol);
      if (!externalFact) continue;
      context.symbolIdsByProviderId.set(
        externalSymbol.symbol,
        externalFact.symbolId,
      );
      context.symbolSourceTextCandidatesByProviderId.set(
        externalSymbol.symbol,
        sourceTextCandidatesForScipSymbol(
          externalSymbol.symbol,
          externalFact.name,
        ),
      );
      facts.externalSymbols.push(externalFact);
    }
  });

  const edgeKeys = new Set<string>();
  let normalizedDocuments = 0;
  let lastProgressAt = 0;
  for (const document of documents) {
    const relPath = normalizePath(document.relativePath);
    const sourceLines = context.sourceLinesByPath.get(relPath);
    const definitionOccurrencesBySymbol =
      collectDefinitionOccurrencesBySymbol(document);
    const localSourceTextCandidates = buildLocalSourceTextCandidates(
      context,
      document,
      sourceLines,
    );
    const neutralCallProofOccurrenceIndexes =
      buildMacroExpansionOverlapOccurrenceIndexes(
        context,
        document,
        sourceLines,
        localSourceTextCandidates,
      );
    const documentOccurrences = measureNormalizePhase(
      options,
      "occurrenceFacts",
      () =>
        retainOccurrenceFacts
          ? document.occurrences.map((occurrence, index) =>
              occurrenceToFact(context, occurrence, relPath, index),
            )
          : document.occurrences.map((occurrence) =>
              occurrenceToCoverageOccurrence(context, occurrence),
            ),
    );
    if (retainOccurrenceFacts) {
      appendMany(facts.occurrences, documentOccurrences as OccurrenceFact[]);
    }
    measureNormalizePhase(options, "diagnostics", () => {
      for (const [occurrenceIndex, occurrence] of document.occurrences.entries()) {
        for (const [
          diagnosticIndex,
          diagnostic,
        ] of occurrence.diagnostics.entries()) {
          facts.diagnostics.push(
            diagnosticToFact(
              context,
              diagnostic,
              relPath,
              occurrenceIndex,
              diagnosticIndex,
            ),
          );
        }
      }
    });
    facts.coverage.push(
      measureNormalizePhase(options, "coverage", () =>
        coverageFact(
          context,
          document,
          relPath,
          documentOccurrences,
          sourceLines,
          localSourceTextCandidates,
          neutralCallProofOccurrenceIndexes,
        ),
      ),
    );
    appendMany(
      facts.edges,
      measureNormalizePhase(options, "relationshipEdges", () =>
        relationshipEdges(context, document, edgeKeys),
      ),
    );
    appendMany(
      facts.edges,
      measureNormalizePhase(options, "occurrenceEdges", () =>
        occurrenceEdges(
          context,
          document,
          edgeKeys,
          sourceLines,
          localSourceTextCandidates,
          neutralCallProofOccurrenceIndexes,
          definitionOccurrencesBySymbol,
        ),
      ),
    );
    normalizedDocuments++;
    const now = Date.now();
    if (
      normalizedDocuments === 1 ||
      normalizedDocuments === documents.length ||
      normalizedDocuments % NORMALIZE_PROGRESS_INTERVAL === 0 ||
      now - lastProgressAt >= NORMALIZE_PROGRESS_HEARTBEAT_MS
    ) {
      lastProgressAt = now;
      emitNormalizeProgress(
        options,
        normalizedDocuments,
        documents.length,
        `normalized ${normalizedDocuments}/${documents.length} document(s)`,
      );
    }
  }

  facts.providerRuns.push(providerRunFact(options, base, facts));
  emitNormalizeProgress(
    options,
    documents.length,
    documents.length,
    `normalized files=${facts.files.length} symbols=${facts.symbols.length} edges=${facts.edges.length}`,
  );
  return facts;
}

function emitNormalizeProgress(
  options: NormalizeScipProviderFactsOptions,
  current: number,
  total: number,
  message: string,
): void {
  options.onProgress?.({
    stage: "providerFirst",
    current,
    total,
    substage: "providerCollection.normalize",
    stageCurrent: current,
    stageTotal: total,
    message,
  });
}

function measureNormalizePhase<T>(
  options: Pick<NormalizeScipProviderFactsOptions, "recordPhaseTiming">,
  phaseName: string,
  fn: () => T,
): T {
  if (!options.recordPhaseTiming) return fn();
  const startedAt = Date.now();
  try {
    return fn();
  } finally {
    options.recordPhaseTiming(
      `providerCollection.normalize.${phaseName}`,
      Date.now() - startedAt,
    );
  }
}

function coalesceScipDocumentsByRelPath(
  documents: readonly ScipDocument[],
): ScipDocument[] {
  const documentsByPath = new Map<string, ScipDocument>();
  const relPathOrder: string[] = [];

  for (const document of documents) {
    if (!isSourceBackedScipDocument(document)) continue;
    const relPath = normalizePath(document.relativePath);
    const existing = documentsByPath.get(relPath);
    if (!existing) {
      relPathOrder.push(relPath);
      documentsByPath.set(relPath, {
        language: document.language,
        relativePath: relPath,
        occurrences: dedupeScipOccurrences(document.occurrences),
        symbols: mergeScipSymbolInfos([], document.symbols),
      });
      continue;
    }

    documentsByPath.set(relPath, mergeScipDocuments(existing, document, relPath));
  }

  const coalesced: ScipDocument[] = [];
  for (const relPath of relPathOrder) {
    const document = documentsByPath.get(relPath);
    if (document) coalesced.push(document);
  }
  return coalesced;
}

function isSourceBackedScipDocument(document: ScipDocument): boolean {
  const relPath = normalizePath(document.relativePath);
  return relPath !== "" && relPath !== ".";
}

function mergeScipDocuments(
  existing: ScipDocument,
  next: ScipDocument,
  relPath: string,
): ScipDocument {
  return {
    language: existing.language || next.language,
    relativePath: relPath,
    occurrences: dedupeScipOccurrences([
      ...existing.occurrences,
      ...next.occurrences,
    ]),
    symbols: mergeScipSymbolInfos(existing.symbols, next.symbols),
  };
}

function dedupeScipOccurrences(
  occurrences: readonly ScipOccurrence[],
): ScipOccurrence[] {
  const seen = new Set<string>();
  const deduped: ScipOccurrence[] = [];
  for (const occurrence of occurrences) {
    const key = scipOccurrenceKey(occurrence);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(occurrence);
  }
  return deduped;
}

function mergeScipSymbolInfos(
  existing: readonly ScipSymbolInfo[],
  next: readonly ScipSymbolInfo[],
): ScipSymbolInfo[] {
  const merged = existing.map((info) => ({ ...info }));
  const indexBySymbol = new Map(
    merged.map((info, index) => [info.symbol, index]),
  );

  for (const info of next) {
    const existingIndex = indexBySymbol.get(info.symbol);
    if (existingIndex === undefined) {
      indexBySymbol.set(info.symbol, merged.length);
      merged.push({ ...info });
      continue;
    }
    const existingInfo = merged[existingIndex];
    if (!existingInfo) continue;
    merged[existingIndex] = mergeScipSymbolInfo(existingInfo, info);
  }
  return merged;
}

function mergeScipSymbolInfo(
  existing: ScipSymbolInfo,
  next: ScipSymbolInfo,
): ScipSymbolInfo {
  return {
    symbol: existing.symbol,
    documentation: uniqueStrings([
      ...existing.documentation,
      ...next.documentation,
    ]),
    relationships: dedupeScipRelationships([
      ...existing.relationships,
      ...next.relationships,
    ]),
    kind: existing.kind,
    displayName: existing.displayName || next.displayName,
    signatureDocumentation:
      existing.signatureDocumentation || next.signatureDocumentation,
    enclosingSymbol: existing.enclosingSymbol || next.enclosingSymbol,
  };
}

function dedupeScipRelationships(
  relationships: readonly ScipRelationship[],
): ScipRelationship[] {
  const seen = new Set<string>();
  const deduped: ScipRelationship[] = [];
  for (const relationship of relationships) {
    const key = scipRelationshipKey(relationship);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(relationship);
  }
  return deduped;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function scipOccurrenceKey(occurrence: ScipOccurrence): string {
  return [
    occurrence.symbol,
    occurrence.symbolRoles,
    occurrence.syntaxKind,
    scipRangeKey(occurrence.range),
    occurrence.enclosingRange ? scipRangeKey(occurrence.enclosingRange) : "",
    occurrence.overrideDocumentation.join("\u001e"),
    occurrence.diagnostics.map(scipDiagnosticKey).join("\u001e"),
  ].join("\u001f");
}

function scipDiagnosticKey(diagnostic: ScipDiagnostic): string {
  return [
    diagnostic.severity,
    diagnostic.code,
    diagnostic.source,
    diagnostic.message,
    diagnostic.range ? scipRangeKey(diagnostic.range) : "",
  ].join("\u001e");
}

function scipRelationshipKey(relationship: ScipRelationship): string {
  return [
    relationship.symbol,
    relationship.isReference ? "1" : "0",
    relationship.isImplementation ? "1" : "0",
    relationship.isTypeDefinition ? "1" : "0",
    relationship.isDefinition ? "1" : "0",
  ].join("\u001e");
}

function scipRangeKey(range: ScipRange): string {
  return [
    range.startLine,
    range.startCol,
    range.endLine,
    range.endCol,
  ].join(":");
}

function fileFact(
  context: NormalizedScipContext,
  document: ScipDocument,
  relPath: string,
): FileFact {
  return {
    ...context.base,
    kind: "file",
    fileId: generateFileId(context.base.repoId, relPath),
    relPath,
    languageId: document.language,
  };
}

function symbolInfoToFact(
  context: NormalizedScipContext,
  info: ScipSymbolInfo,
  relPath: string,
  definitionOccurrencesBySymbol: ReadonlyMap<string, ScipOccurrence>,
): SymbolFact | null {
  const kind = mapScipKind(info.symbol, info.kind);
  if (kind.skip) return null;
  if (
    !shouldMaterializeSymbolInfo(
      context,
      info.symbol,
      relPath,
      kind.sdlKind,
    )
  ) {
    return null;
  }

  const definitionRange = findDefinitionRange(
    definitionOccurrencesBySymbol,
    info.symbol,
  );
  const symbolId = createProviderSymbolId({
    repoId: context.base.repoId,
    providerType: "scip",
    providerId: context.base.providerId,
    providerVersion: context.base.providerVersion,
    providerSymbolId: info.symbol,
    sourcePath: relPath,
    range: definitionRange,
  });

  return {
    ...context.base,
    kind: "symbol",
    symbolId,
    providerSymbolId: info.symbol,
    name: displayName(info),
    symbolKind: kind.sdlKind,
    relPath,
    range: definitionRange,
    signature: info.signatureDocumentation,
    documentation: info.documentation,
    external: false,
    ...(definitionRange
      ? { symbolStatus: "real" as const }
      : {
          // Metadata-only local symbols can still be useful as relationship
          // endpoints, but they cannot safely back code windows.
          symbolStatus: "unresolved" as const,
          placeholderKind: "provider-metadata",
          placeholderTarget: info.symbol,
        }),
  };
}

function externalSymbolToFact(
  context: NormalizedScipContext,
  info: ScipExternalSymbol,
): ExternalSymbolFact | null {
  const kind = mapScipKind(info.symbol, info.kind);
  const parsed = extractPackageInfo(info.symbol);
  const symbolId = createProviderSymbolId({
    repoId: context.base.repoId,
    providerType: "scip",
    providerId: context.base.providerId,
    providerVersion: context.base.providerVersion,
    providerSymbolId: info.symbol,
  });

  return {
    ...context.base,
    kind: "externalSymbol",
    symbolId,
    providerSymbolId: info.symbol,
    name: displayName(info),
    symbolKind: kind.skip ? undefined : kind.sdlKind,
    packageName: parsed.packageName || undefined,
    packageVersion: parsed.packageVersion || undefined,
    documentation: info.documentation,
  };
}

function canCoalesceProviderSymbolFacts(
  existing: SymbolFact,
  next: SymbolFact,
): boolean {
  return (
    existing.providerSymbolId === next.providerSymbolId &&
    canCoalesceDuplicateProviderSymbol(
      existing.providerSymbolId,
      existing.symbolKind,
    ) &&
    canCoalesceDuplicateProviderSymbol(next.providerSymbolId, next.symbolKind) &&
    existing.name === next.name
  );
}

function collectSymbolInfoRelPathsByProviderId(
  documents: readonly ScipDocument[],
): Map<string, ReadonlySet<string>> {
  const relPathsByProviderId = new Map<string, Set<string>>();
  for (const document of documents) {
    const relPath = normalizePath(document.relativePath);
    for (const info of document.symbols) {
      const relPaths = relPathsByProviderId.get(info.symbol) ?? new Set();
      relPaths.add(relPath);
      relPathsByProviderId.set(info.symbol, relPaths);
    }
  }
  return relPathsByProviderId;
}

function collectSymbolDefinitionRelPathsByProviderId(
  documents: readonly ScipDocument[],
): Map<string, ReadonlySet<string>> {
  const relPathsByProviderId = new Map<string, Set<string>>();
  for (const document of documents) {
    const relPath = normalizePath(document.relativePath);
    for (const occurrence of document.occurrences) {
      if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) === 0) continue;
      const relPaths = relPathsByProviderId.get(occurrence.symbol) ?? new Set();
      relPaths.add(relPath);
      relPathsByProviderId.set(occurrence.symbol, relPaths);
    }
  }
  return relPathsByProviderId;
}

function shouldMaterializeSymbolInfo(
  context: NormalizedScipContext,
  providerSymbolId: string,
  relPath: string,
  symbolKind: SymbolKind,
): boolean {
  const definitionRelPaths =
    context.symbolDefinitionRelPathsByProviderId.get(providerSymbolId);
  if (definitionRelPaths && definitionRelPaths.size > 0) {
    if (
      definitionRelPaths.size > 1 &&
      !canCoalesceDuplicateProviderSymbol(providerSymbolId, symbolKind)
    ) {
      return false;
    }
    // Some providers repeat SymbolInformation metadata in documents that only
    // reference the symbol. Emit the symbol from definition-bearing documents
    // so true cross-file definition collisions still reach validation.
    return definitionRelPaths.has(relPath);
  }

  const infoRelPaths =
    context.symbolInfoRelPathsByProviderId.get(providerSymbolId);
  return infoRelPaths === undefined || infoRelPaths.size <= 1;
}

function canCoalesceDuplicateProviderSymbol(
  providerSymbolId: string,
  symbolKind: SymbolKind | undefined,
): boolean {
  return symbolKind === "module" && providerSymbolId.endsWith("/");
}

function occurrenceToFact(
  context: NormalizedScipContext,
  occurrence: ScipOccurrence,
  relPath: string,
  occurrenceIndex: number,
): OccurrenceFact {
  const role = occurrenceRole(occurrence);
  return {
    ...context.base,
    kind: "occurrence",
    occurrenceId: createProviderOccurrenceId({
      repoId: context.base.repoId,
      providerType: "scip",
      providerId: context.base.providerId,
      providerVersion: context.base.providerVersion,
      providerSymbolId: occurrence.symbol,
      sourcePath: `${relPath}:${occurrenceIndex}`,
      range: scipRangeToRange(occurrence.range),
      occurrenceRange: scipRangeToRange(occurrence.range),
      occurrenceRole: role,
    }),
    providerSymbolId: occurrence.symbol,
    symbolId: context.symbolIdsByProviderId.get(occurrence.symbol),
    relPath,
    range: scipRangeToRange(occurrence.range),
    role,
  };
}

function occurrenceToCoverageOccurrence(
  context: NormalizedScipContext,
  occurrence: ScipOccurrence,
): CoverageOccurrence {
  return {
    symbolId: context.symbolIdsByProviderId.get(occurrence.symbol),
    role: occurrenceRole(occurrence),
  };
}

function diagnosticToFact(
  context: NormalizedScipContext,
  diagnostic: ScipDiagnostic,
  relPath: string,
  occurrenceIndex: number,
  diagnosticIndex: number,
): DiagnosticFact {
  return {
    ...context.base,
    kind: "diagnostic",
    diagnosticId: [
      context.base.generationId,
      relPath,
      occurrenceIndex,
      diagnosticIndex,
    ].join(":"),
    relPath,
    message: diagnostic.message,
    severity: diagnosticSeverity(diagnostic.severity),
    code: diagnostic.code || undefined,
    range: diagnostic.range ? scipRangeToRange(diagnostic.range) : undefined,
  };
}

function coverageFact(
  context: NormalizedScipContext,
  document: ScipDocument,
  relPath: string,
  occurrences: readonly CoverageOccurrence[],
  sourceLines: ReadonlyMap<number, string> | undefined,
  localSourceTextCandidates: SourceTextCandidateMap,
  neutralCallProofOccurrenceIndexes: NeutralCallProofOccurrenceIndexes,
): ProviderFactSet["coverage"][number] {
  const emittedSymbols = document.symbols.filter((info) =>
    isRealProviderSymbol(context, info.symbol),
  ).length;
  const skippedSymbolReasons = collectSkippedSymbolReasons(context, document);
  const unresolvedOccurrences = occurrences.filter(
    (occurrence) => occurrence.symbolId === undefined,
  ).length;
  const callProof = callProofCoverage(
    context,
    document,
    relPath,
    occurrences,
    sourceLines,
    localSourceTextCandidates,
    neutralCallProofOccurrenceIndexes,
  );
  const symbolCoverage = coverageLevel(document.symbols.length, emittedSymbols);
  const referenceCoverage = coverageLevel(
    occurrences.length,
    occurrences.length - unresolvedOccurrences,
  );
  const diagnosticCount = document.occurrences.reduce(
    (count, occurrence) => count + occurrence.diagnostics.length,
    0,
  );

  return {
    ...context.base,
    kind: "coverage",
    relPath,
    symbolCoverage,
    referenceCoverage,
    callProofCoverage: coverageLevel(
      callProof.totalResolvedReferences,
      callProof.provenReferences,
    ),
    diagnosticCoverage: diagnosticCount > 0 ? "full" : "none",
    totalSymbols: document.symbols.length,
    emittedSymbols,
    totalOccurrences: occurrences.length,
    unresolvedOccurrences,
    totalResolvedReferences: callProof.totalResolvedReferences,
    callProofUnavailableReferences:
      callProof.totalResolvedReferences - callProof.provenReferences,
    callProofUnavailableReasons: callProof.unavailableReasons,
    callProofUnavailableSamples:
      callProof.unavailableSamples.length > 0
        ? callProof.unavailableSamples
        : undefined,
    skippedSymbolReasons:
      skippedSymbolReasons.length > 0 ? skippedSymbolReasons : undefined,
    legacyFallback: legacyFallback(symbolCoverage, referenceCoverage),
  };
}

function collectSkippedSymbolReasons(
  context: NormalizedScipContext,
  document: ScipDocument,
): NonNullable<ProviderFactSet["coverage"][number]["skippedSymbolReasons"]> {
  const reasonCounts = new Map<string, number>();

  for (const info of document.symbols) {
    if (isRealProviderSymbol(context, info.symbol)) continue;
    const kind = mapScipKind(info.symbol, info.kind);
    const reason = skippedSymbolReason(context, info.symbol, kind);
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  return [...reasonCounts.entries()]
    .map(([reason, symbols]) => ({ reason, symbols }))
    .sort((left, right) => {
      if (right.symbols !== left.symbols) {
        return right.symbols - left.symbols;
      }
      return left.reason.localeCompare(right.reason);
    });
}

function isRealProviderSymbol(
  context: NormalizedScipContext,
  providerSymbolId: string,
): boolean {
  return (
    context.symbolIdsByProviderId.has(providerSymbolId) &&
    !context.unresolvedSymbolProviderIds.has(providerSymbolId)
  );
}

function skippedSymbolReason(
  context: NormalizedScipContext,
  providerSymbolId: string,
  kind: ReturnType<typeof mapScipKind>,
): string {
  if (kind.skip) return kind.reason;
  const definitionRelPaths =
    context.symbolDefinitionRelPathsByProviderId.get(providerSymbolId);
  if (
    definitionRelPaths &&
    definitionRelPaths.size > 1 &&
    !canCoalesceDuplicateProviderSymbol(providerSymbolId, kind.sdlKind)
  ) {
    return "ambiguous provider symbol";
  }
  if (!definitionRelPaths || definitionRelPaths.size === 0) {
    return "missing definition occurrence";
  }
  return "not materialized";
}

function relationshipEdges(
  context: NormalizedScipContext,
  document: ScipDocument,
  edgeKeys: Set<string>,
): EdgeFact[] {
  const edges: EdgeFact[] = [];
  const relPath = normalizePath(document.relativePath);
  for (const info of document.symbols) {
    const sourceSymbolId = context.symbolIdsByProviderId.get(info.symbol);
    if (!sourceSymbolId) continue;

    for (const relationship of info.relationships) {
      const targetSymbolId = context.symbolIdsByProviderId.get(
        relationship.symbol,
      );
      if (!targetSymbolId || sourceSymbolId === targetSymbolId) continue;

      const edgeType = relationshipEdgeType(relationship);
      if (!edgeType) continue;
      const dedupeKey = createProviderEdgeDedupeKey({
        sourceSymbolId,
        targetSymbolId,
        edgeType,
        providerId: context.base.providerId,
      });
      if (edgeKeys.has(dedupeKey)) continue;
      edgeKeys.add(dedupeKey);
      edges.push({
        ...context.base,
        kind: "edge",
        sourceSymbolId,
        targetSymbolId,
        edgeType,
        resolution: "exact",
        confidence: context.confidence,
        dedupeKey,
        relPath,
        ...(context.sourceIndexPath
          ? { sourceIndexPath: context.sourceIndexPath }
          : {}),
      });
    }
  }
  return edges;
}

function occurrenceEdges(
  context: NormalizedScipContext,
  document: ScipDocument,
  edgeKeys: Set<string>,
  sourceLines: ReadonlyMap<number, string> | undefined,
  localSourceTextCandidates: SourceTextCandidateMap,
  neutralCallProofOccurrenceIndexes: NeutralCallProofOccurrenceIndexes,
  definitionOccurrencesBySymbol: ReadonlyMap<string, ScipOccurrence>,
): EdgeFact[] {
  const edges: EdgeFact[] = [];
  const relPath = normalizePath(document.relativePath);
  const containmentLookup = buildContainmentSymbols(
    context,
    document,
    definitionOccurrencesBySymbol,
  );
  const implementationSymbols = getImplementationSymbols(document);

  for (const [occurrenceIndex, occurrence] of document.occurrences.entries()) {
    if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) !== 0) continue;

    const sourceSymbolId = findContainingProviderSymbol(
      occurrence,
      containmentLookup,
    );
    const targetSymbolId = context.symbolIdsByProviderId.get(occurrence.symbol);
    if (!sourceSymbolId || !targetSymbolId || sourceSymbolId === targetSymbolId) {
      continue;
    }

    const edgeType = occurrenceEdgeType(
      context,
      relPath,
      occurrence,
      implementationSymbols,
      sourceLines,
      localSourceTextCandidates,
      neutralCallProofOccurrenceIndexes.has(occurrenceIndex),
    );
    if (!edgeType) continue;
    const dedupeKey = createProviderEdgeDedupeKey({
      sourceSymbolId,
      targetSymbolId,
      edgeType,
      providerId: context.base.providerId,
    });
    if (edgeKeys.has(dedupeKey)) continue;
    edgeKeys.add(dedupeKey);
    edges.push({
      ...context.base,
      kind: "edge",
      sourceSymbolId,
      targetSymbolId,
      edgeType,
      resolution: "exact",
      confidence: context.confidence,
      dedupeKey,
      relPath,
      ...(context.sourceIndexPath
        ? { sourceIndexPath: context.sourceIndexPath }
        : {}),
    });
  }

  return edges;
}

function providerRunFact(
  options: NormalizeScipProviderFactsOptions,
  base: ProviderFactBase,
  facts: ProviderFactSet,
): ProviderRunFact {
  return {
    ...base,
    kind: "providerRun",
    runId: `${base.generationId}:${base.providerId}`,
    status: "succeeded",
    startedAt: base.emittedAt,
    finishedAt: base.emittedAt,
    sourceIndexPath: options.sourceIndexPath,
    fileCount: facts.files.length,
    symbolCount: facts.symbols.length,
    edgeCount: facts.edges.length,
    diagnosticCount: facts.diagnostics.length,
  };
}

function findDefinitionRange(
  definitionsBySymbol: ReadonlyMap<string, ScipOccurrence>,
  symbol: string,
): Range | undefined {
  const definition = definitionsBySymbol.get(symbol);
  return definition
    ? scipRangeToRange(definition.enclosingRange ?? definition.range)
    : undefined;
}

function collectDefinitionOccurrencesBySymbol(
  document: ScipDocument,
): Map<string, ScipOccurrence> {
  const definitionsBySymbol = new Map<string, ScipOccurrence>();
  for (const occurrence of document.occurrences) {
    if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) === 0) continue;
    if (definitionsBySymbol.has(occurrence.symbol)) continue;
    definitionsBySymbol.set(occurrence.symbol, occurrence);
  }
  return definitionsBySymbol;
}

function displayName(info: { symbol: string; displayName: string }): string {
  if (info.displayName.length > 0) return info.displayName;
  const parsed = parseScipSymbol(info.symbol);
  const descriptors = normalizedDescriptorsForSymbol(
    parsed.scheme,
    parsed.descriptors,
  );
  return extractNameFromDescriptors(descriptors) || info.symbol;
}

export function sourceTextCandidatesForScipSymbol(
  providerSymbolId: string,
  displayNameText: string,
): readonly string[] {
  const candidates: string[] = [];
  const addCandidate = (candidate: string): void => {
    if (candidate.length === 0 || candidates.includes(candidate)) return;
    candidates.push(candidate);
  };

  const parsed = parseScipSymbol(providerSymbolId);
  const descriptors = normalizedDescriptorsForSymbol(
    parsed.scheme,
    parsed.descriptors,
  );
  const descriptorName = extractNameFromDescriptors(descriptors);
  const displayNameWithoutBackticks = stripBalancedBacktickName(displayNameText);
  const descriptorNameWithoutBackticks = stripBalancedBacktickName(descriptorName);
  addCandidate(extractColonScopedMemberName(displayNameText));
  addCandidate(extractColonScopedMemberName(descriptorName));
  addCandidate(
    extractColonScopedMemberName(stripDescriptorTerminator(descriptors)),
  );
  addCandidate(displayNameWithoutBackticks);
  addCandidate(descriptorNameWithoutBackticks);
  addCandidate(stripCppTrailingTemplateArguments(displayNameText));
  addCandidate(stripCppTrailingTemplateArguments(descriptorName));
  addCandidate(stripCppTrailingTemplateArguments(displayNameWithoutBackticks));
  addCandidate(stripCppTrailingTemplateArguments(descriptorNameWithoutBackticks));
  if (isClangStyleSymbolScheme(parsed.scheme)) {
    addCandidate(extractDotScopedMemberName(displayNameText));
    addCandidate(extractDotScopedMemberName(descriptorName));
    addCandidate(extractDotScopedMemberName(stripDescriptorTerminator(descriptors)));
  }
  addCandidate(extractInvocationOwnerMemberName(displayNameText));
  addCandidate(extractInvocationOwnerMemberName(descriptorName));
  addCandidate(
    extractInvocationOwnerMemberName(stripDescriptorTerminator(descriptors)),
  );
  if (
    isConstructorSymbolName(displayNameText) ||
    isConstructorSymbolName(descriptorName)
  ) {
    addCandidate(extractConstructorOwnerNameFromDescriptors(descriptors));
  }
  addCandidate(displayNameText);
  addCandidate(descriptorName);
  return candidates;
}

function stripBalancedBacktickName(name: string): string {
  if (!name.startsWith("`") || !name.endsWith("`")) return "";
  if (name.slice(1, -1).includes("`")) return "";
  return name.slice(1, -1);
}

function stripCppTrailingTemplateArguments(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.endsWith(">")) return "";

  let depth = 0;
  for (let index = trimmed.length - 1; index >= 0; index--) {
    const char = trimmed[index] ?? "";
    if (char === ">") {
      depth++;
      continue;
    }
    if (char === "<") {
      depth--;
      if (depth === 0) {
        return trimmed.slice(0, index).trimEnd();
      }
      if (depth < 0) return "";
    }
  }
  return "";
}

function normalizedDescriptorsForSymbol(
  scheme: string,
  descriptors: string,
): string {
  return normalizeDescriptorsForScipScheme(scheme, descriptors);
}

function extractInvocationOwnerMemberName(name: string): string {
  const stripped = stripDescriptorTerminator(name);
  const memberSeparatorIndex = stripped.lastIndexOf(".");
  if (memberSeparatorIndex === -1) return "";

  const owner = stripped.slice(0, memberSeparatorIndex);
  if (!owner.endsWith("()")) return "";

  const memberName = stripDescriptorTerminator(
    stripped.slice(memberSeparatorIndex + 1),
  );
  return isIdentifierText(memberName) ? memberName : "";
}

function extractColonScopedMemberName(name: string): string {
  const separatorIndex = name.lastIndexOf(":");
  if (separatorIndex === -1) return "";
  const memberName = stripDescriptorTerminator(name.slice(separatorIndex + 1));
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(memberName) ? memberName : "";
}

function extractDotScopedMemberName(name: string): string {
  const separatorIndex = name.lastIndexOf(".");
  if (separatorIndex === -1) return "";
  const memberName = stripDescriptorTerminator(name.slice(separatorIndex + 1));
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(memberName) ? memberName : "";
}

function isConstructorSymbolName(name: string): boolean {
  const normalized = name.replace(/`/g, "").toLowerCase();
  return normalized === "<constructor>" || normalized === "constructor";
}

function extractConstructorOwnerNameFromDescriptors(descriptors: string): string {
  const stripped = stripDescriptorTerminator(descriptors);
  const memberSeparatorIndex = stripped.lastIndexOf("#");
  if (memberSeparatorIndex === -1) return "";
  return extractNameFromDescriptors(stripped.slice(0, memberSeparatorIndex));
}

function stripDescriptorTerminator(descriptors: string): string {
  if (descriptors.endsWith("().")) return descriptors.slice(0, -3);
  const last = descriptors[descriptors.length - 1];
  return last === "#" ||
    last === "." ||
    last === "(" ||
    last === "[" ||
    last === ")" ||
    last === "!"
    ? descriptors.slice(0, -1)
    : descriptors;
}

function buildLocalSourceTextCandidates(
  context: NormalizedScipContext,
  document: ScipDocument,
  sourceLines: ReadonlyMap<number, string> | undefined,
): Map<string, string[]> {
  const candidatesBySymbol = new Map<string, string[]>();
  if (!sourceLines) return candidatesBySymbol;

  const addCandidate = (symbol: string, candidate: string): void => {
    if (!isIdentifierText(candidate)) return;
    const globalCandidates =
      context.symbolSourceTextCandidatesByProviderId.get(symbol) ?? [];
    if (globalCandidates.includes(candidate)) return;
    const candidates = candidatesBySymbol.get(symbol) ?? [];
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
    candidatesBySymbol.set(symbol, candidates);
  };

  for (const occurrence of document.occurrences) {
    if (occurrence.range.startLine !== occurrence.range.endLine) continue;
    const line = sourceLines.get(occurrence.range.startLine);
    if (!line) continue;
    if (occurrence.range.endCol > line.length) continue;

    const cxxConstructorAlias = cxxConstructorAliasCandidateForOccurrence(
      document,
      occurrence,
      line,
    );
    if (cxxConstructorAlias) {
      addCandidate(occurrence.symbol, cxxConstructorAlias);
    }

    if (!line.includes(" as ")) continue;

    const sourceText = line.slice(
      occurrence.range.startCol,
      occurrence.range.endCol,
    );
    for (const candidate of importAliasClauseSourceTextCandidates(sourceText)) {
      addCandidate(occurrence.symbol, candidate);
    }
    if (!isIdentifierText(sourceText)) continue;

    for (const candidate of importAliasSourceTextCandidates(
      sourceLines,
      occurrence.range.startLine,
      sourceText,
    )) {
      addCandidate(occurrence.symbol, candidate);
    }
  }

  return candidatesBySymbol;
}

function cxxConstructorAliasCandidateForOccurrence(
  document: ScipDocument,
  occurrence: ScipOccurrence,
  line: string,
): string {
  const parsed = parseScipSymbol(occurrence.symbol);
  if (!isClangStyleSymbolScheme(parsed.scheme)) return "";
  const constructorName = cxxConstructorNameFromProviderSymbol(
    occurrence.symbol,
  );
  if (!constructorName) return "";
  const sourceText = line.slice(
    occurrence.range.startCol,
    occurrence.range.endCol,
  );
  if (!isIdentifierText(sourceText)) return "";
  if (!hasInvocationSuffix(line, occurrence.range.endCol)) return "";

  const sourceType = readCxxTypeBeforeDeclarator(
    line,
    occurrence.range.startCol,
  );
  if (!sourceType || sourceType === constructorName) return "";
  const providerScope = cxxTypeScopePrefixForSymbol(occurrence.symbol);
  if (!providerScope) return "";
  return hasScopedCxxTypeOccurrenceBeforeDeclarator(
    document,
    occurrence,
    line,
    sourceType,
    providerScope,
  )
    ? sourceType
    : "";
}

function hasScopedCxxTypeOccurrenceBeforeDeclarator(
  document: ScipDocument,
  constructorOccurrence: ScipOccurrence,
  line: string,
  sourceType: string,
  providerScope: string,
): boolean {
  for (const typeOccurrence of document.occurrences) {
    if (typeOccurrence === constructorOccurrence) continue;
    if (
      typeOccurrence.range.startLine !== constructorOccurrence.range.startLine ||
      typeOccurrence.range.endLine !== constructorOccurrence.range.startLine ||
      typeOccurrence.range.endCol > constructorOccurrence.range.startCol ||
      typeOccurrence.range.endCol > line.length
    ) {
      continue;
    }
    if (
      line.slice(typeOccurrence.range.startCol, typeOccurrence.range.endCol) !==
      sourceType
    ) {
      continue;
    }
    const parsed = parseScipSymbol(typeOccurrence.symbol);
    if (!isClangStyleSymbolScheme(parsed.scheme)) continue;
    if (
      extractNameFromDescriptors(
        normalizedDescriptorsForSymbol(parsed.scheme, parsed.descriptors),
      ) !== sourceType
    ) {
      continue;
    }
    if (cxxTypeScopePrefixForSymbol(typeOccurrence.symbol) !== providerScope) {
      continue;
    }
    return true;
  }
  return false;
}

function cxxConstructorNameFromProviderSymbol(providerSymbolId: string): string {
  const parsed = parseScipSymbol(providerSymbolId);
  if (!isClangStyleSymbolScheme(parsed.scheme)) return "";
  const descriptors = normalizedDescriptorsForSymbol(
    parsed.scheme,
    parsed.descriptors,
  );
  const hashIndex = descriptors.lastIndexOf("#");
  if (hashIndex === -1) return "";
  const parenIndex = descriptors.indexOf("(", hashIndex + 1);
  if (parenIndex === -1) return "";
  const constructorName = descriptors.slice(hashIndex + 1, parenIndex);
  if (!isIdentifierText(constructorName)) return "";
  return extractConstructorOwnerNameFromDescriptors(descriptors) ===
    constructorName
    ? constructorName
    : "";
}

function cxxTypeScopePrefixForSymbol(providerSymbolId: string): string {
  const parsed = parseScipSymbol(providerSymbolId);
  if (!isClangStyleSymbolScheme(parsed.scheme)) return "";
  const descriptors = normalizedDescriptorsForSymbol(
    parsed.scheme,
    parsed.descriptors,
  );
  const hashIndex = descriptors.lastIndexOf("#");
  const typeDescriptor =
    hashIndex === -1
      ? stripDescriptorTerminator(descriptors)
      : descriptors.slice(0, hashIndex);
  const slashIndex = typeDescriptor.lastIndexOf("/");
  if (slashIndex !== -1) return typeDescriptor.slice(0, slashIndex + 1);
  const dotIndex = typeDescriptor.lastIndexOf(".");
  return dotIndex === -1 ? "" : typeDescriptor.slice(0, dotIndex + 1);
}

function readCxxTypeBeforeDeclarator(line: string, tokenStart: number): string {
  let current = skipBackwardWhitespace(line, tokenStart);
  current = skipBackwardTemplateArguments(line, current);
  current = skipBackwardWhitespace(line, current);
  let start = current;
  while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1] ?? "")) start--;
  const candidate = line.slice(start, current);
  return isIdentifierText(candidate) ? candidate : "";
}

function skipBackwardWhitespace(text: string, offset: number): number {
  let current = offset;
  while (current > 0 && /\s/.test(text[current - 1] ?? "")) current--;
  return current;
}

function skipBackwardTemplateArguments(text: string, offset: number): number {
  let current = skipBackwardWhitespace(text, offset);
  if (text[current - 1] !== ">") return current;
  let depth = 0;
  for (let index = current - 1; index >= 0; index--) {
    const char = text[index];
    if (char === ">") {
      depth++;
      continue;
    }
    if (char === "<") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return current;
}

export function importAliasSourceTextCandidates(
  sourceLines: ReadonlyMap<number, string>,
  lineNumber: number,
  sourceText: string,
): readonly string[] {
  if (!isIdentifierText(sourceText)) return [];
  const candidates: string[] = [];
  if (isNamedImportAliasForToken(sourceLines, lineNumber, sourceText)) {
    candidates.push(sourceText);
  }
  const importedNameAlias = namedImportAliasForImportedToken(
    sourceLines,
    lineNumber,
    sourceText,
  );
  if (importedNameAlias && !candidates.includes(importedNameAlias)) {
    candidates.push(importedNameAlias);
  }
  return candidates;
}

function importAliasClauseSourceTextCandidates(
  sourceText: string,
): readonly string[] {
  const candidates: string[] = [];
  const match = /^\s*(?:type\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*,?\s*$/.exec(
    sourceText,
  );
  if (match?.[1]) {
    candidates.push(match[1]);
  }
  return candidates;
}

function isNamedImportAliasForToken(
  sourceLines: ReadonlyMap<number, string>,
  lineNumber: number,
  token: string,
): boolean {
  const block = collectNamedImportBlock(sourceLines, lineNumber);
  if (!block) return false;
  return new RegExp(
    `\\bas\\s+${escapeRegExp(token)}\\b`,
  ).test(block.text);
}

function namedImportAliasForImportedToken(
  sourceLines: ReadonlyMap<number, string>,
  lineNumber: number,
  importedToken: string,
): string {
  const block = collectNamedImportBlock(sourceLines, lineNumber);
  if (!block) return "";
  const match = new RegExp(
    `(?:^|[\\s,{])(?:type\\s+)?${escapeRegExp(importedToken)}\\s+as\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\b`,
  ).exec(block.text);
  return match?.[1] ?? "";
}

function collectNamedImportBlock(
  sourceLines: ReadonlyMap<number, string>,
  lineNumber: number,
): { text: string } | undefined {
  const startLine = findNamedImportBlockStart(sourceLines, lineNumber);
  if (startLine === undefined) return undefined;
  const endLine = findNamedImportBlockEnd(sourceLines, lineNumber);
  if (endLine === undefined || endLine < startLine) return undefined;

  const lines: string[] = [];
  for (let currentLine = startLine; currentLine <= endLine; currentLine++) {
    const line = sourceLines.get(currentLine);
    if (line === undefined) return undefined;
    lines.push(line);
  }
  return { text: lines.join("\n") };
}

function findNamedImportBlockStart(
  sourceLines: ReadonlyMap<number, string>,
  lineNumber: number,
): number | undefined {
  const lowerBound = Math.max(0, lineNumber - IMPORT_ALIAS_BLOCK_SCAN_LIMIT);
  for (let currentLine = lineNumber; currentLine >= lowerBound; currentLine--) {
    const line = sourceLines.get(currentLine);
    if (line === undefined) return undefined;
    if (/^\s*import\s+(?:type\s+)?\{/.test(line)) return currentLine;
    if (currentLine !== lineNumber && /;\s*$/.test(line)) break;
  }
  return undefined;
}

function findNamedImportBlockEnd(
  sourceLines: ReadonlyMap<number, string>,
  lineNumber: number,
): number | undefined {
  const upperBound = lineNumber + IMPORT_ALIAS_BLOCK_SCAN_LIMIT;
  for (let currentLine = lineNumber; currentLine <= upperBound; currentLine++) {
    const line = sourceLines.get(currentLine);
    if (line === undefined) return undefined;
    if (/}\s*from\s*["'][^"']+["']\s*;?\s*$/.test(line)) {
      return currentLine;
    }
    if (currentLine !== lineNumber && /^\s*import\s+/.test(line)) break;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function occurrenceRole(
  occurrence: ScipOccurrence,
): OccurrenceFact["role"] {
  if (occurrence.symbolRoles & SCIP_ROLE_DEFINITION) return "definition";
  if (occurrence.symbolRoles & SCIP_ROLE_IMPORT) return "import";
  return "reference";
}

function relationshipEdgeType(relationship: ScipRelationship): EdgeType | null {
  if (relationship.isImplementation || relationship.isTypeDefinition) {
    return "implements";
  }
  if (relationship.isDefinition) return "import";
  // SCIP relationships alone do not prove invocation semantics. Occurrence
  // facts plus source-line proof handle exact call edges separately.
  return null;
}

function occurrenceEdgeType(
  context: NormalizedScipContext,
  relPath: string,
  occurrence: ScipOccurrence,
  implementationSymbols: ReadonlySet<string>,
  sourceLines: ReadonlyMap<number, string> | undefined,
  localSourceTextCandidates: SourceTextCandidateMap,
  neutralCallProof: boolean,
): EdgeType | null {
  if (implementationSymbols.has(occurrence.symbol)) return "implements";
  if ((occurrence.symbolRoles & SCIP_ROLE_IMPORT) !== 0) return "import";
  if (neutralCallProof) return null;
  if (
    isCallLikeReference(
      context,
      relPath,
      occurrence,
      sourceLines,
      localSourceTextCandidates,
    )
  ) {
    return "call";
  }
  // A raw SCIP reference occurrence is not enough evidence for call semantics.
  // Keep broad references in occurrence facts unless source text proves the
  // identifier is immediately used as an invocation target.
  return null;
}

function isCallLikeReference(
  context: NormalizedScipContext,
  relPath: string,
  occurrence: ScipOccurrence,
  sourceLines: ReadonlyMap<number, string> | undefined,
  localSourceTextCandidates: SourceTextCandidateMap,
): boolean {
  const match = proveSourceOccurrenceCall({
    providerSymbolId: occurrence.symbol,
    expectedNames: mergeSourceTextCandidates(
      context.symbolSourceTextCandidatesByProviderId.get(occurrence.symbol),
      localSourceTextCandidates.get(occurrence.symbol),
    ),
    sourceUnavailableReason:
      context.sourceLineUnavailableReasonByPath.get(relPath),
    relPath,
    range: occurrence.range,
    sourceLines,
  });
  return match.matched;
}

function callProofCoverage(
  context: NormalizedScipContext,
  document: ScipDocument,
  relPath: string,
  occurrences: readonly CoverageOccurrence[],
  sourceLines: ReadonlyMap<number, string> | undefined,
  localSourceTextCandidates: SourceTextCandidateMap,
  neutralCallProofOccurrenceIndexes: NeutralCallProofOccurrenceIndexes,
): {
  totalResolvedReferences: number;
  provenReferences: number;
  unavailableReasons: Array<{
    code: CallProofUnavailableReasonCode;
    references: number;
  }>;
  unavailableSamples: CallProofUnavailableReasonSampleFact[];
} {
  let totalResolvedReferences = 0;
  let provenReferences = 0;
  const unavailableReasons = new Map<CallProofUnavailableReasonCode, number>();
  const unavailableSamples: CallProofUnavailableReasonSampleFact[] = [];

  for (const [index, occurrenceFact] of occurrences.entries()) {
    if (occurrenceFact.role !== "reference" || !occurrenceFact.symbolId) {
      continue;
    }
    const occurrence = document.occurrences[index];
    if (!occurrence) continue;
    if (neutralCallProofOccurrenceIndexes.has(index)) continue;

    const match = proveSourceOccurrenceCall({
      providerSymbolId: occurrence.symbol,
      expectedNames: mergeSourceTextCandidates(
        context.symbolSourceTextCandidatesByProviderId.get(occurrence.symbol),
        localSourceTextCandidates.get(occurrence.symbol),
      ),
      sourceUnavailableReason:
        context.sourceLineUnavailableReasonByPath.get(relPath),
      relPath,
      range: occurrence.range,
      sourceLines,
    });
    if (match.matched) {
      totalResolvedReferences++;
      provenReferences++;
    } else {
      if (match.callCandidate === false) continue;
      totalResolvedReferences++;
      unavailableReasons.set(
        match.reason,
        (unavailableReasons.get(match.reason) ?? 0) + 1,
      );
      if (match.sample && unavailableSamples.length < 5) {
        unavailableSamples.push({
          code: match.reason,
          ...match.sample,
        });
      }
    }
  }

  return {
    totalResolvedReferences,
    provenReferences,
    unavailableReasons: [...unavailableReasons.entries()].map(
      ([code, references]) => ({ code, references }),
    ),
    unavailableSamples,
  };
}

function buildMacroExpansionOverlapOccurrenceIndexes(
  context: NormalizedScipContext,
  document: ScipDocument,
  sourceLines: ReadonlyMap<number, string> | undefined,
  localSourceTextCandidates: SourceTextCandidateMap,
): NeutralCallProofOccurrenceIndexes {
  if (!sourceLines) return new Set();

  const indexesByRange = new Map<string, number[]>();
  const sourceTextByIndex = new Map<number, string>();
  const sourceProvenIndexes = new Set<number>();
  const directNeutralIndexes = new Set<number>();
  const operatorCallParenStarts = buildCxxOperatorCallParenStarts(
    document,
    sourceLines,
  );
  for (const [index, occurrence] of document.occurrences.entries()) {
    if (!isReferenceOccurrence(occurrence)) continue;
    if (
      !isClangStyleSymbolScheme(parseScipSymbol(occurrence.symbol).scheme)
    ) {
      continue;
    }
    if (occurrence.range.startLine !== occurrence.range.endLine) continue;

    const line = sourceLines.get(occurrence.range.startLine);
    if (!line || occurrence.range.endCol > line.length) continue;
    const sourceText = line.slice(
      occurrence.range.startCol,
      occurrence.range.endCol,
    );
    if (!isIdentifierText(sourceText)) continue;
    if (!hasCxxInvocationSuffix(line, occurrence.range.endCol)) continue;

    const materialized = context.symbolIdsByProviderId.has(occurrence.symbol);
    const expectedNames = materialized
      ? mergeSourceTextCandidates(
          context.symbolSourceTextCandidatesByProviderId.get(occurrence.symbol),
          localSourceTextCandidates.get(occurrence.symbol),
        )
      : [];
    const sourceProven =
      expectedNames.includes(sourceText) ||
      isProvenClangLocationOnlyMacroReference(
        occurrence.symbol,
        sourceText,
        line,
        occurrence.range.endCol,
      );
    if (!materialized && !sourceProven) continue;
    if (
      materialized &&
      !expectedNames.includes(sourceText) &&
      isNeutralCxxImplicitResultExpression(
        occurrence,
        line,
        sourceText,
        expectedNames,
        operatorCallParenStarts,
      )
    ) {
      directNeutralIndexes.add(index);
    }

    const rangeKey = scipRangeKey(occurrence.range);
    indexesByRange.set(rangeKey, [
      ...(indexesByRange.get(rangeKey) ?? []),
      index,
    ]);
    sourceTextByIndex.set(index, sourceText);
    if (sourceProven) {
      sourceProvenIndexes.add(index);
    }
  }

  const neutralIndexes = new Set<number>(directNeutralIndexes);
  for (const indexes of indexesByRange.values()) {
    if (indexes.length <= 1) continue;
    const hasSourceProvenIndex = indexes.some((index) =>
      sourceProvenIndexes.has(index),
    );
    for (const index of indexes) {
      if (sourceProvenIndexes.has(index)) continue;
      const occurrence = document.occurrences[index];
      const sourceText = sourceTextByIndex.get(index);
      if (!occurrence || !sourceText) continue;
      if (
        hasSourceProvenIndex &&
        context.symbolIdsByProviderId.has(occurrence.symbol)
      ) {
        neutralIndexes.add(index);
        continue;
      }
      const expectedNames = mergeSourceTextCandidates(
        context.symbolSourceTextCandidatesByProviderId.get(occurrence.symbol),
        localSourceTextCandidates.get(occurrence.symbol),
      );
      if (!expectedNames.includes(sourceText)) {
        neutralIndexes.add(index);
      }
    }
  }
  return neutralIndexes;
}

function isNeutralCxxImplicitResultExpression(
  occurrence: ScipOccurrence,
  line: string,
  sourceText: string,
  expectedNames: readonly string[],
  operatorCallParenStarts: ReadonlySet<string>,
): boolean {
  return (
    isCxxNamedCastExpressionToken(sourceText, line, occurrence.range.endCol) ||
    hasCxxOperatorCallOccurrenceAtInvocationParen(
      occurrence,
      line,
      operatorCallParenStarts,
    ) ||
    isCxxImplicitConstructorOverInvokedExpression(
      occurrence,
      line,
      sourceText,
      expectedNames,
    )
  );
}

function isCxxImplicitConstructorOverInvokedExpression(
  occurrence: ScipOccurrence,
  line: string,
  sourceText: string,
  expectedNames: readonly string[],
): boolean {
  if (!isIdentifierText(sourceText)) return false;
  if (!hasCxxInvocationSuffix(line, occurrence.range.endCol)) return false;
  if (!isCxxExpressionCallableContext(line, occurrence.range.startCol)) {
    return false;
  }

  const parsed = parseScipSymbol(occurrence.symbol);
  if (!isClangStyleSymbolScheme(parsed.scheme)) return false;
  return expectedNames.some(
    (expectedName) =>
      isIdentifierText(expectedName) &&
      sourceText !== expectedName &&
      parsed.descriptors.includes(`#${expectedName}(`),
  );
}

function isCxxExpressionCallableContext(line: string, startCol: number): boolean {
  const prefix = line.slice(0, startCol).trimEnd();
  if (prefix.length === 0) return true;
  if (/\breturn$/.test(prefix)) return true;

  const previous = prefix[prefix.length - 1] ?? "";
  if (previous === "," && isLikelySharedConstructorDeclaratorPrefix(prefix)) {
    return false;
  }
  return previous !== ":" && /^[,=([{!~+\-*/%&|^?;]$/.test(previous);
}

function isLikelySharedConstructorDeclaratorPrefix(prefix: string): boolean {
  const statementStart =
    Math.max(
      prefix.lastIndexOf(";"),
      prefix.lastIndexOf("{"),
      prefix.lastIndexOf("}"),
    ) + 1;
  const statementPrefix = prefix.slice(statementStart).trim();
  return /^(?:[A-Za-z_][A-Za-z0-9_:<>,*&~]*\s+)+[A-Za-z_][A-Za-z0-9_]*\s*\([^;{}]*\),?$/.test(
    statementPrefix,
  );
}

function isCxxNamedCastExpressionToken(
  sourceText: string,
  line: string,
  endCol: number,
): boolean {
  return (
    (sourceText === "static_cast" ||
      sourceText === "dynamic_cast" ||
      sourceText === "const_cast" ||
      sourceText === "reinterpret_cast") &&
    hasCxxInvocationSuffix(line, endCol)
  );
}

function buildCxxOperatorCallParenStarts(
  document: ScipDocument,
  sourceLines: ReadonlyMap<number, string>,
): ReadonlySet<string> {
  const starts = new Set<string>();
  for (const occurrence of document.occurrences) {
    if (!isReferenceOccurrence(occurrence)) continue;
    if (occurrence.range.startLine !== occurrence.range.endLine) continue;
    if (occurrence.range.endCol !== occurrence.range.startCol + 1) continue;
    const line = sourceLines.get(occurrence.range.startLine);
    if (!line) continue;
    if (line.slice(occurrence.range.startCol, occurrence.range.endCol) !== "(") {
      continue;
    }
    const parsed = parseScipSymbol(occurrence.symbol);
    if (
      isClangStyleSymbolScheme(parsed.scheme) &&
      parsed.descriptors.includes("`operator()`")
    ) {
      starts.add(
        cxxOperatorCallParenStartKey(
          occurrence.range.startLine,
          occurrence.range.startCol,
        ),
      );
    }
  }
  return starts;
}

function hasCxxOperatorCallOccurrenceAtInvocationParen(
  occurrence: ScipOccurrence,
  line: string,
  operatorCallParenStarts: ReadonlySet<string>,
): boolean {
  if (!hasInvocationSuffix(line, occurrence.range.endCol)) return false;
  return operatorCallParenStarts.has(
    cxxOperatorCallParenStartKey(
      occurrence.range.startLine,
      occurrence.range.endCol,
    ),
  );
}

function cxxOperatorCallParenStartKey(line: number, startCol: number): string {
  return `${line}:${startCol}`;
}

function hasCxxInvocationSuffix(line: string, endCol: number): boolean {
  const suffix = line.slice(endCol).trimStart();
  if (hasInvocationSuffix(line, endCol)) return true;
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

function isReferenceOccurrence(occurrence: ScipOccurrence): boolean {
  return (
    (occurrence.symbolRoles & SCIP_ROLE_DEFINITION) === 0 &&
    (occurrence.symbolRoles & SCIP_ROLE_IMPORT) === 0
  );
}

function getImplementationSymbols(document: ScipDocument): Set<string> {
  const implementationSymbols = new Set<string>();
  for (const info of document.symbols) {
    if (
      info.relationships.some(
        (relationship) =>
          relationship.isImplementation || relationship.isTypeDefinition,
      )
    ) {
      implementationSymbols.add(info.symbol);
    }
  }
  return implementationSymbols;
}

function buildContainmentSymbols(
  context: NormalizedScipContext,
  document: ScipDocument,
  definitionOccurrencesBySymbol: ReadonlyMap<string, ScipOccurrence>,
): ContainmentLookup {
  const symbols: ContainmentSymbol[] = [];
  const symbolIdByRangeKey = new Map<string, string>();
  for (const info of document.symbols) {
    const symbolId = context.symbolIdsByProviderId.get(info.symbol);
    if (!symbolId) continue;

    const definition = definitionOccurrencesBySymbol.get(info.symbol);
    if (!definition) continue;
    const range = definition.enclosingRange ?? definition.range;

    const symbol: ContainmentSymbol = {
      providerSymbolId: info.symbol,
      symbolId,
      range,
      span: rangeSpan(range),
    };
    symbols.push(symbol);
    const rangeKey = scipRangeKey(range);
    if (!symbolIdByRangeKey.has(rangeKey)) {
      symbolIdByRangeKey.set(rangeKey, symbolId);
    }
  }
  symbols.sort((left, right) => left.span - right.span);
  const lineIndex = buildContainmentSymbolsByLine(symbols);
  const blockIndex = lineIndex.complete
    ? {
        buckets: new Map<number, readonly ContainmentSymbol[]>(),
        complete: true,
      }
    : buildContainmentSymbolsByBlock(symbols);
  return {
    symbols,
    symbolIdByRangeKey,
    symbolsByLine: lineIndex.buckets,
    lineBucketsComplete: lineIndex.complete,
    symbolsByBlock: blockIndex.buckets,
    blockBucketsComplete: blockIndex.complete,
  };
}

function findContainingProviderSymbol(
  occurrence: ScipOccurrence,
  lookup: ContainmentLookup,
): string | null {
  if (occurrence.enclosingRange) {
    const directSymbolId = lookup.symbolIdByRangeKey.get(
      scipRangeKey(occurrence.enclosingRange),
    );
    if (directSymbolId) return directSymbolId;
  }

  const candidates =
    lookup.symbolsByLine.get(occurrence.range.startLine) ??
    lookup.symbolsByBlock.get(containmentBlockKey(occurrence.range.startLine));
  if (candidates) {
    for (const symbol of candidates) {
      if (rangeContains(symbol.range, occurrence.range)) {
        return symbol.symbolId;
      }
    }

    return null;
  }

  if (lookup.lineBucketsComplete || lookup.blockBucketsComplete) return null;

  for (const symbol of lookup.symbols) {
    if (rangeContains(symbol.range, occurrence.range)) {
      return symbol.symbolId;
    }
  }

  return null;
}

function buildContainmentSymbolsByLine(
  symbols: readonly ContainmentSymbol[],
): {
  buckets: ReadonlyMap<number, readonly ContainmentSymbol[]>;
  complete: boolean;
} {
  const symbolsByLine = new Map<number, ContainmentSymbol[]>();
  let entryCount = 0;

  // Keep each bucket in ascending span order by iterating over the already
  // sorted symbol list. Most references then test only the small set of
  // symbols that can contain their start line instead of every symbol in the
  // document.
  for (const symbol of symbols) {
    const startLine = Math.max(0, symbol.range.startLine);
    const endLine = Math.max(startLine, symbol.range.endLine);
    const linesSpanned = endLine - startLine + 1;
    if (entryCount + linesSpanned > CONTAINMENT_LINE_BUCKET_ENTRY_LIMIT) {
      return { buckets: new Map(), complete: false };
    }
    entryCount += linesSpanned;
    for (let line = startLine; line <= endLine; line += 1) {
      const bucket = symbolsByLine.get(line);
      if (bucket) {
        bucket.push(symbol);
      } else {
        symbolsByLine.set(line, [symbol]);
      }
    }
  }

  return { buckets: symbolsByLine, complete: true };
}

function buildContainmentSymbolsByBlock(
  symbols: readonly ContainmentSymbol[],
): {
  buckets: ReadonlyMap<number, readonly ContainmentSymbol[]>;
  complete: boolean;
} {
  const symbolsByBlock = new Map<number, ContainmentSymbol[]>();
  let entryCount = 0;

  // When exact per-line buckets would be too large, coarse line blocks keep
  // containment lookups local without allowing generated files to allocate a
  // bucket entry for every spanned source line.
  for (const symbol of symbols) {
    const startBlock = containmentBlockKey(symbol.range.startLine);
    const endBlock = containmentBlockKey(
      Math.max(symbol.range.startLine, symbol.range.endLine),
    );
    const blocksSpanned = endBlock - startBlock + 1;
    if (entryCount + blocksSpanned > CONTAINMENT_LINE_BUCKET_ENTRY_LIMIT) {
      return { buckets: new Map(), complete: false };
    }
    entryCount += blocksSpanned;
    for (let block = startBlock; block <= endBlock; block += 1) {
      const bucket = symbolsByBlock.get(block);
      if (bucket) {
        bucket.push(symbol);
      } else {
        symbolsByBlock.set(block, [symbol]);
      }
    }
  }

  return { buckets: symbolsByBlock, complete: true };
}

function containmentBlockKey(line: number): number {
  return Math.floor(Math.max(0, line) / CONTAINMENT_LINE_BLOCK_SIZE);
}

function rangeSpan(range: ScipRange): number {
  return (
    (range.endLine - range.startLine) * 100_000 +
    (range.endCol - range.startCol)
  );
}

function rangeContains(container: ScipRange, inner: ScipRange): boolean {
  const startsBeforeOrAt =
    container.startLine < inner.startLine ||
    (container.startLine === inner.startLine &&
      container.startCol <= inner.startCol);
  const endsAfterOrAt =
    container.endLine > inner.endLine ||
    (container.endLine === inner.endLine && container.endCol >= inner.endCol);
  return startsBeforeOrAt && endsAfterOrAt;
}

function coverageLevel(total: number, matched: number): CoverageLevel {
  if (total === 0) return "full";
  if (matched === 0) return "none";
  return matched === total ? "full" : "partial";
}

function legacyFallback(
  symbolCoverage: CoverageLevel,
  referenceCoverage: CoverageLevel,
): "skip" | "targeted" | "full" {
  if (symbolCoverage === "full" && referenceCoverage === "full") return "skip";
  if (symbolCoverage === "none") return "full";
  return "targeted";
}

function scipRangeToRange(range: ScipRange): Range {
  return {
    startLine: range.startLine + 1,
    startCol: range.startCol,
    endLine: range.endLine + 1,
    endCol: range.endCol,
  };
}

function diagnosticSeverity(
  severity: number,
): DiagnosticFact["severity"] {
  if (severity <= 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "information";
  return "hint";
}

function appendMany<T>(target: T[], source: readonly T[]): void {
  for (const item of source) {
    target.push(item);
  }
}

function normalizeSourceLinesByPath(
  options: Pick<
    NormalizeScipProviderFactsOptions,
    "sourceLinesByPath" | "sourceTextByPath"
  >,
): SourceLinesByPath {
  const normalizedLines = new Map<string, ReadonlyMap<number, string>>();
  for (const [relPath, sourceLines] of options.sourceLinesByPath ?? []) {
    normalizedLines.set(normalizePath(relPath), sourceLines);
  }
  for (const [relPath, sourceText] of options.sourceTextByPath ?? []) {
    if (normalizedLines.has(normalizePath(relPath))) continue;
    const lineMap = new Map<number, string>();
    for (const [lineNumber, line] of sourceText.split(/\r?\n/).entries()) {
      lineMap.set(lineNumber, line);
    }
    normalizedLines.set(normalizePath(relPath), lineMap);
  }
  return normalizedLines;
}

function normalizeSourceLineUnavailableReasonByPath(
  options: Pick<
    NormalizeScipProviderFactsOptions,
    "sourceLineUnavailableReasonByPath"
  >,
): SourceLineUnavailableReasonByPath {
  const normalizedReasons = new Map<string, CallProofUnavailableReasonCode>();
  for (const [relPath, reason] of options.sourceLineUnavailableReasonByPath ?? []) {
    normalizedReasons.set(normalizePath(relPath), reason);
  }
  return normalizedReasons;
}
