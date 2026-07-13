/**
 * Rust-native SCIP decoder that wraps the napi-rs ScipDecodeHandle.
 *
 * Uses the shared native addon loader and keeps SCIP capability fallback local.
 */

import {
  getNativeAddonSourcePath,
  isNativeAddonGloballyEnabled,
  loadNativeAddon,
} from "../native/addon-loader.js";
import { logger } from "../util/logger.js";
import type {
  ScipDecoder,
  ScipMetadata,
  ScipDocument,
  ScipExternalSymbol,
  ScipOccurrence,
  ScipDiagnostic,
  ScipSymbolInfo,
  ScipRelationship,
  ScipRange,
} from "./types.js";


// --- Native addon types (camelCase fields from napi-rs) ---

interface NapiScipRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

interface NapiScipRelationship {
  symbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

interface NapiScipDiagnostic {
  severity: number;
  code: string;
  message: string;
  source: string;
  range?: NapiScipRange;
}

interface NapiScipOccurrence {
  range: NapiScipRange;
  enclosingRange?: NapiScipRange;
  symbol: string;
  symbolRoles: number;
  overrideDocumentation: string[];
  syntaxKind: number;
  diagnostics: NapiScipDiagnostic[];
}

interface NapiScipSymbolInfo {
  symbol: string;
  documentation: string[];
  relationships: NapiScipRelationship[];
  kind: number;
  displayName: string;
  signatureDocumentation?: string;
  enclosingSymbol?: string;
}

interface NapiScipDocument {
  language: string;
  relativePath: string;
  occurrences: NapiScipOccurrence[];
  symbols: NapiScipSymbolInfo[];
}

interface NapiScipExternalSymbol {
  symbol: string;
  documentation: string[];
  relationships: NapiScipRelationship[];
  kind: number;
  displayName: string;
  signatureDocumentation?: string;
}

interface NapiScipMetadata {
  version: number;
  toolName: string;
  toolVersion: string;
  toolArguments: string[];
  projectRoot: string;
  textDocumentEncoding: string;
}

/** The napi handle returned by scip_decode_start. */
interface NapiScipDecodeHandle {
  metadata(): NapiScipMetadata;
  nextDocument(): NapiScipDocument | null;
  externalSymbols(): NapiScipExternalSymbol[];
}

/** Subset of the native addon that includes SCIP decoder exports. */
interface ScipNativeAddon {
  scipDecodeStart(filePath: string): NapiScipDecodeHandle;
}

// --- SCIP capability gate ---

let cachedAddon: ScipNativeAddon | null | undefined;

function isScipCapableAddon(loaded: unknown): loaded is ScipNativeAddon {
  return (
    loaded !== null &&
    typeof loaded === "object" &&
    typeof (loaded as Record<string, unknown>).scipDecodeStart === "function"
  );
}

function loadScipAddon(): ScipNativeAddon | null {
  if (!isNativeAddonGloballyEnabled()) {
    logger.debug("SCIP native decoder disabled by SDL_MCP_DISABLE_NATIVE_ADDON");
    return null;
  }
  if (cachedAddon !== undefined) return cachedAddon;

  const loaded = loadNativeAddon(isScipCapableAddon);
  if (!isScipCapableAddon(loaded)) {
    cachedAddon = null;
    if (loaded !== null) {
      logger.debug("Native addon found but missing SCIP decoder exports", {
        path: getNativeAddonSourcePath(),
      });
    }
    return null;
  }

  cachedAddon = loaded;
  logger.debug("Loaded native SCIP decoder", {
    path: getNativeAddonSourcePath(),
  });
  return loaded;
}

// --- Conversion helpers (napi camelCase -> domain types) ---

function mapRange(r: NapiScipRange): ScipRange {
  return {
    startLine: r.startLine,
    startCol: r.startCol,
    endLine: r.endLine,
    endCol: r.endCol,
  };
}

function mapRelationship(r: NapiScipRelationship): ScipRelationship {
  return {
    symbol: r.symbol,
    isReference: r.isReference,
    isImplementation: r.isImplementation,
    isTypeDefinition: r.isTypeDefinition,
    isDefinition: r.isDefinition,
  };
}

function mapDiagnostic(d: NapiScipDiagnostic): ScipDiagnostic {
  return {
    severity: d.severity,
    code: d.code,
    message: d.message,
    source: d.source,
    range: d.range ? mapRange(d.range) : undefined,
  };
}

function mapOccurrence(o: NapiScipOccurrence): ScipOccurrence {
  return {
    range: mapRange(o.range),
    enclosingRange: o.enclosingRange ? mapRange(o.enclosingRange) : undefined,
    symbol: o.symbol,
    symbolRoles: o.symbolRoles,
    overrideDocumentation: o.overrideDocumentation,
    syntaxKind: o.syntaxKind,
    diagnostics: o.diagnostics.map(mapDiagnostic),
  };
}

function mapSymbolInfo(s: NapiScipSymbolInfo): ScipSymbolInfo {
  return {
    symbol: s.symbol,
    documentation: s.documentation,
    relationships: s.relationships.map(mapRelationship),
    kind: s.kind,
    displayName: s.displayName,
    signatureDocumentation: s.signatureDocumentation,
    enclosingSymbol: s.enclosingSymbol,
  };
}

function mapDocument(d: NapiScipDocument): ScipDocument {
  return {
    language: d.language,
    relativePath: d.relativePath,
    occurrences: d.occurrences.map(mapOccurrence),
    symbols: d.symbols.map(mapSymbolInfo),
  };
}

function mapExternalSymbol(s: NapiScipExternalSymbol): ScipExternalSymbol {
  return {
    symbol: s.symbol,
    documentation: s.documentation,
    relationships: s.relationships.map(mapRelationship),
    kind: s.kind,
    displayName: s.displayName,
    signatureDocumentation: s.signatureDocumentation,
  };
}

// --- Public API ---

/**
 * Returns true if the Rust SCIP decoder is available in the native addon.
 */
export function isRustScipDecoderAvailable(): boolean {
  return loadScipAddon() !== null;
}

/**
 * Rust-backed SCIP decoder implementing the ScipDecoder interface.
 *
 * Uses the napi-rs native addon to decode protobuf SCIP index files.
 * Documents are yielded one at a time via an async generator to support
 * streaming consumption of large SCIP indexes.
 */
export class RustScipDecoder implements ScipDecoder {
  private handle: NapiScipDecodeHandle | null = null;

  constructor(private readonly filePath: string) {}

  private ensureHandle(): NapiScipDecodeHandle {
    if (this.handle) return this.handle;

    const addon = loadScipAddon();
    if (!addon) {
      throw new Error(
        "Native SCIP decoder not available. " +
        "Install sdl-mcp-native or build the native addon.",
      );
    }

    this.handle = addon.scipDecodeStart(this.filePath);
    return this.handle;
  }

  async metadata(): Promise<ScipMetadata> {
    const handle = this.ensureHandle();
    const meta = handle.metadata();
    return {
      version: meta.version,
      toolName: meta.toolName,
      toolVersion: meta.toolVersion,
      toolArguments: meta.toolArguments,
      projectRoot: meta.projectRoot,
      textDocumentEncoding: meta.textDocumentEncoding,
    };
  }

  async *documents(): AsyncGenerator<ScipDocument> {
    const handle = this.ensureHandle();
    let doc = handle.nextDocument();
    while (doc !== null) {
      yield mapDocument(doc);
      doc = handle.nextDocument();
    }
  }

  async externalSymbols(): Promise<ScipExternalSymbol[]> {
    const handle = this.ensureHandle();
    return handle.externalSymbols().map(mapExternalSymbol);
  }

  close(): void {
    // Release the handle; GC will clean up the Rust side.
    this.handle = null;
  }
}
