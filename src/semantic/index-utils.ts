import { normalizePath } from "../util/paths.js";
import type {
  SemanticDiagnostic,
  SemanticDocument,
  SemanticEdge,
  SemanticIndex,
  SemanticOccurrence,
  SemanticSymbol,
} from "./types.js";

export function normalizeSemanticIndexPaths(index: SemanticIndex): SemanticIndex {
  return {
    ...index,
    sourceIndexPath: index.sourceIndexPath
      ? normalizePath(index.sourceIndexPath)
      : undefined,
    documents: index.documents.map(normalizeDocument),
    symbols: index.symbols.map(normalizeSymbol),
    diagnostics: index.diagnostics.map(normalizeDiagnostic),
  };
}

export function filterSemanticIndexByLanguages(
  index: SemanticIndex,
  languages: readonly string[] | undefined,
): SemanticIndex {
  if (!languages || languages.length === 0) return index;

  const allowed = new Set(languages);
  const documents = index.documents.filter((document) =>
    allowed.has(document.languageId),
  );
  const keptPaths = new Set(documents.map((document) => document.sourcePath));
  const symbols = index.symbols.filter(
    (symbol) =>
      allowed.has(symbol.languageId) ||
      (symbol.sourcePath !== undefined && keptPaths.has(symbol.sourcePath)),
  );
  const providerSymbolIds = new Set(
    symbols.map((symbol) => symbol.providerSymbolId),
  );
  const sdlSymbolIds = new Set(
    symbols
      .map((symbol) => symbol.sdlSymbolId)
      .filter((symbolId): symbolId is string => Boolean(symbolId)),
  );

  return {
    ...index,
    documents,
    symbols,
    edges: index.edges.filter(
      (edge) =>
        edgeEndpointInScope(edge, "source", providerSymbolIds, sdlSymbolIds) &&
        edgeEndpointInScope(edge, "target", providerSymbolIds, sdlSymbolIds),
    ),
    diagnostics: index.diagnostics.filter(
      (diagnostic) =>
        allowed.has(diagnostic.languageId) || keptPaths.has(diagnostic.sourcePath),
    ),
  };
}

function normalizeDocument(document: SemanticDocument): SemanticDocument {
  return {
    ...document,
    sourcePath: normalizePath(document.sourcePath),
    occurrences: document.occurrences.map(normalizeOccurrence),
    diagnostics: document.diagnostics.map(normalizeDiagnostic),
  };
}

function normalizeOccurrence(
  occurrence: SemanticOccurrence,
): SemanticOccurrence {
  return {
    ...occurrence,
    sourcePath: normalizePath(occurrence.sourcePath),
  };
}

function normalizeSymbol(symbol: SemanticSymbol): SemanticSymbol {
  return {
    ...symbol,
    sourcePath: symbol.sourcePath ? normalizePath(symbol.sourcePath) : undefined,
  };
}

function normalizeDiagnostic(
  diagnostic: SemanticDiagnostic,
): SemanticDiagnostic {
  return {
    ...diagnostic,
    sourcePath: normalizePath(diagnostic.sourcePath),
  };
}

function edgeEndpointInScope(
  edge: SemanticEdge,
  side: "source" | "target",
  providerSymbolIds: ReadonlySet<string>,
  sdlSymbolIds: ReadonlySet<string>,
): boolean {
  const providerId =
    side === "source" ? edge.sourceProviderSymbolId : edge.targetProviderSymbolId;
  if (providerId) return providerSymbolIds.has(providerId);

  const sdlId = side === "source" ? edge.sourceSymbolId : edge.targetSymbolId;
  return sdlId ? sdlSymbolIds.size === 0 || sdlSymbolIds.has(sdlId) : false;
}
