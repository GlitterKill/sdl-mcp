import type { RepoId } from "../../../domain/types.js";
import {
  SCIP_ROLE_DEFINITION,
  SCIP_ROLE_IMPORT,
} from "../../../scip/symbol-matcher.js";
import type {
  ScipDocument,
  ScipMetadata,
  ScipOccurrence,
  ScipRange,
} from "../../../scip/types.js";
import type {
  SemanticDocument,
  SemanticIndex,
  SemanticOccurrence,
  SemanticRange,
} from "../../types.js";

export function scipRangeToSemanticRange(range: ScipRange): SemanticRange {
  return {
    startLine: range.startLine,
    startCol: range.startCol,
    endLine: range.endLine,
    endCol: range.endCol,
  };
}

export function scipOccurrenceToSemanticOccurrence(
  occurrence: ScipOccurrence,
  sourcePath: string,
): SemanticOccurrence {
  return {
    providerSymbolId: occurrence.symbol,
    sourcePath,
    range: scipRangeToSemanticRange(occurrence.range),
    capability:
      occurrence.symbolRoles & SCIP_ROLE_DEFINITION
        ? "definition"
        : occurrence.symbolRoles & SCIP_ROLE_IMPORT
          ? "reference"
          : "reference",
    confidence: 0.95,
  };
}

export function scipDocumentToSemanticDocument(
  document: ScipDocument,
  repoId: RepoId,
  runId: string,
  providerId: string,
): SemanticDocument {
  return {
    languageId: document.language,
    sourcePath: document.relativePath,
    occurrences: document.occurrences.map((occurrence) =>
      scipOccurrenceToSemanticOccurrence(occurrence, document.relativePath),
    ),
    diagnostics: document.occurrences.flatMap((occurrence, index) =>
      occurrence.diagnostics.map((diagnostic, diagnosticIndex) => ({
        id: `${runId}:${document.relativePath}:${index}:${diagnosticIndex}`,
        repoId,
        runId,
        providerType: "scip" as const,
        providerId,
        languageId: document.language,
        sourcePath: document.relativePath,
        severity: scipSeverityToSemanticSeverity(diagnostic.severity),
        message: diagnostic.message,
        code: diagnostic.code,
        range: diagnostic.range
          ? scipRangeToSemanticRange(diagnostic.range)
          : undefined,
      })),
    ),
  };
}

export function buildSemanticIndexFromScipDocuments(params: {
  repoId: RepoId;
  runId: string;
  metadata: ScipMetadata;
  documents: ScipDocument[];
  sourceIndexPath?: string;
}): SemanticIndex {
  const providerId = params.metadata.toolName || "scip";
  const documents = params.documents.map((document) =>
    scipDocumentToSemanticDocument(
      document,
      params.repoId,
      params.runId,
      providerId,
    ),
  );

  return {
    repoId: params.repoId,
    runId: params.runId,
    providerType: "scip",
    providerId,
    providerVersion: params.metadata.toolVersion,
    sourceIndexPath: params.sourceIndexPath,
    generatedAt: new Date().toISOString(),
    documents,
    symbols: params.documents.flatMap((document) =>
      document.symbols.map((symbol) => ({
        providerSymbolId: symbol.symbol,
        name: symbol.displayName,
        kind: String(symbol.kind),
        languageId: document.language,
        sourcePath: document.relativePath,
        documentation: symbol.documentation,
      })),
    ),
    edges: [],
    diagnostics: documents.flatMap((document) => document.diagnostics),
  };
}

function scipSeverityToSemanticSeverity(
  severity: number,
): "error" | "warning" | "information" | "hint" {
  if (severity <= 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "information";
  return "hint";
}
