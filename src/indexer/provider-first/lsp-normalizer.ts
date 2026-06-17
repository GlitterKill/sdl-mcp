import type {
  Diagnostic,
  DocumentSymbol,
  Range as LspRange,
  SymbolInformation,
} from "vscode-languageserver-protocol";

import type { Range, SymbolKind } from "../../domain/types.js";
import { generateFileId, hashValue } from "../../util/hashing.js";
import { normalizePath } from "../../util/paths.js";
import { createProviderSymbolId } from "./ids.js";
import type {
  DiagnosticFact,
  CoverageFact,
  FileFact,
  ProviderFactBase,
  ProviderFactSet,
  ProviderRunFact,
  SymbolFact,
} from "./types.js";

export interface LspProviderDocument {
  relPath: string;
  languageId?: string;
  contentHash?: string;
  byteSize?: number;
  text?: string;
  symbols?: readonly LspDocumentSymbolLike[];
  symbolError?: string;
  diagnostics?: readonly Diagnostic[];
}

export type LspDocumentSymbolLike = DocumentSymbol | SymbolInformation;

export interface NormalizeLspProviderFactsParams {
  repoId: string;
  generationId: string;
  providerId: string;
  providerVersion?: string;
  emittedAt?: string;
  documents: readonly LspProviderDocument[];
  run: {
    runId: string;
    status: ProviderRunFact["status"];
    startedAt: string;
    finishedAt?: string;
    errorMessage?: string;
  };
}

interface FlattenedLspSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  path: readonly string[];
}

export function normalizeLspProviderFacts(
  params: NormalizeLspProviderFactsParams,
): ProviderFactSet {
  const emittedAt = params.emittedAt ?? new Date().toISOString();
  const base: ProviderFactBase = {
    repoId: params.repoId,
    generationId: params.generationId,
    providerType: "lsp",
    providerId: params.providerId,
    providerVersion: params.providerVersion,
    emittedAt,
  };
  const files: FileFact[] = [];
  const symbols: SymbolFact[] = [];
  const diagnostics: DiagnosticFact[] = [];
  const coverage: CoverageFact[] = [];

  for (const document of params.documents) {
    const relPath = normalizePath(document.relPath);
    const fileId = generateFileId(params.repoId, relPath);
    const documentSymbols = flattenDocumentSymbols(document.symbols ?? []);

    files.push({
      ...base,
      kind: "file" as const,
      fileId,
      relPath,
      languageId: document.languageId,
      contentHash: document.contentHash,
      byteSize: document.byteSize,
    });

    for (const symbol of documentSymbols) {
      const range = lspRangeToSdlRange(symbol.range, document.text);
      const providerSymbolId = [
        params.providerId,
        relPath,
        symbol.path.join("."),
        range.startLine,
        range.startCol,
        range.endLine,
        range.endCol,
      ].join(":");
      symbols.push({
        ...base,
        kind: "symbol",
        symbolId: createProviderSymbolId({
          repoId: params.repoId,
          providerType: "lsp",
          providerId: params.providerId,
          providerVersion: params.providerVersion,
          providerSymbolId,
          sourcePath: relPath,
          range,
        }),
        providerSymbolId,
        name: symbol.name,
        symbolKind: lspSymbolKindToSdlKind(symbol.kind),
        relPath,
        range,
        documentation: [],
        external: false,
        symbolStatus: "real",
      });
    }

    for (const diagnostic of document.diagnostics ?? []) {
      const range = diagnostic.range
        ? lspRangeToSdlRange(diagnostic.range, document.text)
        : undefined;
      diagnostics.push({
        ...base,
        kind: "diagnostic",
        diagnosticId: hashValue({
          schema: "sdl-provider-lsp-diagnostic:v1",
          repoId: params.repoId,
          providerId: params.providerId,
          relPath,
          message: diagnostic.message,
          code: diagnostic.code,
          range,
        }),
        relPath,
        message: diagnostic.message,
        severity: lspDiagnosticSeverityToSdlSeverity(diagnostic.severity),
        code:
          diagnostic.code === undefined ? undefined : String(diagnostic.code),
        range,
      });
    }

    const symbolCoverage = documentSymbols.length > 0 ? "full" : "none";
    const skippedSymbolReasons = document.symbolError
      ? [
          {
            reason: "documentSymbol request failed",
            symbols: 1,
          },
        ]
      : undefined;

    coverage.push({
      ...base,
      kind: "coverage" as const,
      relPath,
      symbolCoverage,
      referenceCoverage: "none" as const,
      callProofCoverage: "none" as const,
      diagnosticCoverage:
        document.diagnostics === undefined ? ("none" as const) : ("full" as const),
      totalSymbols: documentSymbols.length,
      emittedSymbols: documentSymbols.length,
      totalOccurrences: 0,
      unresolvedOccurrences: 0,
      totalResolvedReferences: 0,
      callProofUnavailableReferences: 0,
      skippedSymbolReasons,
      legacyFallback:
        symbolCoverage === "none" ? ("full" as const) : ("targeted" as const),
    });
  }

  const providerRuns: ProviderRunFact[] = [
    {
      ...base,
      kind: "providerRun",
      runId: params.run.runId,
      status: params.run.status,
      startedAt: params.run.startedAt,
      finishedAt: params.run.finishedAt,
      fileCount: files.length,
      symbolCount: symbols.length,
      edgeCount: 0,
      diagnosticCount: diagnostics.length,
      errorMessage: params.run.errorMessage,
    },
  ];

  return {
    files,
    symbols,
    occurrences: [],
    edges: [],
    externalSymbols: [],
    diagnostics,
    coverage,
    providerRuns,
  };
}

function flattenDocumentSymbols(
  symbols: readonly LspDocumentSymbolLike[],
  parents: readonly string[] = [],
): FlattenedLspSymbol[] {
  const flattened: FlattenedLspSymbol[] = [];
  for (const symbol of symbols) {
    if (isDocumentSymbol(symbol)) {
      const path = [...parents, symbol.name];
      flattened.push({
        name: symbol.name,
        kind: symbol.kind,
        range: symbol.range,
        selectionRange: symbol.selectionRange,
        path,
      });
      flattened.push(...flattenDocumentSymbols(symbol.children ?? [], path));
      continue;
    }
    if (!symbol.location) continue;
    const path = [...parents, symbol.name];
    flattened.push({
      name: symbol.name,
      kind: symbol.kind,
      range: symbol.location.range,
      path,
    });
  }
  return flattened;
}

function isDocumentSymbol(symbol: LspDocumentSymbolLike): symbol is DocumentSymbol {
  return "range" in symbol && "selectionRange" in symbol;
}

function lspRangeToSdlRange(range: LspRange, sourceText?: string): Range {
  const unclamped = {
    startLine: range.start.line + 1,
    startCol: range.start.character,
    endLine: range.end.line + 1,
    endCol: range.end.character,
  };
  if (sourceText === undefined) return unclamped;

  const sourceLines = sourceText.split(/\r?\n/u);
  const maxLine = Math.max(sourceLines.length, 1);
  const startLine = clamp(unclamped.startLine, 1, maxLine);
  const endLine = clamp(unclamped.endLine, startLine, maxLine);
  const startCol = clamp(
    unclamped.startCol,
    0,
    sourceLines[startLine - 1]?.length ?? 0,
  );
  const endCol = clamp(
    unclamped.endCol,
    startLine === endLine ? startCol : 0,
    sourceLines[endLine - 1]?.length ?? 0,
  );

  return { startLine, startCol, endLine, endCol };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function lspSymbolKindToSdlKind(kind: number): SymbolKind {
  switch (kind) {
    case 2:
    case 3:
    case 4:
      return "module";
    case 5:
    case 23:
      return "class";
    case 6:
      return "method";
    case 9:
      return "constructor";
    case 10:
    case 22:
    case 26:
      return "type";
    case 11:
      return "interface";
    case 12:
      return "function";
    case 7:
    case 8:
    case 13:
    case 14:
    default:
      return "variable";
  }
}

function lspDiagnosticSeverityToSdlSeverity(
  severity: Diagnostic["severity"],
): DiagnosticFact["severity"] {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "information";
  }
}
