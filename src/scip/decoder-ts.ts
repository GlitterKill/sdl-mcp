/**
 * TypeScript fallback SCIP decoder.
 *
 * Uses the hand-written protobuf decoder from `./proto/scip_pb.js` to decode
 * SCIP index files when the Rust native addon is not available.
 */

import { readFile, stat } from "node:fs/promises";
import type {
  ScipDecoder,
  ScipMetadata,
  ScipDocument,
  ScipExternalSymbol,
  ScipOccurrence,
  ScipRange,
  ScipDiagnostic,
  ScipSymbolInfo,
  ScipRelationship,
} from "./types.js";
import { decodeScipIndex, TextEncoding } from "./proto/scip_pb.js";
import type {
  ScipIndex as ProtoScipIndex,
  ScipDocument as ProtoScipDocument,
  ScipOccurrence as ProtoScipOccurrence,
  ScipSymbolInformation as ProtoScipSymbolInformation,
  ScipRelationship as ProtoScipRelationship,
  ScipDiagnostic as ProtoScipDiagnostic,
} from "./proto/scip_pb.js";
import { ScipDecodeError } from "../domain/errors.js";

// ---------------------------------------------------------------------------
// Mapping helpers: proto types -> domain types
// ---------------------------------------------------------------------------

/**
 * Map SCIP's compact range encoding to our structured ScipRange.
 *
 * SCIP encodes ranges as a number array:
 * - 3 elements: [startLine, startCol, endCol] (single-line span)
 * - 4 elements: [startLine, startCol, endLine, endCol] (multi-line span)
 */
function mapRange(r: number[]): ScipRange {
  if (r.length === 3) {
    return {
      startLine: r[0],
      startCol: r[1],
      endLine: r[0], // same line
      endCol: r[2],
    };
  }
  // 4-element form (or fallback for unexpected lengths)
  return {
    startLine: r[0] ?? 0,
    startCol: r[1] ?? 0,
    endLine: r[2] ?? 0,
    endCol: r[3] ?? 0,
  };
}

function mapRelationship(r: ProtoScipRelationship): ScipRelationship {
  return {
    symbol: r.symbol,
    isReference: r.isReference,
    isImplementation: r.isImplementation,
    isTypeDefinition: r.isTypeDefinition,
    isDefinition: r.isDefinition,
  };
}

function mapDiagnostic(d: ProtoScipDiagnostic): ScipDiagnostic {
  return {
    severity: d.severity,
    code: d.code,
    message: d.message,
    source: d.source,
    range: undefined, // proto ScipDiagnostic does not carry a range field
  };
}

function mapOccurrence(o: ProtoScipOccurrence): ScipOccurrence {
  return {
    range: mapRange(o.range),
    symbol: o.symbol,
    symbolRoles: o.symbolRoles,
    overrideDocumentation: o.overrideDocumentation,
    syntaxKind: o.syntaxKind,
    diagnostics: o.diagnostics.map(mapDiagnostic),
  };
}

function mapSymbolInfo(s: ProtoScipSymbolInformation): ScipSymbolInfo {
  return {
    symbol: s.symbol,
    documentation: s.documentation,
    relationships: s.relationships.map(mapRelationship),
    kind: s.kind,
    displayName: s.displayName,
    signatureDocumentation: s.signatureDocumentation
      ? extractSignatureText(s.signatureDocumentation)
      : undefined,
    enclosingSymbol: s.enclosingSymbol || undefined,
  };
}

/**
 * The proto `signatureDocumentation` is a nested ScipDocument. We extract
 * its `text` field as a plain string for the domain type.
 */
function extractSignatureText(
  doc: ProtoScipDocument | undefined,
): string | undefined {
  if (!doc) return undefined;
  return doc.text || undefined;
}

function mapExternalSymbol(s: ProtoScipSymbolInformation): ScipExternalSymbol {
  return {
    symbol: s.symbol,
    documentation: s.documentation,
    relationships: s.relationships.map(mapRelationship),
    kind: s.kind,
    displayName: s.displayName,
    signatureDocumentation: s.signatureDocumentation
      ? extractSignatureText(s.signatureDocumentation)
      : undefined,
  };
}

function mapDocument(doc: ProtoScipDocument): ScipDocument {
  return {
    language: doc.language,
    relativePath: doc.relativePath,
    occurrences: doc.occurrences.map(mapOccurrence),
    symbols: doc.symbols.map(mapSymbolInfo),
  };
}

/**
 * Map the numeric TextEncoding enum to a human-readable string.
 */
function mapEncoding(enc: number): string {
  switch (enc) {
    case TextEncoding.UTF8:
      return "UTF-8";
    case TextEncoding.UTF16:
      return "UTF-16";
    default:
      return "UnspecifiedTextEncoding";
  }
}

// ---------------------------------------------------------------------------
// Decoder class
// ---------------------------------------------------------------------------

/**
 * TypeScript fallback SCIP decoder.
 *
 * Loads the entire SCIP index into memory on first access and yields
 * documents via an async generator. Suitable for moderate-sized indexes;
 * for very large files the Rust streaming decoder is preferred.
 */
export class TypeScriptScipDecoder implements ScipDecoder {
  private index: ProtoScipIndex | null = null;
  private closed = false;

  constructor(private readonly filePath: string) {}

  async metadata(): Promise<ScipMetadata> {
    await this.ensureLoaded();
    const meta = this.index!.metadata;
    return {
      version: meta?.version ?? 0,
      toolName: meta?.toolInfo?.name ?? "",
      toolVersion: meta?.toolInfo?.version ?? "",
      toolArguments: meta?.toolInfo?.arguments ?? [],
      projectRoot: meta?.projectRoot ?? "",
      textDocumentEncoding: mapEncoding(meta?.textDocumentEncoding ?? 0),
    };
  }

  async *documents(): AsyncIterable<ScipDocument> {
    await this.ensureLoaded();
    // Snapshot the index reference so that a concurrent close() that nulls
    // out this.index does not produce a null deref on the next yield.
    const snapshot = this.index;
    if (!snapshot) return;
    for (const doc of snapshot.documents) {
      if (this.closed) return;
      yield mapDocument(doc);
    }
  }

  async externalSymbols(): Promise<ScipExternalSymbol[]> {
    await this.ensureLoaded();
    return (this.index!.externalSymbols ?? []).map(mapExternalSymbol);
  }

  close(): void {
    this.closed = true;
    this.index = null;
  }

  /** Maximum SCIP index file size (256 MB) for the TS fallback decoder. */
  private static readonly MAX_INDEX_SIZE = 256 * 1024 * 1024;
  /** Maximum number of documents in a SCIP index for the TS fallback decoder. */
  private static readonly MAX_DOCUMENTS = 50_000;
  /** Maximum total occurrences across all documents for the TS fallback decoder. */
  private static readonly MAX_TOTAL_OCCURRENCES = 5_000_000;

  private async ensureLoaded(): Promise<void> {
    if (this.index) return;
    try {
      const fileStat = await stat(this.filePath);
      if (fileStat.size > TypeScriptScipDecoder.MAX_INDEX_SIZE) {
        throw new ScipDecodeError(
          `SCIP index at ${this.filePath} is ${fileStat.size} bytes, exceeding the ` +
          `${TypeScriptScipDecoder.MAX_INDEX_SIZE} byte limit for the TypeScript decoder. ` +
          `Use the Rust native addon for large indexes.`,
        );
      }
      const buf = await readFile(this.filePath);
      this.index = decodeScipIndex(new Uint8Array(buf));
      // Refuse oversized indexes that would push memory usage near the heap
      // limit. The Rust streaming decoder should be used in that case.
      const docCount = this.index.documents?.length ?? 0;
      if (docCount > TypeScriptScipDecoder.MAX_DOCUMENTS) {
        this.index = null;
        throw new ScipDecodeError(
          `SCIP index at ${this.filePath} has ${docCount} documents, exceeding the ` +
          `${TypeScriptScipDecoder.MAX_DOCUMENTS} document limit for the TypeScript decoder. ` +
          `Use the Rust native addon for large indexes.`,
        );
      }
      let totalOcc = 0;
      for (const d of this.index.documents ?? []) {
        totalOcc += d.occurrences?.length ?? 0;
        if (totalOcc > TypeScriptScipDecoder.MAX_TOTAL_OCCURRENCES) {
          this.index = null;
          throw new ScipDecodeError(
            `SCIP index at ${this.filePath} has more than ` +
            `${TypeScriptScipDecoder.MAX_TOTAL_OCCURRENCES} total occurrences, exceeding ` +
            `the limit for the TypeScript decoder. Use the Rust native addon for large indexes.`,
          );
        }
      }
    } catch (err) {
      if (err instanceof ScipDecodeError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ScipDecodeError(
        `Failed to decode SCIP index at ${this.filePath}: ${msg}`,
      );
    }
  }
}
