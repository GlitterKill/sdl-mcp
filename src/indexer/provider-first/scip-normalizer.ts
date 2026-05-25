import type { EdgeType, Range, RepoId } from "../../domain/types.js";
import {
  extractNameFromDescriptors,
  extractPackageInfo,
  mapScipKind,
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
import {
  createProviderEdgeDedupeKey,
  createProviderOccurrenceId,
  createProviderSymbolId,
} from "./ids.js";
import type {
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

export interface NormalizeScipProviderFactsOptions {
  repoId: RepoId;
  generationId: string;
  providerId: string;
  providerVersion?: string;
  documents: readonly ScipDocument[];
  externalSymbols?: readonly ScipExternalSymbol[];
  sourceIndexPath?: string;
  confidence?: number;
  emittedAt?: string;
}

interface NormalizedScipContext {
  base: ProviderFactBase;
  confidence: number;
  symbolIdsByProviderId: Map<string, string>;
}

interface ContainmentSymbol {
  providerSymbolId: string;
  symbolId: string;
  range: ScipRange;
}

export function normalizeScipProviderFacts(
  options: NormalizeScipProviderFactsOptions,
): ProviderFactSet {
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
    symbolIdsByProviderId: new Map(),
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
  };

  const seenSymbolIds = new Set<string>();
  for (const document of options.documents) {
    const relPath = normalizePath(document.relativePath);
    facts.files.push(fileFact(context, document, relPath));

    for (const info of document.symbols) {
      const symbolFact = symbolInfoToFact(context, info, relPath, document);
      if (!symbolFact) continue;
      context.symbolIdsByProviderId.set(info.symbol, symbolFact.symbolId);
      if (seenSymbolIds.has(symbolFact.symbolId)) continue;
      seenSymbolIds.add(symbolFact.symbolId);
      facts.symbols.push(symbolFact);
    }
  }

  for (const externalSymbol of options.externalSymbols ?? []) {
    const externalFact = externalSymbolToFact(context, externalSymbol);
    if (!externalFact) continue;
    context.symbolIdsByProviderId.set(
      externalSymbol.symbol,
      externalFact.symbolId,
    );
    facts.externalSymbols.push(externalFact);
  }

  const edgeKeys = new Set<string>();
  for (const document of options.documents) {
    const relPath = normalizePath(document.relativePath);
    const documentOccurrences = document.occurrences.map((occurrence, index) =>
      occurrenceToFact(context, occurrence, relPath, index),
    );
    facts.occurrences.push(...documentOccurrences);
    facts.diagnostics.push(
      ...document.occurrences.flatMap((occurrence, occurrenceIndex) =>
        occurrence.diagnostics.map((diagnostic, diagnosticIndex) =>
          diagnosticToFact(
            context,
            diagnostic,
            relPath,
            occurrenceIndex,
            diagnosticIndex,
          ),
        ),
      ),
    );
    facts.coverage.push(
      coverageFact(context, document, relPath, documentOccurrences),
    );
    facts.edges.push(
      ...relationshipEdges(context, document, edgeKeys),
      ...occurrenceEdges(context, document, edgeKeys),
    );
  }

  facts.providerRuns.push(providerRunFact(options, base, facts));
  return facts;
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
  document: ScipDocument,
): SymbolFact | null {
  const kind = mapScipKind(info.symbol, info.kind);
  if (kind.skip) return null;

  const definitionRange = findDefinitionRange(document, info.symbol);
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
  occurrences: readonly OccurrenceFact[],
): ProviderFactSet["coverage"][number] {
  const emittedSymbols = document.symbols.filter((info) =>
    context.symbolIdsByProviderId.has(info.symbol),
  ).length;
  const unresolvedOccurrences = occurrences.filter(
    (occurrence) => occurrence.symbolId === undefined,
  ).length;
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
    diagnosticCoverage: diagnosticCount > 0 ? "full" : "none",
    totalSymbols: document.symbols.length,
    emittedSymbols,
    totalOccurrences: occurrences.length,
    unresolvedOccurrences,
    legacyFallback: legacyFallback(symbolCoverage, referenceCoverage),
  };
}

function relationshipEdges(
  context: NormalizedScipContext,
  document: ScipDocument,
  edgeKeys: Set<string>,
): EdgeFact[] {
  const edges: EdgeFact[] = [];
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
      });
    }
  }
  return edges;
}

function occurrenceEdges(
  context: NormalizedScipContext,
  document: ScipDocument,
  edgeKeys: Set<string>,
): EdgeFact[] {
  const edges: EdgeFact[] = [];
  const containmentSymbols = buildContainmentSymbols(context, document);
  const implementationSymbols = getImplementationSymbols(document);

  for (const occurrence of document.occurrences) {
    if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) !== 0) continue;

    const sourceSymbolId = findContainingProviderSymbol(
      occurrence.range,
      containmentSymbols,
    );
    const targetSymbolId = context.symbolIdsByProviderId.get(occurrence.symbol);
    if (!sourceSymbolId || !targetSymbolId || sourceSymbolId === targetSymbolId) {
      continue;
    }

    const edgeType = occurrenceEdgeType(occurrence, implementationSymbols);
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
  document: ScipDocument,
  symbol: string,
): Range | undefined {
  const definition = findDefinitionOccurrence(document, symbol);
  return definition
    ? scipRangeToRange(definition.enclosingRange ?? definition.range)
    : undefined;
}

function findDefinitionOccurrence(
  document: ScipDocument,
  symbol: string,
): ScipOccurrence | undefined {
  return document.occurrences.find(
    (occurrence) =>
      occurrence.symbol === symbol &&
      (occurrence.symbolRoles & SCIP_ROLE_DEFINITION) !== 0,
  );
}

function displayName(info: { symbol: string; displayName: string }): string {
  if (info.displayName.length > 0) return info.displayName;
  const parsed = parseScipSymbol(info.symbol);
  return extractNameFromDescriptors(parsed.descriptors) || info.symbol;
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
  // SCIP relationships alone do not prove invocation semantics. Keep
  // references/unknown relationships out of exact call edges until the
  // provider path has syntax-aware call proof.
  return null;
}

function occurrenceEdgeType(
  occurrence: ScipOccurrence,
  implementationSymbols: ReadonlySet<string>,
): EdgeType | null {
  if (implementationSymbols.has(occurrence.symbol)) return "implements";
  if ((occurrence.symbolRoles & SCIP_ROLE_IMPORT) !== 0) return "import";
  // A raw SCIP reference occurrence is not enough evidence for call
  // semantics. Keep broad references in occurrence facts until a syntax-aware
  // provider pass can prove invocation edges.
  return null;
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
): ContainmentSymbol[] {
  const symbols: ContainmentSymbol[] = [];
  for (const info of document.symbols) {
    const symbolId = context.symbolIdsByProviderId.get(info.symbol);
    if (!symbolId) continue;

    const definition = findDefinitionOccurrence(document, info.symbol);
    if (!definition) continue;

    symbols.push({
      providerSymbolId: info.symbol,
      symbolId,
      range: definition.enclosingRange ?? definition.range,
    });
  }
  return symbols;
}

function findContainingProviderSymbol(
  occurrenceRange: ScipRange,
  symbols: readonly ContainmentSymbol[],
): string | null {
  let best: ContainmentSymbol | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;

  for (const symbol of symbols) {
    if (!rangeContains(symbol.range, occurrenceRange)) continue;
    const span =
      (symbol.range.endLine - symbol.range.startLine) * 100_000 +
      (symbol.range.endCol - symbol.range.startCol);
    if (span < bestSpan) {
      best = symbol;
      bestSpan = span;
    }
  }

  return best?.symbolId ?? null;
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
  if (total === 0 || matched === 0) return "none";
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
