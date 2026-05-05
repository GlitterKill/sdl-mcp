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

/**
 * Per-document coverage row emitted by the ingest pipeline so downstream
 * consumers (e.g. pass-2 file-skip optimisation) can decide whether SCIP
 * resolved every callable occurrence in a file. Counts are scoped to
 * occurrences whose role is REFERENCE — definitions and metadata-only
 * occurrences are excluded since they are not "calls to resolve".
 *
 * "Fully covered" is `total > 0 && matched === total && unresolved === 0`.
 * Zero-of-zero is NEVER coverage (would silently skip files SCIP did not
 * actually analyse).
 */
export interface ScipFileCoverage {
  /** Repo-relative path that SDL stores in `File.relPath`. */
  relPath: string;
  /** Total callable reference occurrences extracted from the document. */
  total: number;
  /** Subset of `total` that bound to an existing SDL symbol or a SCIP-created external symbol. */
  matched: number;
  /** Subset of `total` that could not be resolved to any symbol. */
  unresolved: number;
}

export interface ScipIngestResponse {
  status: "ingested" | "alreadyIngested" | "dryRun";
  decoderBackend: "rust" | "typescript";
  documentsProcessed: number;
  documentsSkipped: number;
  symbolsMatched: number;
  externalSymbolsCreated: number;
  edgesCreated: number;
  edgesUpgraded: number;
  edgesReplaced: number;
  unresolvedOccurrences: number;
  skippedSymbols: number;
  truncated: boolean;
  durationMs: number;
  /**
   * Per-document coverage rows. Empty for `status: "alreadyIngested"` or
   * `dryRun` since neither produces fresh occurrence data.
   */
  perFileCoverage: ScipFileCoverage[];
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
