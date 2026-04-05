import type { SymbolKind, RepoId, SymbolId } from "../domain/types.js";

// --- Decoder output types (shared between Rust and TS decoders) ---

export interface ScipMetadata {
  version: number;
  toolName: string;
  toolVersion: string;
  toolArguments: string[];
  projectRoot: string;
  textDocumentEncoding: string;
}

export interface ScipRange {
  startLine: number; // 0-based
  startCol: number;
  endLine: number; // 0-based
  endCol: number;
}

export interface ScipOccurrence {
  range: ScipRange;
  symbol: string;
  symbolRoles: number;
  overrideDocumentation: string[];
  syntaxKind: number;
  diagnostics: ScipDiagnostic[];
}

export interface ScipDiagnostic {
  severity: number;
  code: string;
  message: string;
  source: string;
  range?: ScipRange;
}

export interface ScipSymbolInfo {
  symbol: string;
  documentation: string[];
  relationships: ScipRelationship[];
  kind: number;
  displayName: string;
  signatureDocumentation?: string;
  enclosingSymbol?: string;
}

export interface ScipRelationship {
  symbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

export interface ScipDocument {
  language: string;
  relativePath: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInfo[];
}

export interface ScipExternalSymbol {
  symbol: string;
  documentation: string[];
  relationships: ScipRelationship[];
  kind: number;
  displayName: string;
  signatureDocumentation?: string;
}

// --- Decoder interface ---

export interface ScipDecoder {
  metadata(): Promise<ScipMetadata>;
  documents(): AsyncIterable<ScipDocument>;
  externalSymbols(): Promise<ScipExternalSymbol[]>;
  close(): void;
}

// --- Ingestion types ---

export interface ScipIngestRequest {
  repoId: RepoId;
  indexPath: string;
  dryRun?: boolean;
}

export interface ScipIngestResponse {
  status: "ingested" | "alreadyIngested" | "dryRun";
  decoderBackend: "rust" | "typescript";
  documentsProcessed: number;
  documentsSkipped: number;
  symbolsMatched: number;
  symbolsCreated: number;
  externalSymbolsCreated: number;
  edgesCreated: number;
  edgesUpgraded: number;
  edgesReplaced: number;
  unresolvedOccurrences: number;
  skippedSymbols: number;
  truncated: boolean;
  durationMs: number;
}

export interface ScipIngestionRecord {
  id: string;
  repoId: RepoId;
  indexPath: string;
  contentHash: string;
  ingestedAt: string;
  ledgerVersion: string;
  symbolCount: number;
  edgeCount: number;
  externalSymbolCount: number;
  truncated: boolean;
}

// --- Kind mapping ---

export interface ScipKindMapping {
  sdlKind: SymbolKind;
  skip: false;
}

export interface ScipKindSkip {
  sdlKind: null;
  skip: true;
  reason: string;
}

export type ScipKindResult = ScipKindMapping | ScipKindSkip;

// --- Symbol match ---

export interface ScipSymbolMatch {
  scipSymbol: string;
  sdlSymbolId: SymbolId;
  matchType: "exact" | "nameOnly" | "external";
  kindMismatch: boolean;
}
